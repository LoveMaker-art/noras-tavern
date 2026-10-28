#!/usr/bin/env python3
"""Adapt skill input to the installed Nora model configuration entrypoint."""
from __future__ import annotations

import importlib.util
import json
import os
from pathlib import Path
import sys


def configure() -> int:
    home_value = os.environ.get("HERMES_HOME", "")
    if not home_value or not Path(home_value).is_absolute():
        raise ValueError("未找到当前实例的 HERMES_HOME。")
    home = Path(home_value).resolve()
    if not Path(__file__).resolve().is_relative_to(home / "skills"):
        raise ValueError("技能不属于当前 Nora 实例。")
    if Path(sys.prefix).resolve() != (home / "hermes-agent/venv").resolve():
        raise ValueError("请使用当前 Nora 实例的 Hermes Python。")
    instance = json.loads((home / "nora-instance.json").read_text(encoding="utf-8"))
    root = home.parent
    tavern = Path(instance["installRoot"])
    if (instance.get("schema") != 1 or Path(instance["hermesHome"]).resolve() != home
            or Path(instance["noraHome"]).resolve() != root
            or not tavern.is_absolute() or not tavern.resolve().is_relative_to(root)
            or tavern.resolve() == root or tavern.resolve().is_relative_to(home)):
        raise ValueError("Nora 安装记录不匹配，未修改配置。")
    entry = tavern / "apps/tavern-ops/installer/model_config.py"
    if not entry.is_file() or not entry.resolve().is_relative_to(tavern.resolve()):
        raise ValueError("未找到本地模型配置程序，请先通过启动器更新。")

    original_stdin = sys.stdin
    data = json.loads(original_stdin.readline())
    fields = {"action", "provider", "model", "api_key", "base_url", "auth_mode"}
    if (not isinstance(data, dict) or set(data) - fields
            or any(not isinstance(value, str) for value in data.values())):
        raise ValueError("输入应为模型配置 JSON 对象。")
    action = data.get("action", "save")
    if action not in {"save", "catalog", "models", "inspect", "authenticate", "test"}:
        raise ValueError("不支持这个配置操作。")
    sys.path.insert(0, str(entry.parent))
    spec = importlib.util.spec_from_file_location("nora_skill_model_config", entry)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    if not hasattr(module, "local_selection_record"):
        raise ValueError("当前版本尚不支持技能配置模型，请先通过启动器更新。")
    provider = data.get("provider", "").strip()
    model = data.get("model", "").strip()
    # Keep the previously confirmed product default; other choices are read
    # from Hermes and are never guessed from the key or catalog order.
    if provider == "deepseek" and not model and action == "save":
        model = "deepseek-v4-flash"
    payload = {"action": "save-local" if action == "save" else action,
        "provider": provider, "model": model, "key": data.get("api_key", "").strip(),
        "baseUrl": data.get("base_url", "").strip(), "authMode": data.get("auth_mode", "key")}
    class Input:
        def __init__(self):
            self.first = json.dumps(payload) + "\n"
        def readline(self, *args):
            if self.first:
                value, self.first = self.first, ""
                return value
            return original_stdin.readline(*args)
    previous_argv = sys.argv
    try:
        sys.stdin = Input()
        # The shared entry, rather than this skill path, owns maintenance.
        sys.argv = [str(entry)]
        module.main()
    finally:
        sys.stdin = original_stdin
        sys.argv = previous_argv

    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(configure())
    except ValueError as error:
        # JSON parsing errors can include user input; report their class only.
        message = "输入或安装记录不是有效 JSON。" if isinstance(error, json.JSONDecodeError) else str(error)
        print(json.dumps({"ok": False, "error": message}, ensure_ascii=False))
        raise SystemExit(1)
    except Exception:
        print(json.dumps({"ok": False, "error": "无法读取当前实例，请检查安装是否完整。"}, ensure_ascii=False))
        raise SystemExit(1)
