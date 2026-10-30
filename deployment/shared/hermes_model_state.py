"""Read the current instance's model selection without activating Hermes.

Hermes' load_config_readonly still initializes its home. Status polling must not
do that, resolve credentials, refresh OAuth, or start an external auth client.
The YAML is the selection; the launcher marker is only past validation evidence.
"""

from __future__ import annotations

import hashlib
import json
from copy import deepcopy
from pathlib import Path
import re
from urllib.parse import urlsplit, urlunsplit

PROFILE_KEY = "nora_model_profiles"


def _custom_slug(value):
    normalized = _text(value).lower().replace(" ", "-")
    return normalized if normalized.startswith("custom:") else "custom:" + normalized


def _declared_route(config, provider):
    providers = config.get("providers")
    if isinstance(providers, dict) and isinstance(providers.get(provider), dict):
        return providers[provider]
    for key, entry in providers.items() if isinstance(providers, dict) else ():
        if isinstance(entry, dict) and provider == _custom_slug(key):
            return entry
    entries = config.get("custom_providers")
    for entry in entries if isinstance(entries, list) else ():
        if not isinstance(entry, dict):
            continue
        identity = _custom_slug(entry.get("provider_key") or entry.get("name"))
        if provider == identity:
            return entry
    return {}


def _connection_endpoint(config, selection):
    route = _declared_route(config, _text(selection.get("provider")))
    return _text(route.get("api") or route.get("url") or route.get("base_url")
                 or selection.get("base_url") or selection.get("api_base")).rstrip("/")


def _safe_selection(value):
    """Keep model options, but credentials and headers stay in native stores."""
    if isinstance(value, dict):
        return {key: (item if "${" in _text(item) else _endpoint(item))
                if key in {"base_url", "api_base"} else _safe_selection(item)
                for key, item in value.items()
                if isinstance(key, str) and (key in {"key_env", "api_key_env"}
                    or not (key.lower() in {"api", "key", "token", "credential", "credentials"}
                            or re.search(r"api.?key|access.?token|refresh.?token|secret|password|authorization|headers|_token$", key, re.I)))}
    if isinstance(value, list):
        return [_safe_selection(item) for item in value]
    return deepcopy(value)


def _connection(config, selection):
    provider = _text(selection.get("provider"))
    route = _declared_route(config, provider)
    custom = provider == "custom" or provider.startswith("custom:") or bool(route)
    managed = provider == "custom" or route.get("nora_launcher_managed") == 1
    identity_provider = provider
    for key, entry in (config.get("providers") or {}).items() if isinstance(config.get("providers"), dict) else ():
        if route and entry is route:
            identity_provider = _custom_slug(key)
            break
    # Named custom runtimes use their declared connection, even when model
    # retains a stale endpoint/key from an earlier selection.
    source = route if route else selection
    endpoint = _connection_endpoint(config, selection)
    key_ref = _text(source.get("key_env") or source.get("api_key_env"))
    key = _text(source.get("api_key"))
    auth = key_ref or (hashlib.sha256(key.encode()).hexdigest() if custom and key else "native")
    protocol = _text(source.get("api_mode") or source.get("transport"))
    protocol = {"openai_chat": "chat_completions", "anthropic": "anthropic_messages"}.get(protocol, protocol)
    headers = {key: source[key] for key in ("extra_headers", "headers", "request_headers") if source.get(key)}
    identity = ["nora-custom" if managed else identity_provider, endpoint, protocol, auth if custom else "native", headers]
    return hashlib.sha256(json.dumps(identity, ensure_ascii=False, sort_keys=True).encode()).hexdigest()[:24]


def _profile(config, selection, *, auth_mode="unknown", key_env=""):
    if not isinstance(selection, dict):
        return None
    selection = deepcopy(selection)
    default = selection.get("default")
    if isinstance(default, dict):
        if not selection.get("provider") or selection.get("provider") == "auto":
            selection["provider"] = default.get("provider")
        selection["default"] = default.get("model") or default.get("default")
    provider, model = _text(selection.get("provider")), _text(selection.get("default") or selection.get("model"))
    if not provider or provider == "auto" or not model or "${" in provider + model:
        return None
    connection = _connection(config, selection)
    identity = hashlib.sha256(json.dumps([connection, model], ensure_ascii=False).encode()).hexdigest()[:32]
    safe = _safe_selection(selection)
    safe.update(provider=provider, default=model)
    route = _declared_route(config, provider)
    if _auth_mode(auth_mode) == "unknown":
        credential = _text((route if route else selection).get("api_key"))
        if credential == "nora-local-no-auth":
            auth_mode = "none"
        elif credential or key_env or route.get("key_env") or route.get("api_key_env"):
            auth_mode = "key"
    result = {"id": "model-" + identity, "provider": provider, "model": model,
            "connectionId": connection, "selection": safe,
            "authMode": _auth_mode(auth_mode),
            "keyEnv": _text(route.get("key_env") or route.get("api_key_env")
                            or (selection.get("key_env") or selection.get("api_key_env") if not route else "") or key_env)}
    if not (provider == "custom" or provider.startswith("custom:") or route) and _text(selection.get("api_key")):
        result["inlineCredential"] = True
    return result


def saved_model_profiles(config, *, strict=False):
    """Read explicit saved/default models only; credentials alone are not rows."""
    raw = config.get(PROFILE_KEY)
    records = []
    if raw is not None:
        valid = (isinstance(raw, dict) and type(raw.get("schema")) is int and raw["schema"] == 1
                 and isinstance(raw.get("models"), list))
        if valid:
            for row in raw["models"]:
                if (not isinstance(row, dict) or not re.fullmatch(r"model-[a-f0-9]{32}", _text(row.get("id")))
                        or set(row) - {"id", "provider", "model", "connectionId", "selection", "authMode", "keyEnv", "inlineCredential"}
                        or not re.fullmatch(r"[a-f0-9]{24}", _text(row.get("connectionId")))
                        or not _text(row.get("provider")) or not _text(row.get("model"))
                        or not isinstance(row.get("selection"), dict)
                        or row["selection"] != _safe_selection(row["selection"])
                        or row["selection"].get("provider") != row["provider"]
                        or row["selection"].get("default") != row["model"]):
                    valid = False
                    break
                expected = "model-" + hashlib.sha256(json.dumps([row["connectionId"], row["model"]],
                                                                 ensure_ascii=False).encode()).hexdigest()[:32]
                if row["id"] != expected or row["id"] in {item["id"] for item in records}:
                    valid = False
                    break
                records.append(deepcopy(row))
        if not valid:
            if strict:
                raise ValueError("已保存模型列表格式无效，原配置已保留。")
            records = []
    by_id = {row["id"]: row for row in records}
    providers = config.get("providers")
    declarations = list(providers.items()) if isinstance(providers, dict) else []
    entries = config.get("custom_providers")
    for entry in entries if isinstance(entries, list) else ():
        if isinstance(entry, dict):
            declarations.append((_custom_slug(entry.get("provider_key") or entry.get("name")), entry))
    for provider, entry in declarations:
        if not isinstance(entry, dict):
            continue
        model = entry.get("default_model") or entry.get("model") or entry.get("default")
        if isinstance(model, str) and model.strip():
            selected = {"provider": provider, "default": model.strip()}
            for field in ("base_url", "api_mode", "key_env", "api_key_env"):
                if entry.get(field):
                    selected[field] = entry[field]
            row = _profile(config, selected, auth_mode=entry.get("auth_mode", "unknown"))
            if row:
                by_id.setdefault(row["id"], row)
    current = _profile(config, config.get("model"))
    if current:
        by_id.setdefault(current["id"], current)
    return list(by_id.values())


def _profile_problem(config, profile, env):
    selected = profile["selection"]
    route = _declared_route(config, profile["provider"])
    # Old bare/inline custom selections keep their credential in model itself.
    # The public selection intentionally omits it; compare against that actual
    # native source only while it is still this exact current saved identity.
    current = config.get('model')
    if not route and isinstance(current, dict):
        actual = _profile(config, current)
        if actual and actual['id'] == profile['id']:
            selected = current
    if profile.get("connectionId") != _connection(config, selected):
        return "已保存的连接已改变，需要重新配置。"
    provider = profile["provider"]
    if profile.get("inlineCredential"):
        return "旧的内联密钥未构成该原生服务的可用认证，请重新配置。"
    if provider.startswith("custom:") and not route and not selected.get('api_key'):
        return "已保存的自定义连接不存在。"
    key_env = _text(route.get("key_env") or route.get("api_key_env")) if route else _text(
        profile.get("keyEnv") or selected.get("key_env") or selected.get("api_key_env"))
    if key_env and not _text(env.get(key_env)):
        return "未找到已保存连接的凭据。"
    source = route or selected
    inline = _text(source.get("api_key"))
    if "${" in inline and "${" in _expand(inline, env):
        return "未找到已保存连接的凭据。"
    if (provider == "custom" or provider.startswith("custom:")) and not (
            source.get("api_key") or key_env or profile.get("authMode") == "none"):
        return "未找到已保存连接的凭据。"
    return ""


def _public_profiles(snapshot):
    config = snapshot["config"]
    problem = ""
    try:
        rows = saved_model_profiles(config, strict=True)
    except ValueError as error:
        rows, problem = saved_model_profiles({key: value for key, value in config.items() if key != PROFILE_KEY}), str(error)
    current = _profile(config, snapshot["model"])
    selected_id = current["id"] if current else ""
    public = []
    for row in rows:
        selection = row["selection"]
        endpoint = _endpoint(_expand(_connection_endpoint(config, selection), snapshot["env"]))
        issue = _profile_problem(config, row, snapshot["env"])
        public.append({"id": row["id"], "provider": row["provider"], "model": row["model"],
                       "connectionLabel": endpoint or row["provider"], "baseUrl": endpoint,
                       "authMode": _auth_mode(row.get("authMode")), "selected": row["id"] == selected_id,
                       "available": not bool(issue), **({"problem": issue} if issue else {})})
    connections = {}
    for row, value in zip(rows, public):
        connections.setdefault(value["connectionLabel"], set()).add(row.get("connectionId"))
    for value in public:
        if len(connections[value["connectionLabel"]]) > 1:
            # This is a model-profile ID, never a credential digest or suffix.
            value["connectionLabel"] += " · " + value["id"][-6:]
    marker = snapshot["marker"]
    previous = _text(marker.get("previousSelectedId"))
    if (marker.get("selectedId") != selected_id or not _marker_matches(snapshot)
            or previous == selected_id or previous not in {row["id"] for row in rows}):
        previous = ""
    return {"models": public, "selectedId": selected_id, "previousSelectedId": previous,
            **({"modelsProblem": problem} if problem else {})}


def _text(value) -> str:
    return value.strip() if isinstance(value, str) else ""


def _auth_mode(value) -> str:
    # These are public authentication kinds, never arbitrary credential text.
    modes = {"key", "api_key", "none", "native", "unknown", "oauth", "oauth_device_code",
             "oauth_external", "oauth_minimax", "external_process", "aws_sdk", "vertex",
             "virtual", "entra_id", "service_account", "adc", "azure_cli"}
    mode = _text(value)
    return mode if mode in modes else "unknown"


def _endpoint(value) -> str:
    """Never publish URL userinfo, query parameters, or fragments."""
    try:
        parsed = urlsplit(_text(value))
        if not parsed.scheme or not parsed.netloc:
            return ""
        return urlunsplit((parsed.scheme, parsed.netloc.rsplit("@", 1)[-1], parsed.path, "", "")).rstrip("/")
    except ValueError:
        return ""


def _env_values(home: Path) -> dict:
    try:
        from dotenv import dotenv_values
        # Interpolation through the launcher process could borrow another
        # instance's credentials. Expand only explicit references below.
        return dict(dotenv_values(home / ".env", interpolate=False))
    except ImportError:
        values = {}
        if (home / ".env").is_file():
            for line in (home / ".env").read_text(encoding="utf-8").splitlines():
                match = re.match(r"^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$", line)
                if match:
                    values[match[1]] = match[2].strip().strip("\"'")
        return values


def _expand(value, values: dict) -> str:
    return re.sub(r"\$\{(?:env:)?([A-Za-z_][A-Za-z0-9_]*)\}",
                  lambda match: _text(values.get(match[1])) or match[0], _text(value))


def _snapshot(nora_home: Path, hermes_home: Path) -> dict:
    result = {"config": {}, "model": {}, "env": {}, "marker": {}, "problem": ""}
    try:
        import yaml
        if not (hermes_home / "config.yaml").is_file():
            result["problem"] = "未找到模型配置"
            return result
        config = yaml.safe_load((hermes_home / "config.yaml").read_text(encoding="utf-8"))
        if not isinstance(config, dict):
            result["problem"] = "无法读取模型配置"
            return result
        result["config"] = config
        result["env"] = _env_values(hermes_home)
        selected = config.get("model")
        if not isinstance(selected, dict):
            result["problem"] = "缺少模型配置"
            return result
        selected = dict(selected)
        default = selected.get("default") or selected.get("model") or selected.get("name")
        if isinstance(default, dict):
            if not selected.get("provider") or selected.get("provider") == "auto":
                selected["provider"] = default.get("provider")
            default = default.get("model") or default.get("default")
        selected["default"] = default
        result["model"] = selected
    except (ImportError, OSError, ValueError, UnicodeError):
        result["problem"] = "无法读取模型配置"
        return result
    except yaml.YAMLError:
        result["problem"] = "无法读取模型配置"
        return result
    try:
        marker = json.loads((nora_home / "installer/model.json").read_text(encoding="utf-8"))
        if isinstance(marker, dict):
            result["marker"] = marker
    except (OSError, ValueError, UnicodeError):
        pass
    return result


def _identity(snapshot: dict) -> tuple[str, str, str]:
    selected, env = snapshot["model"], snapshot["env"]
    return (_expand(selected.get("provider"), env), _expand(selected.get("default"), env),
            _expand(_connection_endpoint(snapshot["config"], selected), env).rstrip("/"))


def _credential(snapshot: dict) -> tuple[str, str]:
    """Read a declared local credential; never run a dynamic credential source."""
    selected, env, marker = snapshot["model"], snapshot["env"], snapshot["marker"]
    provider = _text(selected.get("provider"))
    entry = _declared_route(snapshot["config"], provider)
    source = entry if entry else selected
    inline = _text(source.get("api_key"))
    key_env = _text(source.get("key_env") or source.get("api_key_env"))
    # Legacy markers declare their credential slot, but never select a provider.
    if not entry and not key_env and _marker_matches(snapshot):
        key_env = _text(marker.get("keyEnv"))
    if inline:
        credential = _expand(inline, env)
        return ("unknown", "") if "${" in credential else ("present", credential)
    if key_env and re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", key_env):
        value = _text(env.get(key_env))
        return ("present", value) if value else ("missing", "")
    return "unknown", ""


def _marker_matches(snapshot: dict) -> bool:
    marker = snapshot["marker"]
    provider, model, _base_url = _identity(snapshot)
    return bool(marker.get("schema") == 1 and provider and model
                and marker.get("provider") == provider and marker.get("model") == model)


def _verified(snapshot: dict, *, allow_pending: bool) -> tuple[dict, str]:
    marker = snapshot["marker"]
    provider, model, base_url = _identity(snapshot)
    if snapshot["problem"]:
        return {}, snapshot["problem"]
    if not marker:
        return {}, "未找到模型验证记录"
    if marker.get("schema") != 1 or not marker.get("provider") or not marker.get("model"):
        return {}, "模型验证记录格式无效"
    if marker.get("provider") != provider:
        return {}, "供应商与验证记录不一致"
    if marker.get("model") != model:
        return {}, "模型名称与验证记录不一致"
    if marker.get("selectedId"):
        current = _profile(snapshot["config"], snapshot["model"])
        if not current or marker["selectedId"] != current["id"]:
            return {}, "模型连接与验证记录不一致"
    if marker.get("validation") not in (None, "api-response"):
        return {}, "模型尚无真实调用验证记录"
    auth_mode = _auth_mode(marker.get("authMode")) if _text(marker.get("authMode")) else "key"
    native = auth_mode not in {"key", "none"}
    # The old schema has no explicit validation field. Preserve its established
    # Key checks, but require explicit API evidence for newly supported auth.
    if native and marker.get("validation") != "api-response":
        return {}, "原生模型尚无真实调用验证记录"
    custom = provider == "custom" or (provider.startswith("custom:") and bool(provider[7:].strip()))
    recorded_url = _text(marker.get("baseUrl")).rstrip("/")
    if custom and not native and (not base_url or base_url != recorded_url):
        return {}, "接口地址与验证记录不一致"
    if native and base_url and _endpoint(base_url) != _endpoint(recorded_url):
        return {}, "接口地址与验证记录不一致"
    credential_status, credential = _credential(snapshot)
    if not native:
        if custom and credential_status != "present":
            return {}, "未找到自定义模型密钥配置"
        if not custom:
            key_env = _text(marker.get("keyEnv"))
            credential = _text(snapshot["env"].get(key_env)) if re.fullmatch(r"[A-Z0-9_]+", key_env) else ""
            credential_status = "present" if credential else "missing"
        if credential_status != "present":
            return {}, "未找到供应商密钥配置"
    elif credential_status == "missing":
        return {}, "未找到已配置的模型凭据"
    if marker.get("credentialSha256"):
        if credential_status == "unknown":
            return {}, "当前凭据无法只读确认，模型配置已保留"
        if not credential or hashlib.sha256(credential.encode()).hexdigest() != marker["credentialSha256"]:
            return {}, "密钥已更改，需要重新验证模型"
    if marker.get("tavernSyncPending") and not allow_pending:
        return {}, "模型已验证，酒馆同步尚未完成"
    key_env = _text(marker.get("keyEnv"))
    if not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", key_env):
        key_env = ""
    return {"provider": provider, "model": model, "keyEnv": key_env,
            "baseUrl": _endpoint(base_url or recorded_url), "authMode": auth_mode,
            "validation": marker.get("validation") or "legacy-record",
            "tavernSyncPending": bool(marker.get("tavernSyncPending"))}, ""


def read_verified_model(nora_home: Path, hermes_home: Path, problems: list[str] | None = None,
                        *, allow_pending=False) -> dict:
    """Compatibility gate for an existing launcher verification checkpoint."""
    value, problem = _verified(_snapshot(Path(nora_home), Path(hermes_home)), allow_pending=allow_pending)
    if problem and problems is not None:
        problems.append(problem)
    return value


def public_model_state(nora_home: Path, hermes_home: Path) -> dict:
    """Public, redacted selection, credential conditions, and past validation.

    ``configured`` means a saved explicit selection exists, not that a request
    was sent or that cloud/external credentials are currently usable.
    """
    snapshot = _snapshot(Path(nora_home), Path(hermes_home))
    provider, model, base_url = _identity(snapshot)
    configured = bool(provider and provider != "auto" and model and "${" not in provider + model)
    credential_status, _secret = _credential(snapshot)
    selected = snapshot["model"]
    route = _declared_route(snapshot["config"], provider)
    source = route if route else selected
    auth_mode = _auth_mode(source.get("auth_mode") or source.get("auth_type"))
    # Unknown native authentication stays unknown instead of probing a provider
    # or pretending every saved model has a conventional API Key.
    if auth_mode == "unknown":
        auth_mode = "key" if credential_status == "present" else "unknown"
    proof, problem = _verified(snapshot, allow_pending=True)
    if auth_mode == "none" or proof and proof["authMode"] == "none":
        auth_mode, credential_status = "none", "not-required"
    validation = proof.get("validation", "unverified")
    configuration_status = "present" if configured else "unknown" if snapshot["problem"] else "missing"
    if snapshot["problem"] in {"未找到模型配置", "缺少模型配置"}:
        configuration_status = "missing"
    validation_status = "unverified"
    if proof:
        validation_status = "verified" if validation == "api-response" else "legacy-accepted"
    elif snapshot["marker"].get("validation") == "api-response":
        validation_status = "stale"
    return {"configured": configured, "provider": provider, "model": model,
            "baseUrl": _endpoint(base_url), "authMode": auth_mode,
            "apiMode": _text(selected.get("api_mode")),
            "configurationStatus": configuration_status,
            "credentialStatus": credential_status,
            "validation": validation,
            "validationStatus": validation_status,
            "validationProblem": problem,
            "validationAuthMode": proof.get("authMode", "unknown"),
            "tavernSyncPending": bool(snapshot["marker"].get("tavernSyncPending")) if _marker_matches(snapshot) else False,
            "activation": "next-session" if configured else "unknown", **_public_profiles(snapshot)}
