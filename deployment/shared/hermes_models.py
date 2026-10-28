"""Instance-local adapter to the model machinery shipped with Hermes.

No provider endpoints, model catalogs, or wire protocols are maintained here.
The caller owns admission and ordinary write-error rollback. Preflight uses
process-local selection values; it never temporarily changes the live model.
"""
from __future__ import annotations

from contextlib import contextmanager
from copy import deepcopy
import hmac
import os
from pathlib import Path
import uuid
from urllib.parse import urlparse


OWNED_CUSTOM = "custom:nora-launcher"
NO_AUTH_KEY = "nora-local-no-auth"
_secrets: set[str] = set()


def remember_secret(value):
    if isinstance(value, str) and value and value != NO_AUTH_KEY:
        _secrets.add(value)
    return value


def redact(value):
    text = str(value)
    for secret in sorted(_secrets, key=len, reverse=True):
        text = text.replace(secret, "***")
    return text


def validate_config():
    """Reject damaged input before Hermes' automatic config recovery can run."""
    import yaml
    home = Path(os.environ["HERMES_HOME"]).resolve()
    for name in ("config.yaml", ".env", "auth.json"):
        file = home / name
        if file.is_symlink() or (file.exists() and not file.is_file()):
            raise ValueError("模型配置路径无效，现有文件已保留。")
    file = home / "config.yaml"
    invalid = ""
    if file.exists():
        try:
            value = yaml.safe_load(file.read_text(encoding="utf-8"))
        except yaml.YAMLError as error:
            mark = getattr(error, "problem_mark", None)
            location = f"（行 {mark.line + 1}，列 {mark.column + 1}）" if mark else ""
            invalid = "现有模型配置不是合法 YAML" + location + "，现有文件已保留。"
        else:
            if not isinstance(value, dict):
                invalid = "现有模型配置格式无效，未修改配置。"
    # Raise outside the parser handler: its exception representation contains
    # source lines that may include a credential, even with no supplied key.
    if invalid:
        raise ValueError(invalid)


def _config():
    validate_config()
    from hermes_cli.config import load_config, get_config_path
    if Path(get_config_path()).resolve() != Path(os.environ["HERMES_HOME"]).resolve() / "config.yaml":
        raise ValueError("Hermes 配置不属于当前实例。")
    value = load_config()
    if not isinstance(value, dict):
        raise ValueError("现有模型配置格式无效。")
    return value


def _canonical(provider):
    from hermes_cli.models import normalize_provider
    return normalize_provider(str(provider or "").strip())


def _auth_status(provider):
    from hermes_cli.auth import get_auth_status, has_usable_secret
    from hermes_cli.config import load_env
    from hermes_cli.runtime_provider import _get_named_custom_provider
    if provider == "custom":
        return False
    named = _get_named_custom_provider(provider)
    if named:
        remember_secret(named.get("api_key"))
        env_key = str(named.get("key_env") or "")
        return bool(has_usable_secret(named.get("api_key")) or named.get("key_cmd") or
                    (env_key and has_usable_secret(load_env().get(env_key))))
    status = get_auth_status(provider)
    return bool(status.get("logged_in") or status.get("configured"))


def provider_info(provider):
    from hermes_cli.providers import (get_provider, resolve_user_provider, resolve_custom_provider,
                                    HERMES_OVERLAYS, ProviderDef)
    from hermes_cli.config import get_compatible_custom_providers
    from hermes_cli.auth import PROVIDER_REGISTRY
    from hermes_cli.auth_commands import _OAUTH_CAPABLE_PROVIDERS
    from hermes_cli.models import get_default_model_for_provider
    provider = _canonical(provider)
    config = _config()
    if provider == "custom":
        return {"id": "custom", "label": "自定义模型", "custom": True,
                "authType": "api_key", "authModes": ["key", "none"], "keyEnv": "",
                "keyless": False, "authenticated": False, "loginAvailable": False,
                "available": True, "endpointEditable": True, "endpointRequired": True,
                "baseUrl": "", "signupUrl": "", "defaultModel": ""}
    definition = (resolve_user_provider(provider, config.get("providers") or {})
                  or resolve_custom_provider(provider, get_compatible_custom_providers(config))
                  or get_provider(provider, allow_network=False))
    registry = PROVIDER_REGISTRY.get(provider)
    if definition is None and registry is not None:
        definition = ProviderDef(id=provider, name=registry.name, transport="",
            api_key_env_vars=registry.api_key_env_vars, base_url=registry.inference_base_url,
            base_url_env_var=registry.base_url_env_var, auth_type=registry.auth_type, source="hermes")
    if definition is None:
        raise ValueError("当前 Hermes 不支持这个模型服务。")
    auth_type = getattr(registry, "auth_type", None) or definition.auth_type
    custom = definition.source == "user-config" or provider.startswith("custom:")
    overlay = HERMES_OVERLAYS.get(definition.id) or HERMES_OVERLAYS.get(provider)
    keyless = bool(getattr(overlay, "keyless", False) or auth_type in {"none", "keyless"})
    modes = (["none"] if keyless else ["oauth"] if auth_type.startswith("oauth")
             else ["key"] if auth_type == "api_key" else ["external"])
    if custom:
        modes = ["key", "none"]
    login = provider in _OAUTH_CAPABLE_PROVIDERS
    if login and "oauth" not in modes:
        modes.append("oauth")
    envs = getattr(registry, "api_key_env_vars", ()) or definition.api_key_env_vars
    try:
        authenticated = _auth_status(provider)
    except Exception:
        authenticated = False
    return {"id": provider, "label": definition.name or provider,
            "custom": custom, "authType": auth_type,
            "authModes": modes, "keyEnv": envs[0] if envs else "", "keyless": keyless,
            "authenticated": authenticated, "loginAvailable": login,
            "endpointEditable": custom or bool(definition.base_url_env_var),
            "endpointRequired": custom or (not definition.base_url and auth_type == "api_key"),
            "available": True, "reason": "", "baseUrl": definition.base_url or "",
            "signupUrl": definition.doc or "", "defaultModel": get_default_model_for_provider(provider) or ""}


def catalog():
    from hermes_cli.models import list_available_providers
    from hermes_cli.config import get_compatible_custom_providers
    from hermes_cli.providers import custom_provider_slug
    cfg = _config()
    ids = [item["id"] for item in list_available_providers()]
    ids += [custom_provider_slug(str(value.get("name") or key), str(key))
            for key, value in (cfg.get("providers") or {}).items() if isinstance(value, dict)]
    ids += [custom_provider_slug(str(value.get("name") or ""))
            for value in get_compatible_custom_providers(cfg) if isinstance(value, dict)]
    providers = []
    for provider in dict.fromkeys([*ids, "custom"]):
        try:
            providers.append(provider_info(provider))
        except ValueError:
            # A stale custom entry is not promoted into a working provider.
            continue
    return {"ok": True, "providers": providers, "current": inspect_model()}


def normalize(provider, model, base_url="", auth_mode="key"):
    from hermes_cli.web_server_config import _normalize_main_model_assignment
    info = provider_info(provider)
    model = str(model or "").strip()
    if not model or len(model) > 240 or any(c in model for c in "\r\n\x00"):
        raise ValueError("模型名称无效。")
    if auth_mode not in info["authModes"]:
        raise ValueError("这个模型服务不支持所选认证方式。")
    base_url = str(base_url or "").strip().rstrip("/")
    if info["custom"] and not base_url:
        base_url = info["baseUrl"]
    if base_url:
        url = urlparse(base_url)
        if (len(base_url) > 2048 or url.scheme not in {"http", "https"} or not url.hostname
                or url.username or url.password or url.query or url.fragment):
            raise ValueError("接口地址必须是不含账号、查询参数或片段的 HTTP/HTTPS 基础地址。")
        if info["custom"]:
            base_url = base_url.removesuffix("/chat/completions")
    if info["id"] == "custom" and not base_url:
        raise ValueError("自定义模型需要接口地址。")
    provider, model = ("custom", model) if info["id"] == "custom" else _normalize_main_model_assignment(info["id"], model)
    return {"provider": provider, "model": model, "baseUrl": base_url,
            "authMode": auth_mode, "keyEnv": info["keyEnv"]}


def _owned_entry(config, selection, key):
    existing = (config.get("providers") or {}).get(OWNED_CUSTOM)
    if existing is not None and (not isinstance(existing, dict) or existing.get("nora_launcher_managed") != 1):
        raise ValueError("启动器服务名称已被其他配置占用，未替换模型。")
    entry = deepcopy(existing or {})
    # These two fields were generated unconditionally by the old writer. Let
    # Hermes infer its own mode now, while retaining user headers/body options.
    if entry.get("transport") == "openai_chat" and entry.get("api_mode") == "chat_completions":
        entry.pop("transport", None)
        entry.pop("api_mode", None)
    entry.update(name="Nora Launcher", base_url=selection["baseUrl"],
                 api_key=key or entry.get("api_key", ""), default_model=selection["model"],
                 nora_launcher_managed=1)
    return entry


@contextmanager
def _candidate(selection, key):
    """Supply candidate selection to Hermes' resolver inside this child only."""
    import hermes_cli.runtime_provider as runtime
    from hermes_cli.web_server_config import _apply_main_model_assignment
    from hermes_cli.model_switch import _PROVIDER_API_MODE_OVERRIDES
    cfg = _config()
    provider = selection["provider"]
    selected_model = _apply_main_model_assignment(deepcopy(cfg.get("model")), provider,
                        selection["model"], selection["baseUrl"], key)
    override = _PROVIDER_API_MODE_OVERRIDES.get(provider)
    if override:
        selected_model["api_mode"] = override(provider, selection["model"], key)
    original_model = runtime._get_model_config
    original_custom = runtime._get_named_custom_provider
    original_pool = runtime._try_resolve_from_custom_pool
    entry = _owned_entry(cfg, selection, key) if provider == "custom" else None
    target = OWNED_CUSTOM if entry is not None else provider
    runtime._get_model_config = lambda: selected_model
    if entry is not None:
        # Match Hermes' normalized named-custom shape, including unknown extras.
        def named(name):
            if name == target:
                return {**entry, "provider_key": target, "name": "Nora Launcher"}
            return original_custom(name)
        runtime._get_named_custom_provider = named
    declared = entry or original_custom(provider)
    current = cfg.get("model")
    current_provider = current.get("provider") if isinstance(current, dict) else ""
    if key or provider != current_provider or (declared and declared.get("key_cmd")):
        # The live model's pool may be seeded from a different provider at the
        # same URL. Candidate inspection must resolve the selected entry/key
        # command, not persist or reuse that old selection's credential seed.
        runtime._try_resolve_from_custom_pool = lambda *args, **kwargs: None
    try:
        yield runtime, target
    finally:
        runtime._get_model_config = original_model
        runtime._get_named_custom_provider = original_custom
        runtime._try_resolve_from_custom_pool = original_pool


def resolve_candidate(selection, key=""):
    key = remember_secret(str(key or "").strip())
    if key and selection["authMode"] not in {"key", "none"}:
        raise ValueError("登录认证不应同时提交 API Key。")
    if selection["authMode"] == "none" and provider_info(selection["provider"])["custom"]:
        key = NO_AUTH_KEY
    if key and (len(key) > 8192 or any(c.isspace() for c in key)):
        raise ValueError("API Key 格式不正确。")
    if selection["authMode"] == "key" and not key and not provider_info(selection["provider"])["authenticated"]:
        raise ValueError("请输入 API Key，或先完成此服务的认证。")
    with _candidate(selection, key) as (module, provider):
        result = module.resolve_runtime_provider(requested=provider, explicit_api_key=key or None,
                         explicit_base_url=selection["baseUrl"] or None, target_model=selection["model"])
    remember_secret(result.get("api_key"))
    from hermes_cli.models import normalize_opencode_base_url
    result["base_url"] = normalize_opencode_base_url(selection["provider"], result.get("api_mode"), result.get("base_url"))
    if key and isinstance(result.get("api_key"), str) and not hmac.compare_digest(result["api_key"], key):
        raise ValueError("Hermes 解析的凭据与本次选择不一致。")
    result["model"] = selection["model"]
    return result


def inspect_model(credential_sha256=""):
    cfg = _config()
    model = cfg.get("model") or {}
    if not isinstance(model, dict) or not model.get("provider") or not model.get("default"):
        return {"configured": False}
    provider = str(model["provider"])
    remember_secret(model.get("api_key"))
    try:
        from hermes_cli.runtime_provider import resolve_runtime_provider
        runtime = resolve_runtime_provider(requested=provider, target_model=str(model["default"]))
        remember_secret(runtime.get("api_key"))
        info = provider_info(provider)
        usable = bool(runtime.get("api_key") or info["keyless"] or _auth_status(provider))
        import hashlib
        digest_matches = not credential_sha256 or (isinstance(runtime.get("api_key"), str) and
            hmac.compare_digest(hashlib.sha256(runtime["api_key"].encode()).hexdigest(), credential_sha256))
        return {"configured": usable, "credentialMatches": digest_matches, "provider": provider, "model": model["default"],
                "baseUrl": str(runtime.get("base_url") or ""), "apiMode": runtime.get("api_mode"),
                "authMode": "oauth" if info["authType"].startswith("oauth") else
                            "none" if info["keyless"] or (info["custom"] and runtime.get("api_key") == NO_AUTH_KEY)
                            else "key" if info["authType"] == "api_key" else "external",
                "keyEnv": info["keyEnv"], "authenticated": usable}
    except Exception as error:
        return {"configured": False, "provider": provider, "model": model["default"],
                "reason": redact(error)}


def save(selection, key=""):
    from hermes_cli.config import load_config, save_config, find_provider_entry
    from hermes_cli.credential_lifecycle import save_provider_env_credential
    from hermes_cli.web_server_config import _apply_main_model_assignment, _resolve_assignment_credentials
    from hermes_cli.runtime_provider import _get_named_custom_provider
    key = remember_secret(str(key or "").strip())
    if selection["authMode"] == "none" and provider_info(selection["provider"])["custom"]:
        key = NO_AUTH_KEY
    runtime = resolve_candidate(selection, key)
    provider = selection["provider"]
    cfg = load_config()
    custom_entry = None
    if provider == "custom":
        cfg.setdefault("providers", {})[OWNED_CUSTOM] = _owned_entry(cfg, selection, key)
        custom_entry = cfg["providers"][OWNED_CUSTOM]
        provider = OWNED_CUSTOM
    elif (named := _get_named_custom_provider(provider)) is not None:
        stored_key, custom_entry = find_provider_entry(cfg.get("providers"), named.get("provider_key") or provider)
        if custom_entry is None:
            # A legacy entry is matched by its native name, never by shared URL.
            custom_entry = next((entry for entry in cfg.get("custom_providers", [])
                                 if isinstance(entry, dict) and entry.get("name") == named.get("name")), None)
        if custom_entry is None:
            raise ValueError("未找到所选 Hermes 自定义服务的原配置，未更换模型。")
        if key:
            custom_entry["api_key"] = key
        if selection["baseUrl"]:
            custom_entry["base_url"] = selection["baseUrl"]
        custom_entry["default_model" if stored_key is not None else "model"] = selection["model"]
    elif key and selection["keyEnv"]:
        save_provider_env_credential(selection["keyEnv"], key)
        # Native credential rotation may reconcile old config mirrors.
        cfg = load_config()
    if custom_entry is not None and key:
        key_env = str(custom_entry.get("key_env") or custom_entry.get("api_key_env") or "").strip()
        if key_env:
            save_provider_env_credential(key_env, key)
            custom_entry.pop("api_key", None)
        # Explicitly entering a key changes this selected entry's credential
        # source; otherwise its existing Hermes key command stays untouched.
        custom_entry.pop("key_cmd", None)
    model = _apply_main_model_assignment(deepcopy(cfg.get("model")), provider,
                            selection["model"], selection["baseUrl"], key if custom_entry is not None else "")
    _resolve_assignment_credentials(model, provider, custom_entry)
    if custom_entry is not None:
        key_env = str(custom_entry.get("key_env") or custom_entry.get("api_key_env") or "").strip()
        if key_env:
            # Hermes' main assignment helper reads raw v12 providers only;
            # preserve the same pointer for a selected legacy entry as well.
            model["key_env"] = key_env
            model.pop("api_key", None)
    # Preserve the exact mode selected by Hermes, rather than imposing OpenAI.
    if runtime.get("api_mode"):
        model["api_mode"] = runtime["api_mode"]
    cfg["model"] = model
    save_config(cfg)
    if custom_entry is not None:
        # Reconcile config-seeded credentials through Hermes' own pool writer.
        from agent.credential_pool import custom_provider_pool_key_candidates, load_pool
        for pool_key in custom_provider_pool_key_candidates(str(runtime.get("base_url") or ""), provider):
            load_pool(pool_key)
    from hermes_cli.runtime_provider import resolve_runtime_provider
    actual = resolve_runtime_provider(requested=provider, target_model=selection["model"])
    remember_secret(actual.get("api_key"))
    if (actual.get("api_mode") != runtime.get("api_mode") or
            str(actual.get("base_url") or "").rstrip("/") != str(runtime.get("base_url") or "").rstrip("/") or
            (key and (not isinstance(actual.get("api_key"), str) or not hmac.compare_digest(actual["api_key"], key)))):
        raise ValueError("实际模型服务与新配置不一致，未确认模型切换。")
    return {"ok": True, **selection, "provider": provider,
            "baseUrl": str(actual.get("base_url") or ""), "apiMode": actual.get("api_mode"),
            "validation": "configuration-only", "activation": "next-session"}


def models(provider, key="", base_url="", auth_mode="key"):
    from hermes_cli.models import provider_model_ids, curated_models_for_provider
    # Fetchers use the same credential lifecycle as model selection. A process-
    # local env override supplies an entered key without persisting it first.
    import os
    info = provider_info(provider)
    key = remember_secret(str(key or "").strip())
    env_name = info["keyEnv"]
    previous = os.environ.get(env_name) if env_name else None
    if env_name and key:
        os.environ[env_name] = key
    try:
        explicit_endpoint = str(base_url or "").strip().rstrip("/")
        if info["custom"] or (explicit_endpoint and explicit_endpoint != info["baseUrl"].rstrip("/")):
            from hermes_cli.models import fetch_api_models
            selection = normalize(provider, info["defaultModel"] or "catalog-query", base_url, auth_mode)
            runtime = resolve_candidate(selection, key)
            credential = runtime.get("api_key")
            if callable(credential):
                credential = credential()
            remember_secret(credential)
            for value in (runtime.get("extra_headers") or {}).values():
                remember_secret(value)
            values = fetch_api_models(credential, runtime.get("base_url"),
                api_mode=runtime.get("api_mode"), headers=runtime.get("extra_headers"))
        else:
            values = provider_model_ids(info["id"], force_refresh=True)
        values = values or curated_models_for_provider(info["id"])
        return {"ok": True, "provider": info["id"], "models": list(dict.fromkeys(values or []))}
    finally:
        if env_name and key:
            if previous is None:
                os.environ.pop(env_name, None)
            else:
                os.environ[env_name] = previous


def test(selection, key=""):
    """One Hermes request to the chosen destination, without its fallback ladder."""
    from agent.auxiliary_client import resolve_provider_client, _build_call_kwargs
    from agent.portal_tags import set_conversation_context, reset_conversation_context
    runtime = resolve_candidate(selection, key)
    provider = runtime.get("provider") or selection["provider"]
    credential = runtime.get("api_key")
    if callable(credential):
        # Hermes owns minting short-lived key_cmd / cloud credentials. One
        # validation request needs one native credential, never a persisted copy.
        credential = credential()
    remember_secret(credential)
    headers = runtime.get("extra_headers")
    if isinstance(headers, dict):
        for value in headers.values():
            remember_secret(value)
    # Named custom providers resolve to the generic custom wire identity.
    if provider == "anthropic":
        # Hermes' auxiliary Anthropic shortcut reads the saved main endpoint
        # instead of explicit_base_url. Preflight must target the unsaved choice.
        from agent.anthropic_adapter import build_anthropic_client
        from agent.anthropic_credentials import _is_oauth_token
        from agent.auxiliary_client import AnthropicAuxiliaryClient
        native = build_anthropic_client(credential, runtime["base_url"])
        model = selection["model"]
        client = AnthropicAuxiliaryClient(native, model, credential, runtime["base_url"],
                                         is_oauth=_is_oauth_token(credential))
    else:
        client, model = resolve_provider_client(provider, model=selection["model"],
            explicit_api_key=credential, explicit_base_url=runtime.get("base_url"),
            api_mode=runtime.get("api_mode"), main_runtime=runtime)
    expected_url = str(runtime.get("base_url") or "").rstrip("/")
    client_url = str(getattr(client, "base_url", "") or "").rstrip("/")
    mismatched_endpoint = (urlparse(expected_url).scheme in {"http", "https"}
                           and urlparse(client_url).scheme in {"http", "https"}
                           and client_url != expected_url)
    if client is None or model != selection["model"] or mismatched_endpoint:
        close = getattr(client, "close", None)
        if callable(close):
            close()
        raise ValueError("Hermes 未能为所选模型和地址建立验证连接，未发送验证请求。")
    token = set_conversation_context("nora-model-validation-" + uuid.uuid4().hex)
    try:
        kwargs = _build_call_kwargs(provider, model,
            [{"role": "user", "content": "Reply with exactly: NORA_OK"}],
            timeout=120, base_url=runtime.get("base_url"),
            extra_body=(runtime.get("request_overrides") or {}).get("extra_body"))
        if isinstance(headers, dict) and headers:
            kwargs["extra_headers"] = {**(kwargs.get("extra_headers") or {}), **headers}
        response = client.chat.completions.create(**kwargs)
        message = response.choices[0].message
        content = getattr(message, "content", None)
        if not isinstance(content, str) or not content.strip():
            raise ValueError("模型服务已响应，但没有返回模型内容。")
        return {"ok": True, "provider": selection["provider"], "model": model,
                "validation": "api-response", "toolSupport": "unverified", "fallbackUsed": False}
    finally:
        reset_conversation_context(token)
        close = getattr(client, "close", None)
        if callable(close):
            close()
