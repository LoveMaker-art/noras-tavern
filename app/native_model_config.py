"""Hermes system-model projection for the native SillyTavern runtime."""

from __future__ import annotations

import argparse
import hashlib
import http.cookiejar
import json
import os
from pathlib import Path
import urllib.request

import yaml


class NativeModelConfigError(RuntimeError):
    pass


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
        oai.update({
            "chat_completion_source": "custom",
            "custom_url": config["base_url"],
            "custom_model": config["model"],
            "openai_max_context": config["context"],
            "openai_max_tokens": config["max_tokens"],
            "max_context_unlocked": True,
            "stream_openai": True,
        })
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
        secret_state = self._request("/api/secrets/read", {})
        active_custom_secret = next((
            item.get("id")
            for item in secret_state.get("api_key_custom") or []
            if item.get("active") and item.get("id")
        ), "")
        if preserve_user_model and not active_custom_secret:
            raise NativeModelConfigError("Active user model credential is missing")
        secret = self._request("/api/secrets/write", {
            "key": "api_key_custom",
            "value": config["api_key"],
            "label": "Nora Hermes default model",
        })
        secret_id = str(secret.get("id") or "")
        if preserve_user_model:
            self._request("/api/secrets/rotate", {
                "key": "api_key_custom",
                "id": active_custom_secret,
            })
        saved = self._request("/api/settings/save", update_settings(
            settings,
            config,
            secret_id=secret_id,
            activate=not preserve_user_model,
            active_secret_id=active_custom_secret,
        ))
        if not secret.get("id") or saved.get("result") != "ok":
            raise NativeModelConfigError("SillyTavern rejected model configuration")
        return secret_id


def configure(config_path, settings_path, marker_path, base_url):
    config = load_model_config(config_path)
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
    args = parser.parse_args()
    print(json.dumps(configure(
        args.config, args.settings, args.marker, args.base_url
    ), ensure_ascii=False))


if __name__ == "__main__":
    main()
