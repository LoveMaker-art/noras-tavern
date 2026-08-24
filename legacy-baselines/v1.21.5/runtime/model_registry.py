"""Thread-safe model configuration service for Tavern."""

from __future__ import annotations

import json
import os
import secrets
import threading
import time
import urllib.error


class ModelRegistry:
    def __init__(
        self,
        path,
        *,
        builtin_base,
        builtin_key,
        builtin_name,
        official_models,
        ping,
        model_info,
        validate_base,
    ):
        self.path = path
        self.builtin_base = builtin_base
        self.builtin_key = builtin_key
        self.builtin_name = builtin_name
        self._official = tuple(official_models)
        self._ping = ping
        self._model_info = model_info
        self._validate_base = validate_base
        self._lock = threading.RLock()

    def official_models(self):
        return list(self._official)

    def model_id(self, model_name):
        return "builtin" if model_name == self._official[0] else "clawling:" + model_name

    def model_name(self, model_id):
        if model_id == "builtin":
            return self._official[0]
        if str(model_id).startswith("clawling:"):
            return str(model_id).split(":", 1)[1]
        return ""

    def _load_unlocked(self):
        try:
            with open(self.path, encoding="utf-8") as file:
                raw = json.load(file)
        except FileNotFoundError:
            raw = {}
        if not isinstance(raw, dict):
            raw = {}
        configs = [item for item in (raw.get("configs") or []) if isinstance(item, dict)]
        return {"configs": configs, "active": str(raw.get("active") or "builtin")}

    def _save_unlocked(self, state):
        temporary = self.path + ".tmp." + secrets.token_hex(4)
        try:
            with open(temporary, "w", encoding="utf-8") as file:
                json.dump(state, file, ensure_ascii=False, indent=2)
                file.flush()
                os.fsync(file.fileno())
            os.chmod(temporary, 0o600)
            os.replace(temporary, self.path)
        finally:
            try:
                os.remove(temporary)
            except FileNotFoundError:
                pass

    @staticmethod
    def _mask_key(key):
        return "**" + str(key)[-4:] if len(str(key or "")) >= 8 else "**"

    @staticmethod
    def _find_config(state, ref):
        return next(
            (item for item in state["configs"] if item.get("id") == ref or item.get("name") == ref),
            None,
        )

    def active_override(self):
        with self._lock:
            state = self._load_unlocked()
        active_id = state.get("active") or "builtin"
        official_name = self.model_name(active_id)
        if official_name in self._official:
            if active_id == "builtin" and official_name == self.builtin_name:
                return None
            return {
                "base": self.builtin_base,
                "key": self.builtin_key,
                "model": official_name,
            }
        config = self._find_config(state, active_id)
        if not config:
            return None
        return {"base": config["base"], "key": config["key"], "model": config["model"]}

    def public_view(self):
        with self._lock:
            state = self._load_unlocked()
        builtin = [
            {
                "id": self.model_id(model),
                "name": model,
                "model": model,
                "builtin": True,
                "provider": "Clawling",
                "default": model == self._official[0],
                "key_set": bool(self.builtin_key),
                "kind": "official",
            }
            for model in self._official
        ]
        custom = [
            {
                "id": item.get("id"),
                "name": item.get("name"),
                "model": item.get("model"),
                "base": item.get("base"),
                "key_masked": self._mask_key(item.get("key")),
                "added_at": item.get("added_at"),
                "kind": "custom",
            }
            for item in state["configs"]
        ]
        configs = builtin + custom
        active = state.get("active") or "builtin"
        if not any(item["id"] == active for item in configs):
            active = "builtin"
        return {"configs": configs, "active": active}

    def _ping_or_raise(self, override):
        if override and override.get("base"):
            self._validate_base(override["base"])
        try:
            return self._ping(override)
        except urllib.error.HTTPError as error:
            body = error.read().decode("utf-8", "replace")[:200]
            hint = {401: "（key 无效或没权限）", 404: "（base_url 或 model 名不对）", 429: "（限流/欠费）"}.get(error.code, "")
            raise ValueError(f"实测失败 HTTP {error.code}{hint}：{body}") from error
        except Exception as error:
            raise ValueError(f"实测失败：{error}") from error

    def add(self, event):
        name = str(event.get("name") or "").strip()[:80]
        base = str(event.get("base") or "").strip().rstrip("/")
        model = str(event.get("model") or "").strip()[:200]
        key = str(event.get("key") or "").strip()
        if not (name and base and model and key):
            raise ValueError("缺参数：name / base / model / key 都要")
        if len(base) > 2048 or len(key) > 8192:
            raise ValueError("模型地址或 key 过长")
        if name == "内置模型":
            raise ValueError("这个名字留给内置配置了，换一个")
        latency = self._ping_or_raise({"base": base, "key": key, "model": model})
        with self._lock:
            state = self._load_unlocked()
            config = next((item for item in state["configs"] if item.get("name") == name), None)
            if config:
                config.update({"base": base, "model": model, "key": key})
            else:
                config = {
                    "id": "m_" + secrets.token_hex(3),
                    "name": name,
                    "base": base,
                    "model": model,
                    "key": key,
                    "added_at": int(time.time()),
                }
                state["configs"].append(config)
            state["active"] = config["id"]
            self._save_unlocked(state)
        return {
            "config": {
                "id": config["id"],
                "name": name,
                "model": model,
                "key_masked": self._mask_key(key),
            },
            "active": config["id"],
            "latency_ms": latency,
        }

    def use(self, event):
        ref = event.get("id") or ""
        with self._lock:
            state = self._load_unlocked()
            official_name = self.model_name(ref)
            if ref in ("内置模型", self.builtin_name, self._official[0]):
                official_name = self._official[0]
            if official_name in self._official:
                state["active"] = self.model_id(official_name)
                self._save_unlocked(state)
                return {"active": state["active"], "name": official_name}
            config = self._find_config(state, ref)
            if not config:
                raise ValueError("没有这份配置：%s" % ref)
            state["active"] = config["id"]
            self._save_unlocked(state)
            return {"active": config["id"], "name": config["name"]}

    def delete(self, event):
        ref = event.get("id") or ""
        if ref in ("builtin", "内置模型"):
            raise ValueError("内置模型不可删除")
        with self._lock:
            state = self._load_unlocked()
            config = self._find_config(state, ref)
            if not config:
                raise ValueError("没有这份配置：%s" % ref)
            state["configs"] = [item for item in state["configs"] if item.get("id") != config["id"]]
            if state.get("active") == config["id"]:
                state["active"] = "builtin"
            self._save_unlocked(state)
            return {"deleted": config["id"], "name": config["name"], "active": state["active"]}

    def test(self, event):
        ref = event.get("id") or "builtin"
        if ref in ("builtin", "内置模型"):
            override = None
        else:
            with self._lock:
                state = self._load_unlocked()
                config = self._find_config(state, ref)
                if not config:
                    raise ValueError("没有这份配置：%s" % ref)
                override = {
                    "base": config["base"],
                    "key": config["key"],
                    "model": config["model"],
                }
        latency = self._ping_or_raise(override)
        return {"latency_ms": latency, **self._model_info(override)}
