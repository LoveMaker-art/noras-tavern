"""Hermes system-model projection for the native SillyTavern runtime."""

from __future__ import annotations

import argparse
import hashlib
import http.cookiejar
import json
import os
from pathlib import Path
import urllib.request
from urllib.parse import urlparse

import yaml


class NativeModelConfigError(RuntimeError):
    pass


LAUNCHER_PROVIDERS = {
    "openrouter": ("OpenRouter", "custom", "api_key_custom", "https://openrouter.ai/api/v1"),
    "deepseek": ("DeepSeek", "custom", "api_key_custom", "https://api.deepseek.com/v1"),
    "openai-api": ("OpenAI", "custom", "api_key_custom", "https://api.openai.com/v1"),
    "anthropic": ("Anthropic", "claude", "api_key_claude", "https://api.anthropic.com/v1"),
    "gemini": ("Google Gemini", "makersuite", "api_key_makersuite", "https://generativelanguage.googleapis.com/v1beta"),
    "custom": ("自定义模型", "custom", "api_key_custom", ""),
}


def launcher_config(provider, model, api_key, base_url=""):
    if provider not in LAUNCHER_PROVIDERS or not model or not api_key:
        raise NativeModelConfigError("启动器模型配置不完整")
    label, source, secret_key, endpoint = LAUNCHER_PROVIDERS[provider]
    if provider == "custom":
        parsed = urlparse(base_url)
        if parsed.scheme not in ("http", "https") or not parsed.hostname or parsed.username or parsed.password:
            raise NativeModelConfigError("自定义模型地址无效")
        endpoint = base_url.rstrip("/")
    return {"provider": label, "source": source, "secret_key": secret_key,
            "api_key": api_key, "model": model, "base_url": endpoint,
            "context": 8192, "max_tokens": 2048}


def load_model_config(path):
    value = yaml.safe_load(Path(path).read_text(encoding="utf-8")) or {}
    model = value.get("model") or {}
    provider_name = str(model.get("provider") or "clawling").strip()
    provider = (value.get("providers") or {}).get(provider_name) or {}
    api_key = str(provider.get("api_key") or model.get("api_key") or "")
    base_url = str(provider.get("api") or provider.get("base_url") or model.get("base_url") or "").rstrip("/")
    model_name = str(model.get("default") or "")
    context = int(model.get("context_length") or 200000)
    max_tokens = int(model.get("max_tokens") or 30000)
    if not api_key or not base_url or not model_name:
        raise NativeModelConfigError("Hermes model configuration is incomplete")
    return {
        "provider": provider_name,
        "api_key": api_key,
        "base_url": base_url,
        "model": model_name,
        "context": max(1024, min(context, 2_000_000)),
        "max_tokens": max(16, min(max_tokens, 100_000)),
    }


def public_fingerprint(config):
    payload = {
        "provider": config["provider"],
        "base_url": config["base_url"],
        "model": config["model"],
        "context": config["context"],
        "max_tokens": config["max_tokens"],
        "key_sha256": hashlib.sha256(config["api_key"].encode()).hexdigest(),
    }
    return hashlib.sha256(json.dumps(payload, sort_keys=True).encode()).hexdigest()


def update_settings(settings, config, *, secret_id="", activate=True, active_secret_id=""):
    result = dict(settings)
    extensions = dict(result.get("extension_settings") or {})
    nora_ui = dict(extensions.get("nora_ui") or {})
    nora_ui["hermesModel"] = {
        "provider": config["provider"],
        "model": config["model"],
        "base": config["base_url"],
        "context": config["context"],
        "tokens": config["max_tokens"],
        "secretId": secret_id,
    }
    if "source" in config:
        nora_ui["hermesModel"].update({"source": config["source"], "secretKey": config["secret_key"]})
    if not activate and active_secret_id:
        active_model = str(nora_ui.get("activeModel") or "").strip()
        profiles = []
        for value in nora_ui.get("modelProfiles") or []:
            profile = dict(value)
            if str(profile.get("id") or "").strip() == active_model:
                profile["secretId"] = active_secret_id
            profiles.append(profile)
        nora_ui["modelProfiles"] = profiles
    if activate:
        result["main_api"] = "openai"
        oai = dict(result.get("oai_settings") or {})
        source = config.get("source", "custom")
        oai.update({
            "chat_completion_source": source,
            "openai_max_context": config["context"],
            "openai_max_tokens": config["max_tokens"],
            "max_context_unlocked": True,
            "stream_openai": True,
        })
        if source == "custom":
            oai.update({"custom_url": config["base_url"], "custom_model": config["model"]})
        else:
            oai[{"claude": "claude_model", "makersuite": "google_model"}[source]] = config["model"]
            oai["reverse_proxy"] = ""
        result["oai_settings"] = oai
        nora_ui["activeModel"] = ""
    extensions["nora_ui"] = nora_ui
    result["extension_settings"] = extensions
    return result


class NativeSettingsClient:
    def __init__(self, base_url):
        self.base_url = base_url.rstrip("/")
        jar = http.cookiejar.CookieJar()
        self.opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar))
        self.csrf = self._request("/csrf-token")["token"]

    def _request(self, path, payload=None):
        data = None if payload is None else json.dumps(payload, ensure_ascii=False).encode()
        headers = {"Accept": "application/json"}
        if data is not None:
            headers.update({"Content-Type": "application/json", "X-CSRF-Token": self.csrf})
        request = urllib.request.Request(
            self.base_url + path,
            data=data,
            headers=headers,
            method="POST" if data is not None else "GET",
        )
        with self.opener.open(request, timeout=30) as response:
            payload = response.read(8 * 1024 * 1024).decode("utf-8")
            return json.loads(payload) if payload else {}

    def configure(self, settings, config):
        nora_ui = ((settings.get("extension_settings") or {}).get("nora_ui") or {})
        preserve_user_model = bool(str(nora_ui.get("activeModel") or "").strip())
        key = config.get("secret_key", "api_key_custom")
        secret_state = self._request("/api/secrets/read", {})
        previous_id = next((item.get("id") for item in secret_state.get(key) or []
                            if item.get("active") and item.get("id")), "")
        active_source = (settings.get("oai_settings") or {}).get("chat_completion_source", "custom")
        active_key = {"claude": "api_key_claude", "makersuite": "api_key_makersuite"}.get(active_source, "api_key_custom")
        active_id = next((item.get("id") for item in secret_state.get(active_key) or []
                          if item.get("active") and item.get("id")), "")
        if preserve_user_model and not active_id:
            raise NativeModelConfigError("Active user model credential is missing")
        secret_id = ""
        try:
            secret_id = str(self._request("/api/secrets/write", {
                "key": key, "value": config["api_key"], "label": "Nora Hermes default model",
            }).get("id") or "")
            if not secret_id:
                raise NativeModelConfigError("SillyTavern rejected model credential")
            if preserve_user_model and previous_id:
                self._request("/api/secrets/rotate", {"key": key, "id": previous_id})
            updated = update_settings(settings, config, secret_id=secret_id,
                                      activate=not preserve_user_model, active_secret_id=active_id)
            if self._request("/api/settings/save", updated).get("result") != "ok":
                raise NativeModelConfigError("SillyTavern rejected model configuration")
            actual = self.settings()
            secrets = self._request("/api/secrets/read", {}).get(key) or []
            if (actual.get("oai_settings") != updated.get("oai_settings")
                    or (actual.get("extension_settings") or {}).get("nora_ui") != updated["extension_settings"]["nora_ui"]
                    or not any(item.get("id") == secret_id for item in secrets)
                    or (not preserve_user_model and not any(
                        item.get("id") == secret_id and item.get("active") for item in secrets))):
                raise NativeModelConfigError("SillyTavern model readback failed")
        except Exception:
            # Remove only this transaction's new credential after settings are restored.
            if secret_id:
                try:
                    if self._request("/api/settings/save", settings).get("result") == "ok":
                        if previous_id:
                            self._request("/api/secrets/rotate", {"key": key, "id": previous_id})
                        self._request("/api/secrets/delete", {"key": key, "id": secret_id})
                except Exception:
                    pass
            raise NativeModelConfigError("酒馆模型同步未完成，请重试。") from None
        return secret_id

    def settings(self):
        value = self._request("/api/settings/get", {}).get("settings")
        settings = json.loads(value) if isinstance(value, str) else value
        if not isinstance(settings, dict):
            raise NativeModelConfigError("无法读取酒馆模型设置")
        return settings


def initialize_launcher_model(config, marker_path, base_url):
    """Seed a fresh Tavern only. Subsequent Hermes edits must not change it."""
    marker_path = Path(marker_path)
    if marker_path.is_file():
        return {"ok": True, "changed": False, "reason": "already-initialized"}
    client = NativeSettingsClient(base_url)
    settings = client.settings()
    ui = (settings.get("extension_settings") or {}).get("nora_ui") or {}
    oai = settings.get("oai_settings") or {}
    secrets = client._request("/api/secrets/read", {})
    has_credentials = any(bool(value) for key, value in secrets.items() if key.startswith("api_key_"))
    if (ui.get("hermesModel") or ui.get("activeModel") or ui.get("modelProfiles")
            or oai.get("custom_url") or oai.get("custom_model") or oai.get("reverse_proxy") or has_credentials):
        return {"ok": True, "changed": False, "reason": "existing-tavern-model-preserved"}
    client.configure(settings, config)
    marker_path.parent.mkdir(parents=True, exist_ok=True)
    temporary = marker_path.with_suffix(".tmp")
    temporary.write_text(json.dumps({"schema": 1, "provider": config["provider"], "model": config["model"]}), encoding="utf-8")
    os.chmod(temporary, 0o600)
    temporary.replace(marker_path)
    return {"ok": True, "changed": True, "model": config["model"]}


def configure(config_path, settings_path, marker_path, base_url, *, allow_unconfigured=False):
    try:
        config = load_model_config(config_path)
    except (NativeModelConfigError, FileNotFoundError):
        if not allow_unconfigured:
            raise
        return {"ok": True, "changed": False, "configured": False, "reason": "target-model-unconfigured"}
    fingerprint = public_fingerprint(config)
    marker_path = Path(marker_path)
    try:
        marker = json.loads(marker_path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        marker = {}
    if marker.get("schema") == 2 and marker.get("fingerprint") == fingerprint:
        return {"ok": True, "changed": False, "model": config["model"]}
    settings = json.loads(Path(settings_path).read_text(encoding="utf-8"))
    secret_id = NativeSettingsClient(base_url).configure(settings, config)
    marker_path.parent.mkdir(parents=True, exist_ok=True)
    temporary = marker_path.with_suffix(".tmp")
    temporary.write_text(json.dumps({
        "schema": 2,
        "fingerprint": fingerprint,
        "provider": config["provider"],
        "model": config["model"],
        "base_url": config["base_url"],
        "secret_id": secret_id,
    }, indent=2) + "\n", encoding="utf-8")
    os.chmod(temporary, 0o600)
    temporary.replace(marker_path)
    return {"ok": True, "changed": True, "model": config["model"]}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--config", required=True)
    parser.add_argument("--settings", required=True)
    parser.add_argument("--marker", required=True)
    parser.add_argument("--base-url", default="http://127.0.0.1:8799")
    parser.add_argument("--allow-unconfigured", action="store_true",
                        help="Allow startup without inventing a model when the target has no complete configuration")
    args = parser.parse_args()
    print(json.dumps(configure(
        args.config, args.settings, args.marker, args.base_url, allow_unconfigured=args.allow_unconfigured
    ), ensure_ascii=False))


if __name__ == "__main__":
    main()
