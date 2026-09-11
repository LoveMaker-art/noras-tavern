#!/usr/bin/env python3
"""Persist a verified Nora model selection through Hermes' own config APIs."""

from __future__ import annotations

import json
import importlib.util
from datetime import datetime, timezone
import os
from pathlib import Path
import sys
from urllib.parse import urlparse


PROVIDER_KEYS = {
    "openrouter": "OPENROUTER_API_KEY",
    "deepseek": "DEEPSEEK_API_KEY",
    "anthropic": "ANTHROPIC_API_KEY",
    "openai-api": "OPENAI_API_KEY",
    "gemini": "GEMINI_API_KEY",
    "custom": "",
}


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
    clean = str(message).replace(secret, "***") if secret else str(message)
    print(json.dumps({"ok": False, "error": clean[:300]}, ensure_ascii=False))
    raise SystemExit(1)


def main() -> None:
    secret = ""
    try:
        body = json.load(sys.stdin)
        action = str(body.get("action") or "save").strip()
        provider = str(body.get("provider") or "").strip()
        model = str(body.get("model") or "").strip()
        secret = str(body.get("key") or "").strip()
        base_url = str(body.get("baseUrl") or "").strip().rstrip("/")
        expected_key = PROVIDER_KEYS.get(provider)
        if expected_key is None or body.get("keyEnv") != expected_key:
            fail("不支持这个模型服务。")
        if not model or len(model) > 240 or "\n" in model or "\r" in model:
            fail("模型名称无效。")
        if provider == "custom":
            parsed = urlparse(base_url)
            if (
                len(base_url) > 2048
                or parsed.scheme not in {"http", "https"}
                or not parsed.hostname
                or parsed.username
                or parsed.password
                or (action == "save-local" and (parsed.query or parsed.fragment))
            ):
                fail("中转地址格式不正确。")

        if action == "sync-tavern":
            root = Path(os.environ["TAVERN_DATA_ROOT"]).resolve()
            script = root / "apps/tavern-runtime/native_model_config.py"
            if not script.is_file() or not script.resolve().is_relative_to(root):
                fail("未找到酒馆模型配置程序，请先完成酒馆安装。")
            port = body.get("port")
            if not isinstance(port, int) or not 1024 <= port <= 65535:
                fail("酒馆端口无效。")
            spec = importlib.util.spec_from_file_location("nora_tavern_model", script)
            module = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(module)
            if not hasattr(module, "initialize_launcher_model"):
                fail("当前酒馆版本不支持安装时同步模型，请更新酒馆后重试。")
            marker = root / "tavern-state/launcher-model.json"
            if marker.is_symlink() or not marker.resolve().is_relative_to(root):
                fail("酒馆模型记录路径无效。")
            result = module.initialize_launcher_model(module.launcher_config(provider, model, secret, base_url),
                marker, f"http://127.0.0.1:{port}")
            print(json.dumps(result, ensure_ascii=False))
            return

        hermes_home = Path(os.environ["HERMES_HOME"]).resolve()
        agent_root = hermes_home / "hermes-agent"
        if not agent_root.is_dir():
            fail("没有找到 Nora 核心。")
        marker = local_selection_record(hermes_home) if action == "save-local" else None
        sys.path.insert(0, str(agent_root))

        from hermes_cli.web_server_config import _apply_model_assignment_sync, _normalize_main_model_assignment

        if provider == "custom":
            normalized_provider, normalized_model = provider, model
        else:
            normalized_provider, normalized_model = _normalize_main_model_assignment(provider, model)
        if action == "normalize":
            print(json.dumps({
                "ok": True,
                "provider": normalized_provider,
                "model": normalized_model,
                "keyEnv": expected_key,
                "baseUrl": base_url,
            }, ensure_ascii=False))
            return
        if action not in {"save", "save-local"}:
            fail("不支持这个配置操作。")
        if not secret or len(secret) > 8192 or "\n" in secret or "\r" in secret:
            fail("API Key 无效。")
        if action == "save-local" and any(char.isspace() for char in secret):
            fail("API Key 不能包含空白字符。", secret)

        # Keep the previous credentials usable if a later config write fails.
        paths = [hermes_home / name for name in (".env", "config.yaml", "auth.json")]
        if marker:
            paths.append(marker)
        previous = {path: path.read_bytes() if path.exists() else None for path in paths}
        try:
            if provider == "custom":
                result = _apply_model_assignment_sync(
                    scope="main", provider=normalized_provider, model=normalized_model,
                    task="", base_url=base_url, api_key=secret,
                )
            else:
                from hermes_cli.credential_lifecycle import save_provider_env_credential
                save_provider_env_credential(expected_key, secret)
                result = _apply_model_assignment_sync(scope="main", provider=normalized_provider,
                                                      model=normalized_model, task="", base_url="", api_key="")
            if marker:
                import yaml
                config = yaml.safe_load((hermes_home / "config.yaml").read_text(encoding="utf-8"))
                saved = config.get("model", {})
                if (saved.get("provider") != result.get("provider")
                        or saved.get("default") != result.get("model")):
                    raise ValueError("模型配置写入后复核失败。")
                from nora_system import save_json
                save_json(marker, {
                    "schema": 1, "provider": result["provider"], "model": result["model"],
                    "keyEnv": expected_key, "baseUrl": base_url,
                    "validation": "configuration-only",
                    "savedAt": datetime.now(timezone.utc).isoformat(),
                })
        except Exception:
            for path, contents in previous.items():
                if contents is None:
                    path.unlink(missing_ok=True)
                else:
                    temporary = path.with_name(path.name + ".nora-rollback")
                    path.parent.mkdir(parents=True, exist_ok=True)
                    temporary.write_bytes(contents)
                    os.chmod(temporary, 0o600)
                    temporary.replace(path)
            raise
        print(json.dumps({
            "ok": True,
            "provider": result.get("provider", provider),
            "model": result.get("model", model),
            "keyEnv": expected_key,
            "baseUrl": base_url,
            **({"activation": "next-session", "validation": "configuration-only"} if marker else {}),
        }, ensure_ascii=False))
    except SystemExit:
        raise
    except Exception as error:
        fail(error, secret)


if __name__ == "__main__":
    main()
