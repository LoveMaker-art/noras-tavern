"""Initialize the paired ClawChat account once, before the first greeting."""

import asyncio
import json
import os
from pathlib import Path
import sys

try:
    from .nora_system import read_json, save_json
except ImportError:
    from nora_system import read_json, save_json


# The same public Nora portrait used by the reference deployment's greeting.
AVATAR_URL = "https://media.clawling.chat/uploads/2026/07/10/3812c67dca81ffcdcd6d1e29.png"


def account_id(home):
    from dotenv import dotenv_values
    import yaml
    try:
        values = dotenv_values(Path(home) / ".env")
        config = yaml.safe_load((Path(home) / "config.yaml").read_text(encoding="utf-8")) or {}
        extra = config.get("platforms", {}).get("clawchat", {}).get("extra", {})
        return str(values.get("CLAWCHAT_USER_ID") or extra.get("user_id") or "").strip()
    except (OSError, ValueError, AttributeError, yaml.YAMLError):
        return ""


def receipt_path(home):
    root = Path(home).resolve()
    target = root / "clawchat/nora-profile.json"
    if not target.resolve().is_relative_to(root):
        raise RuntimeError("Nora 资料记录必须位于当前隔离目录内。")
    return target


def ready(home):
    user_id = account_id(home)
    record = read_json(receipt_path(home))
    return bool(user_id and record.get("schema") == 1
                and record.get("userId") == user_id and record.get("verified") is True)


def profile_detail(payload):
    if not isinstance(payload, dict) or payload.get("error"):
        raise RuntimeError("无法读取 ClawChat 联系人资料。")
    value = payload.get("user", payload)
    if not isinstance(value, dict):
        raise RuntimeError("ClawChat 联系人资料格式不正确。")
    return value


def verify_account(profile, user_id):
    actual = profile.get("id") or profile.get("user_id") or profile.get("userId")
    if actual != user_id:
        raise RuntimeError("ClawChat 返回的账号与当前配对不一致，未修改资料。")


async def initialize(home, user_id, client):
    target = receipt_path(home)
    if not user_id or account_id(home) != user_id:
        raise RuntimeError("当前 ClawChat 配对账号不完整，未修改资料。")
    if ready(home):
        return {"ok": True, "alreadyInitialized": True}
    before = profile_detail(await client.get_my_profile())
    verify_account(before, user_id)
    owner = profile_detail(await client.get_agent_owner())
    locale = str(owner.get("locale") or "").strip().lower().replace("_", "-")
    nickname = "诺拉" if locale == "zh" or locale.startswith("zh-") else "Nora"
    desired = {"nickname": nickname, "avatar_url": AVATAR_URL}
    # Read-back also recovers a successful PATCH interrupted before the receipt was saved.
    current_avatar = before.get("avatar_url") or before.get("avatarUrl")
    if before.get("nickname") != nickname or current_avatar != AVATAR_URL:
        await client.update_my_profile(**desired)
    after = profile_detail(await client.get_my_profile())
    verify_account(after, user_id)
    if after.get("nickname") != nickname or (after.get("avatar_url") or after.get("avatarUrl")) != AVATAR_URL:
        raise RuntimeError("ClawChat 尚未保存诺拉的名字和头像，请重试。")
    save_json(target, {"schema": 1, "userId": user_id, "verified": True, **desired})
    return {"ok": True, "alreadyInitialized": False}


def main():
    home = Path(sys.argv[1]).resolve()
    if ready(home):
        return {"ok": True, "alreadyInitialized": True}
    # Never let credentials inherited from another installation select this account.
    for key in list(os.environ):
        if key.startswith("CLAWCHAT_"):
            del os.environ[key]
    sys.path.insert(0, str(home / "plugins/clawchat"))
    from clawchat_gateway.profile import load_profile_config
    from clawchat_gateway.api_client import ClawChatApiClient
    config = load_profile_config()
    if config.config_path.resolve().parent != home:
        raise RuntimeError("ClawChat 配置不属于当前安装。")
    client = ClawChatApiClient(base_url=config.base_url, token=config.token, user_id=config.user_id)
    return asyncio.run(initialize(home, config.user_id, client))


if __name__ == "__main__":
    try:
        result = main()
    except Exception:
        # Plugin exceptions can contain credential-bearing request diagnostics.
        result = {"ok": False, "error": "ClawChat 已配对，但诺拉的名字和头像未完成同步。配对已保留，请重试。"}
    print(json.dumps(result, ensure_ascii=False))
