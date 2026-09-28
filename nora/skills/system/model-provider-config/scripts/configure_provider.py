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

    data = json.load(sys.stdin)
    fields = {"provider", "model", "api_key", "base_url"}
    if (not isinstance(data, dict) or set(data) - fields
            or any(not isinstance(value, str) for value in data.values())):
        raise ValueError("输入应为包含供应商、模型、Key 和接口地址的 JSON 对象。")
    provider = data.get("provider", "").strip().lower()
    provider = {"openai": "openai-api", "google": "gemini"}.get(provider, provider)
    model = data.get("model", "").strip()
    base_url = data.get("base_url", "").strip()
    if base_url and provider != "custom":
        raise ValueError("自定义接口请使用 custom，避免将 Key 发给错误的供应商。")
    if provider == "deepseek" and not model:
        model = "deepseek-v4-flash"
    sys.path.insert(0, str(entry.parent))
    spec = importlib.util.spec_from_file_location("nora_skill_model_config", entry)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    if not hasattr(module, "local_selection_record"):
        raise ValueError("当前版本尚不支持技能配置模型，请先通过启动器更新。")
    if provider not in module.PROVIDER_KEYS:
        raise ValueError("不支持这个供应商；中转服务请选择 custom。")
    # Only stdin reaches the shared writer. No key-bearing argv or request file.
    import io
    previous_stdin = sys.stdin
    try:
        sys.stdin = io.StringIO(json.dumps({
            "action": "save-local", "provider": provider, "model": model,
            "key": data.get("api_key", "").strip(), "baseUrl": base_url,
            "keyEnv": module.PROVIDER_KEYS[provider],
        }))
        module.main()
    finally:
        sys.stdin = previous_stdin
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
