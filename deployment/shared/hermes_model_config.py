"""Shared Nora model configuration; callers use the installed Hermes runtime."""
from contextlib import contextmanager
from copy import deepcopy
import csv
import base64
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import sqlite3
import subprocess
import sys
import tempfile
from types import SimpleNamespace

OWNED_CUSTOM = "custom:nora-launcher"
NO_AUTH_KEY = "nora-local-no-auth"
MODEL_SECTIONS = {"model", "providers", "custom_providers", "moa"}
COMMIT_SECTIONS = MODEL_SECTIONS | {"nora_model_profiles"}
FILES = ("config.yaml", ".env", "auth.json")
_secrets = set()


class ModelConfigurationFailure(ValueError):
    """Bounded native failure facts; never retain the SDK response body."""
    def __init__(self, message, *, code='MODEL_CANDIDATE_FAILED', http_status=None):
        super().__init__(message)
        self.code = code
        self.http_status = http_status
        self.failure_phase = 'candidate'


def remember(value):
    if isinstance(value, str) and value and value != NO_AUTH_KEY:
        _secrets.add(value)
    return value


def redact(value):
    value = str(value)
    for secret in sorted(_secrets, key=len, reverse=True):
        value = value.replace(secret, "***")
    return value



def remember_credentials(home):
    """Scrub candidate credential values before reporting a local native error."""
    def walk(value):
        if isinstance(value, dict):
            for key, item in value.items():
                if re.search(r"key|token|secret|password|authorization", str(key), re.I) and isinstance(item, str):
                    remember(item)
                else:
                    walk(item)
        elif isinstance(value, list):
            for item in value:
                walk(item)
    for name in ("config.yaml", "auth.json"):
        try:
            import yaml
            walk(yaml.safe_load((Path(home) / name).read_text(encoding="utf-8")))
        except (OSError, ValueError, yaml.YAMLError):
            pass
    try:
        for line in (Path(home) / ".env").read_text(encoding="utf-8").splitlines():
            name, separator, value = line.partition("=")
            if separator and re.search(r"key|token|secret|password", name, re.I):
                remember(value.strip().strip("\"'"))
    except (OSError, UnicodeError):
        pass

def _regular(root, file):
    if isinstance(root, tuple):
        # Configuration and operation metadata may belong to separate roots.
        # Callers supply the two already resolved instance bindings, never an
        # arbitrary parent selected from the file being inspected.
        for allowed in root:
            if Path(file).absolute().is_relative_to(Path(allowed).resolve()):
                return _regular(allowed, file)
        raise ValueError('配置路径不属于当前实例。')
    root, file = Path(root).resolve(), Path(file)
    try:
        parts = file.relative_to(root).parts
    except ValueError:
        raise ValueError("配置路径不属于当前实例。") from None
    cursor = root
    for part in parts:
        cursor /= part
        if cursor.is_symlink():
            raise ValueError("配置路径不能重定向到其他目录。")
    if file.exists() and not file.is_file():
        raise ValueError("模型配置路径不是文件，现有内容已保留。")


def _validate_config(home):
    import yaml
    home = Path(home).resolve()
    for name in FILES:
        _regular(home, home / name)
    try:
        value = yaml.safe_load((home / "config.yaml").read_text(encoding="utf-8"))
    except (yaml.YAMLError, UnicodeError):
        value = None
    if not isinstance(value, dict):
        raise ValueError("现有模型配置格式无效，未修改配置。")
    if (home / "auth.json").exists():
        try:
            credentials = json.loads((home / "auth.json").read_text(encoding="utf-8"))
        except (ValueError, UnicodeError):
            credentials = None
        if not isinstance(credentials, dict):
            raise ValueError("现有认证记录格式无效，未修改配置。")
    return value


def _config(home):
    _validate_config(home)
    from hermes_cli.config import get_config_path, load_config
    if Path(get_config_path()).resolve() != Path(home).resolve() / "config.yaml":
        raise ValueError("Hermes 配置不属于当前实例。")
    return load_config()


@contextmanager
def _writer(instance):
    root = Path(instance["noraHome"]).resolve()
    directory = root / "installer/operations"
    file = directory / ".writer.lock"
    _regular(root, file)
    if os.environ.get("NORA_OPERATION_DELEGATE_TOKEN"):
        # Electron already owns this exact writer. Authenticate its live guard
        # rather than competing with our parent for the same OS lock.
        from operation_control import require_operation
        gate = require_operation()
        gate.assert_active()
        yield directory
        gate.assert_active()
        return
    library = Path(instance["installRoot"]).resolve() / "apps/tavern-ops/updater/runtime_lock.py"
    _regular(Path(instance['installRoot']), library)
    if not library.is_file():
        raise ValueError("未找到当前实例的配置互斥组件，未修改配置。")
    spec = importlib.util.spec_from_file_location("nora_model_lock", library)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    with module.installation_lock(directory, ".writer.lock", blocking=False, descriptor=True) as stream:
        if not stream:
            raise ValueError("当前实例正在执行其他操作，请完成后重试。")
        _regular(root, file)
        opened, current = os.fstat(stream.fileno()), file.stat()
        if (opened.st_dev, opened.st_ino) != (current.st_dev, current.st_ino):
            raise ValueError("实例操作锁已变化，未修改配置。")
        yield directory


def _atomic(file, contents):
    file = Path(file)
    file.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary = tempfile.mkstemp(prefix=".nora-model-", dir=file.parent)
    try:
        with os.fdopen(descriptor, "wb") as stream:
            stream.write(contents)
            stream.flush()
        os.replace(temporary, file)
    finally:
        Path(temporary).unlink(missing_ok=True)


def _write_marker(marker, value):
    _atomic(marker, (json.dumps(value, ensure_ascii=False, indent=2) + "\n").encode())


def _private(directory):
    if os.name != "nt":
        directory.chmod(0o700)
        return
    # Restrict the candidate before copying any credential, even with a shared TEMP.
    identity = subprocess.run(["whoami", "/user", "/fo", "csv", "/nh"],
                              capture_output=True, text=True, check=True, timeout=10)
    rows = list(csv.reader(identity.stdout.splitlines()))
    sid = rows[-1][-1] if rows and rows[-1] else ""
    if not re.fullmatch(r"S-1-[0-9-]+", sid):
        raise ValueError("无法核验候选配置目录权限，未修改原配置。")
    subprocess.run(["icacls", str(directory), "/inheritance:r", "/grant:r", f"*{sid}:(OI)(CI)F"],
                   capture_output=True, check=True, timeout=10)


def _merge(original, changes):
    result = deepcopy(original) if isinstance(original, dict) else {}
    for key, value in changes.items():
        result[key] = _merge(result.get(key), value) if isinstance(value, dict) else deepcopy(value)
    return result


def _patch(cfg, patch):
    if not isinstance(patch, dict) or set(patch) - MODEL_SECTIONS:
        raise ValueError("只允许修改模型、供应商和本次指定的原生组合设置。")
    for key, value in patch.items():
        if key == "custom_providers":
            if not isinstance(value, list) or any(not isinstance(v, dict) or not v.get("name") for v in value):
                raise ValueError("命名自定义服务需要有效名称。")
            entries = deepcopy(cfg.get(key) or [])
            for entry in value:
                match = next((v for v in entries if v.get("name") == entry["name"]), None)
                if match is None:
                    entries.append(deepcopy(entry))
                else:
                    match.update(_merge(match, entry))
            cfg[key] = entries
        else:
            if not isinstance(value, dict):
                raise ValueError("原生模型设置章节必须是对象。")
            cfg[key] = _merge(cfg.get(key), value)
    return cfg


def provider_context(original_home):
    """Let native discovery read installed provider code, without copying user data."""
    import providers
    plugins = Path(original_home).resolve() / "plugins"
    providers._user_plugins_dir = lambda: plugins / "model-providers" if (plugins / "model-providers").is_dir() else None
    providers._installed_plugins_dir = lambda: plugins if plugins.is_dir() else None


def catalog(home):
    cfg = _config(home)
    from hermes_cli.models import CANONICAL_PROVIDERS, _PROVIDER_LABELS
    from hermes_cli.auth import PROVIDER_REGISTRY
    from providers import list_providers
    ids = dict.fromkeys([p.slug for p in CANONICAL_PROVIDERS] + list(PROVIDER_REGISTRY)
                        + [p.name for p in list_providers()] + ["openrouter", "custom"])
    for key in (cfg.get("providers") or {}):
        ids.setdefault(key)
    for entry in cfg.get("custom_providers") or []:
        if isinstance(entry, dict) and entry.get("name"):
            from hermes_cli.providers import custom_provider_slug
            ids.setdefault(custom_provider_slug(entry["name"]))
    rows = []
    for provider in ids:
        native = PROVIDER_REGISTRY.get(provider)
        from providers import get_provider_profile
        profile = get_provider_profile(provider)
        rows.append({"id": provider, "label": _PROVIDER_LABELS.get(provider, provider),
                     "aliases": list(profile.aliases) if profile and profile.name == provider else [],
                     "authType": native.auth_type if native else profile.auth_type if profile else "native",
                     "baseUrl": native.inference_base_url if native else profile.base_url if profile else "",
                     "nativeWizard": True})
    return {"ok": True, "providers": rows, "scope": "native-hermes"}


def inspect(home, instance=None):
    from hermes_model_state import public_model_state
    value = public_model_state(Path(instance['noraHome']) if instance else Path(home).parent, Path(home))
    if value.get('configurationStatus') == 'unknown':
        raise ValueError(value.get('validationProblem') or '模型配置暂时无法读取。')
    return {'ok': True, **value}


def _save_profiles(original, selected, result, candidate):
    """Keep model selections and native route references, never credential copies."""
    from hermes_model_state import (PROFILE_KEY, saved_model_profiles, _profile,
                                    _declared_route, _connection, _env_values, _expand, _profile_problem)
    rows = saved_model_profiles(original, strict=True)
    previous = _profile(original, original.get("model"))
    current = _profile(selected, selected.get("model"), auth_mode=result.get("authMode", "unknown"),
                       key_env=result.get("keyEnv", ""))
    if not current:
        raise ModelConfigurationFailure("没有取得可保存的模型选择。", code="MODEL_PROFILE_INVALID")
    current.pop("inlineCredential", None)  # The native account just passed its candidate request.
    env = _env_values(candidate)
    for row in rows:
        if not row.get("inlineCredential"):
            continue
        source = original.get("model") if previous and row["id"] == previous["id"] else {}
        source = source if isinstance(source, dict) else {}
        from urllib.parse import urlsplit
        host = (urlsplit(str(source.get("base_url") or "")).hostname or "").lower()
        if row["provider"] == "anthropic" and (host == "azure.com" or host.endswith(".azure.com")):
            hint = str(source.get("key_env") or source.get("api_key_env") or "")
            if not hint or not env.get(hint):
                hint = "NORA_MODEL_" + row["connectionId"].upper() + "_KEY"
                key = _expand(source.get("api_key"), env)
                if not key or "${" in key:
                    continue
                if env.get(hint) not in (None, "", key):
                    raise ModelConfigurationFailure("原生凭据引用名称已被占用。", code="MODEL_PROFILE_COLLISION")
                file = candidate / ".env"
                contents = file.read_bytes() if file.exists() else b""
                _atomic(file, contents + ("\n" + hint + "=" + json.dumps(key) + "\n").encode())
                env[hint] = key
            row["selection"]["key_env"] = hint
            row["keyEnv"] = hint
            row.pop("inlineCredential", None)
        else:
            # Ordinary built-ins ignore legacy model.api_key. Keep history
            # selectable only when an actual native credential slot exists.
            try:
                from hermes_cli.auth import PROVIDER_REGISTRY
                native = PROVIDER_REGISTRY.get(row["provider"])
                variables = native.api_key_env_vars if native else ()
            except ImportError:
                variables = ()
            native_slot = next((name for name in variables if env.get(name)), "")
            if native_slot:
                row["keyEnv"] = native_slot
                row.pop("inlineCredential", None)
    # A short-form custom save replaces the historical launcher route. Retain
    # exactly its native connection declaration before recording the old ID.
    for row in rows:
        provider = row["provider"]
        old_route = _declared_route(original, provider)
        if row["connectionId"] != _connection(original, row["selection"]):
            # An independently changed route cannot reconstruct its old account.
            # Keep that historical row unavailable instead of assigning today's
            # declaration to its old ID and corrupting the saved list.
            continue
        changed = _connection(original, row["selection"]) != _connection(selected, row["selection"])
        inline_current = (previous and row["id"] == previous["id"] and provider == "custom"
                          and isinstance(original.get("model"), dict))
        if not ((provider == OWNED_CUSTOM and changed) or inline_current):
            continue
        source = deepcopy(old_route)
        if inline_current:
            source.update({key: deepcopy(value) for key, value in original["model"].items()
                           if key not in {"provider", "default", "model"}})
        archive = "custom:nora-saved-" + row["connectionId"]
        source.update(name="Nora saved connection", nora_launcher_managed=1)
        existing = (selected.get("providers") or {}).get(archive)
        if existing is not None and existing != source:
            raise ModelConfigurationFailure("已保存连接的名称已被占用。", code="MODEL_PROFILE_COLLISION")
        selected.setdefault("providers", {})[archive] = source
        row["provider"] = archive
        row["selection"]["provider"] = archive
        # The ID describes the connection/model, not the temporary route alias.
        row["connectionId"] = _connection(selected, row["selection"])
    if current["provider"] == "custom":
        # Native structured input can keep a bare inline custom connection.
        # Give history a native route reference without changing the validated
        # active model or moving its secret into profile metadata.
        archive = "custom:nora-saved-" + current["connectionId"]
        source = {key: deepcopy(value) for key, value in selected["model"].items()
                  if key not in {"provider", "default", "model"}}
        source.update(name="Nora saved connection", nora_launcher_managed=1)
        existing = (selected.get("providers") or {}).get(archive)
        if existing is not None and existing != source:
            raise ModelConfigurationFailure("已保存连接的名称已被占用。", code="MODEL_PROFILE_COLLISION")
        selected.setdefault("providers", {})[archive] = source
        current["provider"] = archive
        current["selection"]["provider"] = archive
        current["connectionId"] = _connection(selected, current["selection"])
    by_id = {row["id"]: row for row in rows}
    by_id[current["id"]] = current
    selected[PROFILE_KEY] = {"schema": 1, "models": list(by_id.values()), "selectedId": current["id"]}
    previous_id = previous["id"] if previous and previous["id"] in by_id else ""
    if previous_id and _profile_problem(selected, by_id[previous_id], env):
        previous_id = ""
    return previous_id, current["id"]


def _apply_saved_selection(home, profile_id):
    from hermes_model_state import saved_model_profiles, _profile_problem, _env_values, _declared_route
    from hermes_cli.config import save_config
    cfg = _config(home)
    rows = saved_model_profiles(cfg, strict=True)
    profile = next((row for row in rows if row["id"] == profile_id), None)
    if profile is None:
        raise ModelConfigurationFailure("没有找到这个已保存模型。", code="MODEL_PROFILE_NOT_FOUND")
    problem = _profile_problem(cfg, profile, _env_values(Path(home)))
    if problem:
        raise ModelConfigurationFailure(problem, code="MODEL_PROFILE_UNAVAILABLE")
    selected = deepcopy(profile["selection"])
    provider = profile["provider"]
    route = _declared_route(cfg, provider)
    if provider == "custom" or provider.startswith("custom:"):
        key = str(route.get("api_key") or "")
        key_env = str(route.get("key_env") or route.get("api_key_env") or "")
        selected["api_key"] = key or ("${env:" + key_env + "}" if key_env else NO_AUTH_KEY)
    cfg["model"] = selected
    save_config(cfg)
    return profile


def switch(home, instance, profile_id, *, verify_authorized=False, tavern_sync_pending=False):
    """Revalidate and commit an ID from this instance's saved configuration."""
    if not isinstance(profile_id, str) or not re.fullmatch(r"model-[a-f0-9]{32}", profile_id):
        raise ModelConfigurationFailure("已保存模型ID无效。", code="MODEL_PROFILE_INVALID")
    return configure(home, instance, {"profile_id": profile_id, "verify_authorized": verify_authorized},
                     tavern_sync_pending=tavern_sync_pending)


def _assign_main_model(current, provider, model, base, key):
    # Hermes split its web configuration module without changing this native
    # operation. Resolve by installed API capability, never by host OS/version.
    try:
        from hermes_cli.web_server_config import _apply_main_model_assignment
    except ModuleNotFoundError as error:
        if error.name != 'hermes_cli.web_server_config':
            raise
        from hermes_cli.web_server import _apply_main_model_assignment
    return _apply_main_model_assignment(current, provider, model, base, key)


def apply_selection(home, body):
    """Apply only inside a candidate; native APIs own credential/protocol semantics."""
    cfg = _config(home)
    from hermes_cli.config import save_config, save_env_value
    from hermes_cli.models import normalize_provider, opencode_provider_family, normalize_opencode_model_id, opencode_model_api_mode
    from hermes_cli.auth import PROVIDER_REGISTRY
    from hermes_cli.credential_lifecycle import save_provider_env_credential
    patch = body.get("native_config", {})
    if not isinstance(patch, dict):
        raise ValueError("原生配置必须是对象。")
    requested = patch.get("model") or {}
    if not isinstance(requested, dict):
        raise ValueError("原生模型设置必须是对象。")
    current = cfg.get("model") if isinstance(cfg.get("model"), dict) else {}
    provider = normalize_provider(str(body.get("provider") or requested.get("provider")
                                      or (current.get("provider") if patch else "") or "").strip())
    model = str(body.get("model") or requested.get("default")
                or (current.get("default") if patch else "") or "").strip()
    if provider == "deepseek" and not model:
        model = "deepseek-v4-flash"
    if not model or len(model) > 240 or any(c in model for c in "\r\n\x00"):
        raise ValueError("请明确要使用的模型名称。")
    known = {row["id"] for row in catalog(home)["providers"]}
    from hermes_cli.providers import custom_provider_slug
    known.update(custom_provider_slug(v["name"]) for v in patch.get("custom_providers", [])
                 if isinstance(v, dict) and isinstance(v.get("name"), str))
    from providers import get_provider_profile
    profile = get_provider_profile(provider)
    native_alias = bool(profile and profile.name in known and not provider.startswith("custom:"))
    if provider not in known and provider not in (patch.get("providers") or {}) and not native_alias:
        raise ValueError("当前 Hermes 未提供所选服务，请使用其原生服务身份。")
    if "auth_mode" in body and provider != "custom":
        from providers import get_provider_profile
        profile = get_provider_profile(provider)
        native = PROVIDER_REGISTRY.get(provider)
        native_auth = native.auth_type if native else profile.auth_type if profile else "native"
        expected = {"api_key": {"key", "api_key"}, "none": {"none"}}.get(native_auth, {native_auth, "native"})
        if body["auth_mode"] not in expected:
            raise ValueError("认证方式与所选 Hermes 服务不一致，未修改配置。")
    environment = body.get("environment", {})
    if not isinstance(environment, dict):
        raise ValueError("服务环境设置必须是对象。")
    blocked = {"HOME", "USERPROFILE", "PATH", "ENV", "BASH_ENV", "SHELLOPTS", "COMSPEC", "PATHEXT", "SYSTEMROOT", "TEMP", "TMP"}
    from providers import list_providers
    provider_variables = {name for p in list_providers() for name in
                          (*p.env_vars, getattr(p, "base_url_env_var", "")) if name}
    from hermes_cli.providers import HERMES_OVERLAYS
    provider_variables.update(p.base_url_env_var for p in HERMES_OVERLAYS.values() if p.base_url_env_var)
    for name, value in environment.items():
        if (not re.fullmatch(r"[A-Z][A-Z0-9_]{0,119}", name) or name in blocked
                or (name.startswith("HERMES_") and name not in provider_variables)
                or name.startswith(("NORA_", "TAVERN_", "CLAWCHAT_", "PYTHON", "NODE_", "LD_", "DYLD_"))
                or not isinstance(value, str) or "\x00" in value or "\n" in value or "\r" in value):
            raise ValueError("环境设置包含进程控制变量或无效值，未应用。")
    # Validate the patch before writing even the disposable credential store.
    _patch(deepcopy(cfg), patch)
    for name, value in environment.items():
        save_env_value(name, value)
    key = remember(str(body.get("api_key") or "").strip())
    if key and (len(key) > 8192 or any(c.isspace() for c in key)):
        raise ValueError("API Key 格式无效。")
    base = str(body.get("base_url") or requested.get("base_url") or "").strip().rstrip("/")
    mode = body.get("auth_mode", "key")
    # Structured native input retains Hermes' exact custom identity and fields;
    # the legacy short form alone creates the existing Nora-managed named route.
    if provider == "custom" and not requested:
        from urllib.parse import urlsplit
        parsed = urlsplit(base)
        if parsed.scheme not in {"http", "https"} or not parsed.hostname or parsed.username or parsed.password or parsed.query or parsed.fragment:
            raise ValueError("自定义接口需要不含凭据或查询参数的 HTTP/HTTPS 基础地址。")
        if mode not in {"key", "none"}:
            raise ValueError("自定义接口认证方式无效。")
        key = NO_AUTH_KEY if mode == "none" else key
        if not key:
            raise ValueError("请输入 API Key，或明确选择无需认证。")
        base = base.removesuffix("/chat/completions")
        old = (cfg.get("providers") or {}).get(OWNED_CUSTOM)
        if old is not None and (not isinstance(old, dict) or old.get("nora_launcher_managed") != 1):
            raise ValueError("配置名称已被其他配置占用，未修改原配置。")
        entry = deepcopy(old or {})
        entry.update(name="Nora Launcher", base_url=base, api_key=key, default_model=model, nora_launcher_managed=1)
        if not old:
            entry.update(transport="openai_chat", api_mode="chat_completions")
        cfg.setdefault("providers", {})[OWNED_CUSTOM] = entry
        provider = OWNED_CUSTOM
    else:
        native = PROVIDER_REGISTRY.get(provider)
        if key:
            from providers import get_provider_profile
            profile = get_provider_profile(provider)
            variables = native.api_key_env_vars if native else profile.env_vars if profile else ()
            if not variables:
                raise ValueError("该服务不使用本入口的 Key 输入，请完成其原生认证流程。")
            save_provider_env_credential(variables[0], key)
            cfg = _config(home)
        # No explicit URL means native credential/region routing owns the
        # endpoint. A static catalog default can override a plan-specific URL.
    cfg["model"] = _assign_main_model(cfg.get("model"), provider, model, base, key if provider.startswith("custom:") else "")
    if opencode_provider_family(provider):
        cfg["model"]["default"] = normalize_opencode_model_id(provider, model)
        cfg["model"]["api_mode"] = opencode_model_api_mode(provider, cfg["model"]["default"])
    cfg = _patch(cfg, patch)
    save_config(cfg)
    return cfg["model"]


def run_wizard(home, region=""):
    _validate_config(home)
    from hermes_cli import main, config
    from unittest.mock import patch
    picker, save = main._pick_provider, config.save_config
    picked, saved = [], []

    def choose(*args, **kwargs):
        selected = picker(*args, **kwargs)
        if not selected or selected in {"cancel", "aux-config", "remove-custom"}:
            raise ValueError("未选择本次主模型，正式配置未改变。")
        picked.append(selected)
        return selected

    def persist(cfg, *args, **kwargs):
        result = save(cfg, *args, **kwargs)
        if picked and isinstance(cfg.get("model"), dict):
            saved.append(deepcopy(cfg["model"]))
        return result

    # Observe completion without replacing any native provider/auth flow. A
    # cancelled model picker must not validate and recommit the old selection.
    with patch.object(main, "_pick_provider", choose), patch.object(config, "save_config", persist):
        main.select_provider_and_model(args=SimpleNamespace(region=region or None, no_browser=True))
    return bool(saved)


def candidate_main(home, body, *, wizard=False, region=""):
    home = Path(home).resolve()
    if not (home / ".nora-model-candidate").is_file():
        raise ValueError("候选配置入口不能直接操作正式实例。")
    if body.get("action") == "delete":
        result = _delete_candidate(home, body["profile_id"], body.get("sessions", []))
        _write_marker(home / ".candidate-result.json", result)
        return result
    if not wizard and body.get("verify_authorized") is not True:
        raise ValueError("未授权模型验证，正式配置未改变。")
    saved_profile = None
    if wizard:
        if not sys.stdin.isatty():
            raise ValueError("原生配置需要可交互的后台 PTY，未修改原配置。")
        if not run_wizard(home, region=region):
            raise ValueError("原生配置未完成模型选择，正式配置未改变。")
        from hermes_cli.secret_prompt import masked_secret_prompt
        extra = masked_secret_prompt("本次需要的附加原生配置 JSON（不需要则留空）: ").strip()
        if extra:
            apply_selection(home, {"native_config": json.loads(extra)})
        if not body.get("verify_authorized"):
            choice = _config(home).get("model") or {}
            answer = input(f"是否验证并切换到 {choice.get('provider')} / {choice.get('default')}（可能收费）？[y/N]: ").strip().lower()
            if answer != "y":
                raise ValueError("未授权模型验证，正式配置未改变。")
    elif body.get("profile_id"):
        saved_profile = _apply_saved_selection(home, body["profile_id"])
    else:
        apply_selection(home, body)
    selected = _config(home).get("model") or {}
    provider, model = selected.get("provider"), selected.get("default")
    if not provider or not model:
        raise ValueError("未完成原生模型选择，正式配置未改变。")
    from hermes_model_probe import verify
    from hermes_cli.config import load_env
    from agent.secret_scope import set_secret_scope, reset_secret_scope
    # Hermes' runtime reads explicit key_env references from its native secret
    # scope. A fresh candidate is not launched through the CLI's dotenv setup.
    scope = set_secret_scope(load_env())
    try:
        result = verify(provider, model)
    finally:
        reset_secret_scope(scope)
    if not result.get("ok") or result.get("verified") is not True:
        status = result.get("httpStatus")
        detail = f"，HTTP {status}" if isinstance(status, int) else ""
        raise ModelConfigurationFailure("候选模型验证失败：" + str(result.get("code") or "MODEL_PROBE_FAILED") + detail,
            code=result.get('code') or 'MODEL_PROBE_FAILED', http_status=status)
    from hermes_cli.auth import PROVIDER_REGISTRY
    native = PROVIDER_REGISTRY.get(provider)
    variables = native.api_key_env_vars if native else ()
    from providers import get_provider_profile
    profile = get_provider_profile(provider)
    if not variables and profile:
        variables = profile.env_vars
    result.update(keyEnv=variables[0] if variables else (saved_profile or {}).get("keyEnv", ""),
                  authMode=native.auth_type if native else (saved_profile or {}).get("authMode", body.get("auth_mode", "native")))
    _write_marker(home / ".candidate-result.json", result)
    return result


def _run_candidate(home, body, wizard=False, region=""):
    entry = Path(__file__).resolve()
    args = [sys.executable, "-B", str(entry), "--candidate-wizard" if wizard else "--candidate-json"]
    if region:
        args += ["--region", region]
    if body.get("verify_authorized") is True:
        args.append("--verify-authorized")
    original_home = Path(os.environ["HERMES_HOME"]).resolve()
    import hermes_cli
    agent = Path(hermes_cli.__file__).resolve().parent.parent
    declared = os.environ.get('HERMES_INSTALL_DIR')
    if declared and Path(declared).resolve() != agent:
        raise ValueError('候选验证的 Hermes 程序与本实例不一致。')
    env = {**os.environ, "HERMES_HOME": str(home), "NORA_MODEL_CANDIDATE": str(home),
           "NORA_MODEL_AGENT_ROOT": str(agent), "HERMES_INSTALL_DIR": str(agent),
           "NORA_MODEL_ORIGINAL_HOME": str(original_home)}
    if os.environ.get("NORA_OPERATION_DELEGATE_TOKEN"):
        from operation_control import managed_popen
        spawn = managed_popen
    else:
        spawn = subprocess.Popen
    process = spawn(args, env=env, cwd=home, stdin=None if wizard else subprocess.PIPE,
                               stdout=None if wizard else subprocess.PIPE, stderr=None if wizard else subprocess.PIPE,
                               text=True, encoding="utf-8")
    try:
        _out, _err = process.communicate(None if wizard else json.dumps(body), timeout=900 if wizard else 180)
    except BaseException:
        process.terminate()
        try:
            process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait()
        raise
    result_file = home / ".candidate-result.json"
    _regular(home, result_file)
    if not result_file.is_file():
        raise ValueError("候选配置或调用验证未完成，原模型保持不变。")
    result = json.loads(result_file.read_text(encoding="utf-8"))
    if process.returncode or result.get("ok") is not True:
        # Native CLI streams can contain credentials; only the redacted result is public.
        raise ModelConfigurationFailure("候选模型未切换：" + str(result.get("error") or result.get("code") or "验证失败"),
            code=result.get('code') or 'MODEL_CANDIDATE_FAILED', http_status=result.get('httpStatus'))
    return result


def _snapshot(root, paths):
    result = {}
    for file in paths:
        _regular(root, file)
        if file.exists():
            stat = file.stat()
            result[file] = (file.read_bytes(), (stat.st_dev, stat.st_ino))
        else:
            result[file] = (None, None)
    return result


def _record_model_operation(record, contents, *, action, profile_id, selected_id):
    """Bind the existing checkpoint to the last fully committed desktop task.

    No new credential store: only file digests go into installer/model.json.
    The checkpoint is written last, so a lost reply can be checked without
    repeating a mutation or mistaking a partly restored configuration for it.
    """
    record.pop('lastModelOperation', None)
    operation_id = os.environ.get('NORA_OPERATION_ID', '')
    if operation_id:
        import uuid
        if str(uuid.UUID(operation_id)) != operation_id:
            raise ValueError('模型任务编号无效。')
        record['lastModelOperation'] = {'schema': 1, 'operationId': operation_id,
            'action': action, 'profileId': profile_id, 'selectedId': selected_id,
            'files': {file.name: None if value is None else hashlib.sha256(value).hexdigest()
                      for file, value in contents.items()}}


def inspect_outcome(home, root, operation_id):
    """Read-only proof of this exact task; never authenticate or call a model."""
    home, root = Path(home).resolve(), Path(root).resolve()
    unknown = {'ok': True, 'confirmed': False}
    marker = root / 'installer/model.json'
    checkpoint = _snapshot((root, home), [marker])[marker]
    try:
        saved = json.loads(checkpoint[0] or b'{}')
        record = saved.get('lastModelOperation') if isinstance(saved, dict) else None
        if not isinstance(record, dict):
            return unknown
        names = set(FILES) | ({'provider_models_cache.json'} if record.get('action') == 'delete' else set())
        if (record.get('schema') != 1 or record.get('operationId') != operation_id
                or record.get('action') not in {'configure', 'switch', 'delete'}
                or not isinstance(record.get('files'), dict) or set(record['files']) != names):
            return unknown
        before = _snapshot((root, home), [home / name for name in names] + [marker])
        if before[marker] != checkpoint:
            return unknown
        for name, digest in record['files'].items():
            value = before[home / name][0]
            if (None if value is None else hashlib.sha256(value).hexdigest()) != digest:
                return unknown
        current = inspect(home)
        if (not current.get('configured') or current.get('modelsProblem')
                or current.get('selectedId') != record.get('selectedId')):
            return unknown
        present = record.get('profileId') in {row['id'] for row in current['models']}
        if (record['action'] == 'delete' and present or record['action'] != 'delete'
                and record.get('profileId') != current['selectedId']):
            return unknown
        if _snapshot((root, home), list(before)) != before:
            return unknown
        return {'ok': True, 'confirmed': True, 'operationId': operation_id,
                'action': record['action'], 'profileId': record['profileId'], 'current': current}
    except (ValueError, TypeError, KeyError, UnicodeError):
        return unknown


def _preserve_services(original, selected):
    """Keep unrelated named services even if a native wizard rewrites a map."""
    selected = deepcopy(selected)
    for name in ("providers", "custom_providers", "moa"):
        if name in original:
            preserved = {name: deepcopy(original[name])}
            if name in selected:
                _patch(preserved, {name: selected[name]})
            selected[name] = preserved[name]
    return selected


def configure(home, instance, body, *, wizard=False, region="", tavern_sync_pending=False):
    phase = {'committing': False}
    try:
        return _configure(home, instance, body, wizard=wizard, region=region,
                          tavern_sync_pending=tavern_sync_pending, phase=phase)
    except (ModelConfigurationFailure, AssertionError):
        raise
    except Exception as cause:
        if phase['committing']:
            raise
        raise ModelConfigurationFailure('候选模型未切换：' + redact(cause)) from cause


def _configure(home, instance, body, *, wizard, region, tavern_sync_pending, phase):
    home = Path(home).resolve()
    root = Path(instance["noraHome"]).resolve()
    existing = _validate_config(home)
    from hermes_model_state import saved_model_profiles
    saved_model_profiles(existing, strict=True)
    if not wizard and body.get("verify_authorized") is not True:
        raise ValueError("需要先授权一次最小模型验证；未修改原配置。")
    if wizard and not sys.stdin.isatty():
        raise ValueError("原生配置需要可交互的后台 PTY，未修改原配置。")
    marker = root / "installer/model.json"
    paths = [home / name for name in FILES] + [marker]
    with _writer(instance) as directory:
        before = _snapshot((root, home), paths)
        import yaml
        original = yaml.safe_load(before[home / "config.yaml"][0])
        with tempfile.TemporaryDirectory(prefix=".model-candidate-", dir=directory) as temporary:
            candidate = Path(temporary).resolve()
            _private(candidate)
            for name in FILES:
                source = home / name
                if source.exists():
                    _atomic(candidate / name, source.read_bytes())
            (candidate / ".nora-model-candidate").write_text("1", encoding="ascii")
            result = _run_candidate(candidate, body, wizard=wizard, region=region)
            if not isinstance(result, dict) or result.get("ok") is not True or result.get("verified") is not True or result.get("validation") != "api-response":
                raise ValueError("没有取得所选模型的真实验证结果，原配置保持不变。")
            selected = _validate_config(candidate)
            for key, value in original.items():
                if key not in COMMIT_SECTIONS and selected.get(key) != value:
                    raise ValueError("候选配置改变了本次范围以外的设置，未提交。")
            # Native defaults may be expanded by its wizard. Do not commit those.
            selected = {**deepcopy(original), **{k: v for k, v in selected.items() if k in COMMIT_SECTIONS}}
            preserved = _preserve_services(original, selected)
            if preserved != selected:
                # Validation must use the exact provider routes to be committed;
                # never silently merge routes after a successful request.
                raise ValueError("候选配置删除了原有服务设置，未提交；请保留原服务后重试。")
            model = selected.get("model") or {}
            if result.get("provider") != model.get("provider") or result.get("model") != model.get("default"):
                raise ValueError("验证目标与候选模型选择不一致，原配置保持不变。")
            previous_id, selected_id = _save_profiles(original, selected, result, candidate)
            if previous_id == selected_id:
                previous_id = ""
            if _snapshot((root, home), paths) != before:
                raise ValueError("配置在验证期间发生变化，未覆盖其他操作的结果。")
            import yaml
            contents = {home / "config.yaml": yaml.safe_dump(selected, allow_unicode=True, sort_keys=False).encode("utf-8")}
            for name in (".env", "auth.json"):
                target = candidate / name
                _regular(candidate, target)
                contents[home / name] = target.read_bytes() if target.exists() else None
            env_values = {}
            for line in (contents[home / ".env"] or b"").decode("utf-8").splitlines():
                match = re.match(r"^\s*([A-Z0-9_]+)\s*=\s*(.*)$", line)
                if match:
                    env_values[match[1]] = match[2].strip().strip("\"'")
            key_env = str(result.get("keyEnv") or "")
            if str(model.get("provider")).startswith("custom"):
                from hermes_model_state import _credential
                _status, key = _credential({"config": selected, "model": model, "env": env_values,
                                            "marker": {"schema": 1, "provider": model["provider"],
                                                       "model": model["default"], "keyEnv": key_env}})
            else:
                key = env_values.get(key_env, "")
            key = re.sub(r"\$\{(?:env:)?([A-Za-z_][A-Za-z0-9_]*)\}",
                         lambda match: env_values.get(match[1], match[0]), key)
            if "${" in key:
                key = ""
            record = {"schema": 1, "provider": model["provider"], "model": model["default"],
                      "keyEnv": key_env, "baseUrl": result.get("baseUrl", ""), "authMode": result.get("authMode", "native"),
                      "validation": "api-response", "tavernSyncPending": bool(tavern_sync_pending),
                      "selectedId": selected_id, "previousSelectedId": previous_id if previous_id != selected_id else ""}
            if key:
                record["credentialSha256"] = hashlib.sha256(key.encode()).hexdigest()
            _record_model_operation(record, contents, action='switch' if body.get('profile_id') else 'configure',
                                    profile_id=selected_id, selected_id=selected_id)
            phase['committing'] = True
            try:
                for file, value in contents.items():
                    if value is None:
                        file.unlink(missing_ok=True)
                    else:
                        _atomic(file, value)
                _write_marker(marker, record)
            except BaseException as cause:
                failures = []
                for file, (value, _identity) in before.items():
                    try:
                        if value is None:
                            file.unlink(missing_ok=True)
                        else:
                            _atomic(file, value)
                    except (OSError, ValueError):
                        failures.append(file.name)
                if failures or any(_snapshot((root, home), [file])[file][0] != value for file, (value, _) in before.items()):
                    raise RuntimeError("配置提交失败，原配置未能完整恢复，请保留日志并重新查询。") from cause
                restored = ModelConfigurationFailure('配置未完成，原模型配置已恢复。', code='MODEL_CONFIG_RESTORED')
                restored.failure_phase = 'restored'
                raise restored from cause
            return {**result, "activation": "next-session", "launcherRequired": False,
                    "previousSelectedId": previous_id, "selectedId": selected_id,
                    "legacyModelRecordHasKey": bool(key), "candidateCleanedOnReturn": True}


def _model_bindings(value, provider=""):
    """Only configuration bindings, never chat messages or historical usage."""
    if isinstance(value, dict):
        provider = value.get("provider") or provider
        model = value.get("model") or value.get("default")
        if isinstance(model, str) and model:
            yield provider, model
        for item in value.values():
            yield from _model_bindings(item, provider)
    elif isinstance(value, list):
        for item in value:
            yield from _model_bindings(item, provider)


def _provider_references(value):
    if isinstance(value, dict):
        if isinstance(value.get("provider"), str):
            yield value["provider"]
        for item in value.values():
            yield from _provider_references(item)
    elif isinstance(value, list):
        for item in value:
            yield from _provider_references(item)


def _configuration_strings(value):
    if isinstance(value, str):
        yield value
    elif isinstance(value, dict):
        for item in value.values():
            yield from _configuration_strings(item)
    elif isinstance(value, list):
        for item in value:
            yield from _configuration_strings(item)


def _session_bindings(home):
    """Read Hermes' routing index with its DB-first, legacy-fill semantics."""
    entries = {}
    database, legacy = home / "state.db", home / "sessions/sessions.json"
    try:
        _regular(home, database)
        _regular(home, legacy)
        if database.exists():
            with sqlite3.connect(database.as_uri() + "?mode=ro", uri=True, timeout=2) as db:
                if db.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='gateway_routing'").fetchone():
                    for scope, key, raw in db.execute("SELECT scope, session_key, entry_json FROM gateway_routing"):
                        item = json.loads(raw)
                        if not isinstance(item, dict):
                            raise ValueError()
                        entries[(scope, key)] = item
        if legacy.exists():
            saved = json.loads(legacy.read_text(encoding="utf-8"))
            if not isinstance(saved, dict):
                raise ValueError()
            scope = str((home / "sessions").resolve())
            for key, item in saved.items():
                if key.startswith("_") or (scope, key) in entries:
                    continue
                if not isinstance(item, dict):
                    raise ValueError()
                entries[(scope, key)] = item
        overrides = [item.get("model_override") or {} for item in entries.values()]
        if any(not isinstance(item, dict) for item in overrides):
            raise ValueError()
        return [{key: value for key, value in item.items() if key in {"provider", "model", "base_url"}}
                for item in overrides]
    except (OSError, ValueError, sqlite3.Error):
        raise ModelConfigurationFailure("无法核验会话的模型引用，未删除配置；请先检查会话记录。", code='MODEL_DELETE_REFUSED') from None


def _delete_plan(config, profile_id, sessions=()):
    from hermes_model_state import PROFILE_KEY, _profile, _declared_route, _custom_slug, saved_model_profiles
    rows = saved_model_profiles(config, strict=True)
    target = next((row for row in rows if row["id"] == profile_id), None)
    if not target:
        raise ModelConfigurationFailure("该模型配置已变化，请重新读取列表。", code='MODEL_DELETE_REFUSED')
    current = _profile(config, config.get("model"))
    if current and current["id"] == profile_id:
        raise ModelConfigurationFailure("请先切换到其他模型，再删除当前默认模型。", code='MODEL_DELETE_REFUSED')
    aliases = {target["provider"]}
    route = _declared_route(config, target["provider"])
    for key, item in (config.get("providers") or {}).items():
        if item is route:
            aliases.update((key, _custom_slug(key)))
    other = {key: value for key, value in config.items() if key not in {PROFILE_KEY, "providers", "custom_providers", "model"}}
    simple_aliases = (config.get("model") or {}).get("aliases") or {}
    normalized_aliases = []
    for value in simple_aliases.values():
        if isinstance(value, dict):
            normalized_aliases.append({"provider": value.get("provider") or (current or {}).get("provider"), **value})
        elif isinstance(value, str):
            provider, separator, model = value.partition("/")
            normalized_aliases.append({"provider": provider if separator else (current or {}).get("provider"),
                                       "model": model if separator else value})
    other["main_model_aliases"] = normalized_aliases
    for source, value in (("会话", sessions), ("回退或其他用途", other)):
        for provider, model in _model_bindings(value):
            if model == target["model"] and (not provider or provider == "auto" or provider in aliases):
                raise ModelConfigurationFailure(f"{source}仍在使用该模型，请先更换对应模型，再删除。", code='MODEL_DELETE_REFUSED')
    # String aliases are executable model bindings as well.
    if target["model"] in (config.get("model_aliases") or {}).values():
        raise ModelConfigurationFailure("模型别名仍在使用该模型，请先更换别名，再删除。", code='MODEL_DELETE_REFUSED')
    selected = deepcopy(config)
    remaining = [row for row in rows if row["id"] != profile_id]
    selected[PROFILE_KEY] = {"schema": 1, "models": remaining,
                             "selectedId": current["id"] if current else ""}
    # Match by native route, not display name. A stale metadata row must never
    # delete a connection that was subsequently changed outside the launcher.
    from hermes_model_state import _connection
    intact = target["connectionId"] == _connection(config, target["selection"])
    if intact and route:
        entry = _declared_route(selected, target["provider"])
        for key in ("default_model", "model", "default"):
            if entry.get(key) == target["model"]:
                entry.pop(key, None)
    bound_providers = set(_provider_references([other, sessions]))
    used = any(row["provider"] in aliases or row["connectionId"] == target["connectionId"] for row in remaining)
    used = used or bool(aliases & bound_providers) or "auto" in bound_providers
    if intact and not used and route:
        selected["providers"] = {key: value for key, value in (selected.get("providers") or {}).items()
                                 if (config.get("providers") or {}).get(key) is not route}
        if "custom_providers" in selected:
            selected["custom_providers"] = [value for index, value in enumerate(selected["custom_providers"])
                                            if config["custom_providers"][index] is not route]
    if profile_id in {row["id"] for row in saved_model_profiles(selected, strict=True)}:
        raise ValueError("仍有原生模型声明引用该选择，未删除配置。")
    return selected, target, intact and not used


def _delete_candidate(home, profile_id, sessions=()):
    """Clean only the disposable home; native credential lifecycle owns cleanup."""
    import yaml
    from hermes_model_state import _env_values, _declared_route, saved_model_profiles
    original = _validate_config(home)
    selected, target, exclusive = _delete_plan(original, profile_id, sessions)
    provider = target["provider"]
    from hermes_cli.auth import PROVIDER_REGISTRY, clear_provider_auth
    from providers import get_provider_profile
    from hermes_cli.credential_lifecycle import remove_provider_env_credential
    from hermes_cli.models import clear_provider_models_cache

    def variables(name):
        native = PROVIDER_REGISTRY.get(name)
        profile = get_provider_profile(name)
        return set(native.api_key_env_vars if native else profile.env_vars if profile else ())

    route = _declared_route(original, provider)
    names = variables(provider) | {target.get("keyEnv"), route.get("key_env"), route.get("api_key_env")}
    names.update(re.findall(r"\$\{(?:env:)?([A-Za-z_][A-Za-z0-9_]*)\}", json.dumps(route)))
    names.discard(None)
    names.discard("")
    protected = set()
    for row in saved_model_profiles(selected):
        protected.update(variables(row["provider"]))
        protected.add(row.get("keyEnv"))
    for name in _provider_references(selected):
        protected.update(variables(name))
    for name in _provider_references(sessions):
        protected.update(variables(name))
    auth = json.loads((home / "auth.json").read_text()) if (home / "auth.json").exists() else {}
    if any(section in auth and not isinstance(auth[section], dict) for section in ("providers", "credential_pool")):
        raise ValueError("原生认证记录格式无效，未删除配置。")
    foreign_auth = {key: {name: item for name, item in value.items() if name != provider}
                    for key, value in auth.items() if key in {"providers", "credential_pool"} and isinstance(value, dict)}
    retained_values = list(_configuration_strings([selected, foreign_auth]))
    values = _env_values(home)
    _atomic(home / "config.yaml", yaml.safe_dump(selected, allow_unicode=True, sort_keys=False).encode())
    if exclusive:
        for name in sorted(names):
            value = values.get(name)
            # Shared environment references or the same inline credential in
            # another native use must survive the native mirror scrubber.
            if name in protected or any(name in item or value and value in item for item in retained_values):
                continue
            remove_provider_env_credential(name)
        clear_provider_auth(provider)
        clear_provider_models_cache(provider)
        cache_path = home / 'provider_models_cache.json'
        if cache_path.exists():
            from hermes_cli.models import _normalized_cache_slug
            if _normalized_cache_slug(provider) in json.loads(cache_path.read_text(encoding='utf-8')):
                raise ValueError("原生模型缓存清理未完成，未提交删除。")
    after = _validate_config(home)
    if profile_id in {row["id"] for row in saved_model_profiles(after, strict=True)} or after.get("model") != original.get("model"):
        raise ValueError("删除结果与原默认模型不一致，未提交。")
    return {"ok": True, "deletedId": profile_id, "cleanup": "exclusive" if exclusive else "shared-retained"}


class _DeleteUnconfirmed(RuntimeError):
    """A deletion touched files but could not prove complete restoration."""
    code = 'MODEL_DELETE_RECOVERY_REQUIRED'


def delete(home, instance, profile_id):
    try:
        return _delete(home, instance, profile_id)
    except (ModelConfigurationFailure, _DeleteUnconfirmed):
        raise
    except Exception as cause:
        # All writes below are inside the commit/restore block. Errors before
        # that block are safe to correct and retry without a recovery lock.
        raise ModelConfigurationFailure("未删除配置：" + redact(cause), code='MODEL_DELETE_REFUSED') from cause


def _delete(home, instance, profile_id):
    """Delete one native saved model, with no inference, service restart or UI hiding."""
    home, root = Path(home).resolve(), Path(instance["noraHome"]).resolve()
    _validate_config(home)
    marker = root / "installer/model.json"
    names = (*FILES, "provider_models_cache.json")
    paths = [home / name for name in names] + [marker]
    with _writer(instance) as directory:
        before = _snapshot((root, home), paths)
        import yaml
        original = yaml.safe_load(before[home / "config.yaml"][0])
        sessions = _session_bindings(home)
        _delete_plan(original, profile_id, sessions)
        cache = before[home / "provider_models_cache.json"][0]
        if cache is not None:
            try:
                if not isinstance(json.loads(cache), dict):
                    raise ValueError()
            except (ValueError, UnicodeError):
                raise ModelConfigurationFailure("模型缓存格式无效，未删除配置。", code='MODEL_DELETE_REFUSED') from None
        with tempfile.TemporaryDirectory(prefix=".model-delete-", dir=directory) as temporary:
            candidate = Path(temporary).resolve()
            _private(candidate)
            for name in names:
                if before[home / name][0] is not None:
                    _atomic(candidate / name, before[home / name][0])
            (candidate / ".nora-model-candidate").write_text("1", encoding="ascii")
            result = _run_candidate(candidate, {"action": "delete", "profile_id": profile_id, "sessions": sessions})
            if not result.get("ok") or result.get("deletedId") != profile_id:
                raise ValueError("模型删除结果尚未确认，原配置已保留。")
            fresh_sessions = _session_bindings(home)
            _delete_plan(original, profile_id, fresh_sessions)
            if fresh_sessions != sessions:
                raise ModelConfigurationFailure("删除期间会话模型配置发生变化，请重新查询后再删除。", code='MODEL_DELETE_REFUSED')
            if _snapshot((root, home), paths) != before:
                raise ModelConfigurationFailure("删除期间配置发生变化，未覆盖其他操作的结果。", code='MODEL_DELETE_REFUSED')
            for name in names:
                _regular(candidate, candidate / name)
            contents = {home / name: (candidate / name).read_bytes() if (candidate / name).exists() else None for name in names}
            record = json.loads(before[marker][0]) if before[marker][0] else {}
            if record.get("previousSelectedId") == profile_id:
                record["previousSelectedId"] = ""
            _record_model_operation(record, contents, action='delete', profile_id=profile_id,
                                    selected_id=inspect(home).get('selectedId'))
            contents[marker] = (json.dumps(record, ensure_ascii=False, indent=2) + "\n").encode()
            try:
                for file, value in contents.items():
                    _regular((root, home), file)
                    if value is None:
                        file.unlink(missing_ok=True)
                    else:
                        _atomic(file, value)
                state = inspect(home)
                if profile_id in {row["id"] for row in state["models"]}:
                    raise ValueError("模型删除结果尚未确认。")
            except BaseException as cause:
                failures = []
                for file, (value, _) in before.items():
                    try:
                        _regular((root, home), file)
                        if value is None:
                            file.unlink(missing_ok=True)
                        else:
                            _atomic(file, value)
                    except (OSError, ValueError):
                        failures.append(file.name)
                try:
                    if failures or any(_snapshot((root, home), [file])[file][0] != value for file, (value, _) in before.items()):
                        raise OSError()
                except (OSError, ValueError):
                    recovery = Path(tempfile.mkdtemp(prefix='.model-delete-recovery-', dir=directory))
                    try:
                        _private(recovery)
                        nested = all(file.is_relative_to(root) for file in before)
                        originals = {'schema': 1 if nested else 2, 'files': {
                            str(file.relative_to(root)) if nested else str(file):
                                None if value is None else base64.b64encode(value).decode('ascii')
                            for file, (value, _) in before.items()}}
                        if not nested:originals['roots'] = {'owner': str(root), 'hermes': str(home)}
                        _write_marker(recovery / 'originals.json', originals)
                    except Exception:
                        raise _DeleteUnconfirmed("删除失败，配置未完整恢复且恢复副本未写成，请保留日志。") from None
                    raise _DeleteUnconfirmed("删除失败，配置恢复尚未确认。原配置副本已保留：" + str(recovery)) from None
                restored = ModelConfigurationFailure("删除未完成，原模型配置已恢复，请重新查询后重试。", code='MODEL_DELETE_RESTORED')
                restored.failure_phase = 'restored'
                raise restored from cause
            return {**result, "current": state}


def _candidate_worker():
    """Private child entry. Public callers always go through configure()."""
    import argparse
    parser = argparse.ArgumentParser()
    modes = parser.add_mutually_exclusive_group(required=True)
    modes.add_argument('--candidate-json', action='store_true')
    modes.add_argument('--candidate-wizard', action='store_true')
    parser.add_argument('--region', default='')
    parser.add_argument('--verify-authorized', action='store_true')
    args = parser.parse_args()
    raw = os.environ.get('HERMES_HOME', '')
    home = Path(raw).resolve()
    if (not Path(raw).is_absolute() or os.environ.get('NORA_MODEL_CANDIDATE') != str(home)
            or not (home / '.nora-model-candidate').is_file()):
        raise ValueError('候选入口不能直接修改正式实例。')
    agent = Path(os.environ.get('NORA_MODEL_AGENT_ROOT', ''))
    if not agent.is_absolute() or not agent.is_dir():
        raise ValueError('未找到当前Hermes程序。')
    sys.path.insert(0, str(agent))
    provider_context(os.environ['NORA_MODEL_ORIGINAL_HOME'])
    if args.candidate_wizard:
        body = {'verify_authorized': args.verify_authorized}
    else:
        raw = sys.stdin.readline(131073)
        if len(raw) > 131072:
            raise ValueError('配置输入过长。')
        body = json.loads(raw)
        if not isinstance(body, dict):
            raise ValueError('配置输入必须是对象。')
    remember(body.get('api_key'))
    try:
        candidate_main(home, body, wizard=args.candidate_wizard, region=args.region)
    except Exception as error:
        remember_credentials(home)
        status = getattr(error, 'http_status', None)
        _write_marker(home / '.candidate-result.json', {'ok': False, 'verified': False,
            'code': getattr(error, 'code', 'MODEL_CANDIDATE_FAILED'), 'error': redact(error)[:400],
            **({'httpStatus': status} if isinstance(status, int) and 100 <= status <= 599 else {})})
        raise SystemExit(1) from None


if __name__ == '__main__':
    try:
        _candidate_worker()
    except Exception as error:
        print(json.dumps({'ok': False, 'error': redact(error)[:400]}, ensure_ascii=False))
        raise SystemExit(1)
