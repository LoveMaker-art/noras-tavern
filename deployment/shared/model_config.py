#!/usr/bin/env python3
"""Persist a verified Nora model selection through Hermes' own config APIs."""

from __future__ import annotations

import json
import importlib.util
import hmac
from datetime import datetime, timezone
import os
from pathlib import Path
import sys
import traceback
from urllib.parse import urlparse


TAVERN_INITIALIZATION_KEYS = {
    "openrouter": "OPENROUTER_API_KEY",
    "deepseek": "DEEPSEEK_API_KEY",
    "anthropic": "ANTHROPIC_API_KEY",
    "openai-api": "OPENAI_API_KEY",
    "gemini": "GEMINI_API_KEY",
    "custom": "",
}

LAUNCHER_CUSTOM_PROVIDER = "custom:nora-launcher"


def _models():
    try:
        from . import hermes_models
    except ImportError:
        import hermes_models
    return hermes_models


def assign_custom_model(model: str, base_url: str, secret: str) -> dict:
    models = _models()
    return models.save(models.normalize("custom", model, base_url), secret)


def verify_custom_runtime(model: str, base_url: str, secret: str) -> None:
    from hermes_cli.runtime_provider import resolve_runtime_provider
    actual = resolve_runtime_provider(target_model=model)
    if (actual.get("model") != model or not isinstance(actual.get("api_key"), str)
            or not hmac.compare_digest(actual["api_key"].encode(), secret.encode())):
        raise ValueError("实际模型服务与新配置不一致，未确认模型切换。")


def local_selection_record(home: Path) -> Path:
    """Resolve the launcher's record from this managed instance, not defaults."""
    instance = json.loads((home / "nora-instance.json").read_text(encoding="utf-8"))
    root = Path(instance["noraHome"])
    if (instance.get("schema") != 1 or not root.is_absolute()
            or root.resolve() != home.parent
            or Path(instance["hermesHome"]).resolve() != home):
        raise ValueError("当前目录不是启动器管理的 Nora 实例。")
    marker = root / "installer/model.json"
    for file in [marker, *(home / name for name in ("config.yaml", ".env", "auth.json"))]:
        if file.is_symlink() or not file.resolve().is_relative_to(root.resolve()):
            raise ValueError("模型配置路径越过当前安装目录。")
    # Validate before Hermes loads config: malformed input must not trigger its
    # automatic corrupt-config backup or overwrite a user's broken file.
    import yaml
    config = yaml.safe_load((home / "config.yaml").read_text(encoding="utf-8"))
    if not isinstance(config, dict):
        raise ValueError("现有模型配置格式无效，未修改配置。")
    return marker


def fail(message: str, secret: str = "") -> None:
    clean = _models().redact(str(message).replace(secret, "***") if secret else str(message))
    result={"ok":False,"error":clean[:300]}
    if isinstance(message,BaseException):
        # Keep the real exception chain on stderr; stdout remains the private
        # JSON response protocol. No locals or configuration body are emitted.
        trace=''.join(traceback.format_exception(type(message),message,message.__traceback__))
        sys.stderr.write(_models().redact(trace.replace(secret,'***') if secret else trace))
        try:
            from .error_diagnostics import exception_diagnostic
        except ImportError:
            from error_diagnostics import exception_diagnostic
        detail=exception_diagnostic(message,project_root=Path(__file__).resolve().parent)
        def redact(value):
            if isinstance(value,str):return _models().redact(value.replace(secret,'***') if secret else value)
            if isinstance(value,list):return [redact(item) for item in value]
            if isinstance(value,dict):return {key:redact(item) for key,item in value.items()}
            return value
        result['diagnostic']=redact(detail)
    else:
        sys.stderr.write(clean+'\n')
    print(json.dumps(result, ensure_ascii=False))
    raise SystemExit(1)


def main() -> None:
    secret = ""
    try:
        # One line also works with old callers that close stdin after JSON.
        # Authentication may subsequently receive a prompt reply on this pipe.
        body = json.loads(sys.stdin.readline())
        action = str(body.get("action") or "save").strip()
        read_actions = {"normalize", "verify-runtime", "catalog", "models", "inspect", "test"}
        if action not in read_actions:
            spec = importlib.util.spec_from_file_location('nora_model_operation_cli', Path(__file__).with_name('operation_cli.py'))
            cli = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(cli)
            nora_home = os.environ.get('NORA_TAVERN_HOME')
            target = str(Path(__file__).resolve())
            if not (getattr(sys, '_nora_operation_delegate', None) is not None or
                    any(name.startswith('NORA_OPERATION_') for name in os.environ)):
                receipt = cli.validate_receipt(nora_home)
                target = receipt['resources']['model_config.py']['path']
            cli.ensure_operation('model', argv=[target], nora_home=nora_home, stdin=json.dumps(body))
        home = Path(os.environ["HERMES_HOME"]).resolve()
        agent = home / "hermes-agent"
        if not agent.is_dir() and action not in {"sync-saved-tavern", "sync-tavern"}:
            fail("没有找到 Nora 核心。")
        sys.path.insert(0, str(agent))
        models = _models()
        secret = models.remember_secret(str(body.get("key") or "").strip())
        if action not in {"sync-saved-tavern", "sync-tavern"}:
            models.validate_config()
        if action == "catalog":
            print(json.dumps(models.catalog(), ensure_ascii=False)); return
        if action == "inspect":
            print(json.dumps({"ok": True, **models.inspect_model(body.get("credentialSha256", ""))}, ensure_ascii=False)); return
        if action == "verify-runtime":
            result = models.inspect_model()
            if not result.get("configured"):
                raise ValueError(result.get("reason") or "实际模型配置尚未就绪。")
            print(json.dumps({"ok": True, **result}, ensure_ascii=False)); return
        if action == "authenticate":
            try:
                from .hermes_model_auth import authenticate
            except ImportError:
                from hermes_model_auth import authenticate
            def emit(event):
                print(json.dumps(event, ensure_ascii=False), flush=True)
            def respond(prompt):
                line = sys.stdin.readline(65537)
                if not line or len(line) > 65536:
                    raise ValueError("登录输入已关闭或过长。")
                response = json.loads(line)
                if response.get("promptId") != prompt.get("promptId"):
                    raise ValueError("登录输入不属于当前提示。")
                return response.get("response", "")
            print(json.dumps(authenticate(str(body.get("provider") or ""), emit, respond=respond), ensure_ascii=False))
            return
        if action == "models":
            print(json.dumps(models.models(body.get("provider"), secret, body.get("baseUrl", ""), body.get("authMode", "key")), ensure_ascii=False))
            return
        if action in {"sync-saved-tavern", "sync-tavern"}:
            if action == "sync-saved-tavern":
                from launcher_bridge import read_verified_model
                from dotenv import dotenv_values
                import yaml
                problems = []
                saved = read_verified_model(Path(os.environ["NORA_TAVERN_HOME"]), home, problems, allow_pending=True)
                if not saved:
                    fail("无法继续同步：" + "；".join(problems))
                provider = saved["provider"]
                custom = provider == "custom" or provider.startswith("custom:")
                # Tavern has its own execution engine. Never export OAuth tokens,
                # external-process credentials, or a provider it cannot execute.
                if saved.get("authMode", "key") not in {"key", "none"} or (not custom and provider not in TAVERN_INITIALIZATION_KEYS):
                    print(json.dumps({"ok": True, "noraConfigured": True, "changed": False,
                        "tavernSyncUnsupported": True, "reason": "诺拉模型已保留；此服务需在酒馆中单独配置。"}, ensure_ascii=False))
                    return
                config = yaml.safe_load((home / "config.yaml").read_text(encoding="utf-8"))
                secret = config["model"].get("api_key", "") if custom else dotenv_values(home / ".env").get(saved["keyEnv"], "")
                models.remember_secret(secret)
                body = {**body, "provider": "custom" if custom else provider, "model": saved["model"],
                    "key": secret, "keyEnv": saved["keyEnv"], "baseUrl": saved["baseUrl"]}
            root = Path(os.environ["TAVERN_DATA_ROOT"]).resolve()
            script = root / "apps/tavern-runtime/native_model_config.py"
            if not script.is_file() or not script.resolve().is_relative_to(root):
                fail("未找到酒馆模型配置程序，请先完成酒馆安装。")
            port = body.get("port")
            if not isinstance(port, int) or not 1024 <= port <= 65535:
                fail("酒馆端口无效。")
            spec = importlib.util.spec_from_file_location("nora_tavern_model", script)
            module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
            provider = body.get("provider")
            if hasattr(module, "LAUNCHER_PROVIDERS") and provider not in module.LAUNCHER_PROVIDERS:
                print(json.dumps({"ok": True, "noraConfigured": True, "changed": False,
                    "tavernSyncUnsupported": True, "reason": "诺拉模型已保留；此服务需在酒馆中单独配置。"}, ensure_ascii=False)); return
            if not hasattr(module, "initialize_launcher_model"):
                fail("当前酒馆版本不支持安装时同步模型，请更新酒馆后重试。")
            marker = root / "tavern-state/launcher-model.json"
            if marker.is_symlink() or not marker.resolve().is_relative_to(root):
                fail("酒馆模型记录路径无效。")
            result = module.initialize_launcher_model(module.launcher_config(provider, body["model"], secret, body.get("baseUrl", "")),
                marker, f"http://127.0.0.1:{port}")
            print(json.dumps(result, ensure_ascii=False)); return
        # Validate local ownership BEFORE Hermes loads potentially corrupt YAML.
        marker = local_selection_record(home) if action == "save-local" else None
        mode = str(body.get("authMode") or "key")
        selection = models.normalize(body.get("provider"), body.get("model"), body.get("baseUrl", ""), mode)
        if action == "normalize":
            print(json.dumps({"ok": True, **selection}, ensure_ascii=False)); return
        if action == "test":
            print(json.dumps(models.test(selection, secret), ensure_ascii=False)); return
        if action not in {"save", "save-local"}:
            fail("不支持这个配置操作。")
        paths = [home / name for name in (".env", "config.yaml", "auth.json")]
        if marker:
            paths.append(marker)
        previous = {path: path.read_bytes() if path.exists() else None for path in paths}
        try:
            result = models.save(selection, secret)
            if selection["provider"] == "custom":
                verify_custom_runtime(selection["model"], selection["baseUrl"], secret or models.NO_AUTH_KEY)
            if marker:
                from nora_system import save_json
                save_json(marker, {"schema": 1, "hermesNative": True,
                    "provider": result["provider"], "model": result["model"], "keyEnv": result["keyEnv"],
                    "baseUrl": result["baseUrl"], "authMode": mode, "validation": "configuration-only",
                    "savedAt": datetime.now(timezone.utc).isoformat()})
        except Exception:
            for path, contents in previous.items():
                if contents is None:
                    path.unlink(missing_ok=True)
                else:
                    temporary = path.with_name(path.name + ".nora-rollback")
                    path.parent.mkdir(parents=True, exist_ok=True)
                    temporary.write_bytes(contents); os.chmod(temporary, 0o600); temporary.replace(path)
            raise
        print(json.dumps(result, ensure_ascii=False))
    except SystemExit:
        raise
    except Exception as error:
        fail(error, secret)


if __name__ == "__main__":
    main()
