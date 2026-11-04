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


def _timed_out_write(error):
    seen = set()
    timeout_seen = False
    for _ in range(4):
        if error is None:
            return timeout_seen
        if id(error) in seen:
            return False
        seen.add(id(error))
        response = getattr(error, "response", None)
        statuses = (getattr(response, "status_code", None), getattr(error, "status", None))
        if any(type(status) is int and 400 <= status <= 599 for status in statuses):
            return False
        if isinstance(error, TimeoutError):
            timeout_seen = True
        error = error.__cause__ or (None if error.__suppress_context__ else error.__context__)
    # A timeout may wrap a definite refusal. Verify only after the complete
    # bounded chain is checked; cycles and unexplored causes stay uncertain.
    return timeout_seen and error is None


async def initialize(home, user_id, client):
    target = receipt_path(home)
    if not user_id or account_id(home) != user_id:
        raise RuntimeError("当前 ClawChat 配对账号不完整，未修改资料。")
    if ready(home):
        return {"ok": True, "alreadyInitialized": True}
    before = profile_detail(await client.get_my_profile())
    verify_account(before, user_id)
    nickname = "诺拉"
    desired = {"nickname": nickname, "avatar_url": AVATAR_URL}
    # Read-back also recovers a successful PATCH interrupted before the receipt was saved.
    current_avatar = before.get("avatar_url") or before.get("avatarUrl")
    pending_write = None
    if before.get("nickname") != nickname or current_avatar != AVATAR_URL:
        try:
            await client.update_my_profile(**desired)
        except Exception as error:
            if not _timed_out_write(error):
                raise
            # A timed-out response does not prove that the server rejected the
            # write. Continue the existing verification GET; never resend PATCH.
            pending_write = error
    try:
        after = profile_detail(await client.get_my_profile())
        verify_account(after, user_id)
        if after.get("nickname") != nickname or (after.get("avatar_url") or after.get("avatarUrl")) != AVATAR_URL:
            raise RuntimeError("ClawChat 尚未保存诺拉的名字和头像，请重试。")
    except Exception as verification:
        if pending_write is None:
            raise
        # The bundled ClawChat exception is a frozen dataclass. Attach only
        # diagnostic metadata and raise outside the handler to keep its cause.
        secondary = [*getattr(pending_write, "secondary_errors", ()), verification]
        object.__setattr__(pending_write, "secondary_errors", secondary)
    else:
        save_json(target, {"schema": 1, "userId": user_id, "verified": True, **desired})
        return {"ok": True, "alreadyInitialized": False}
    raise pending_write


def main():
    home = Path(sys.argv[1]).resolve()
    if ready(home):
        return {"ok": True, "alreadyInitialized": True}
    try:
        from .operation_cli import ensure_operation
    except ImportError:
        from operation_cli import ensure_operation
    ensure_operation('pair', nora_home=os.environ.get('NORA_TAVERN_HOME') or home.parent)
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


def failure_result(error):
    try:
        from .error_diagnostics import exception_diagnostic
    except ImportError:
        from error_diagnostics import exception_diagnostic
    detail = exception_diagnostic(error, project_root=Path(__file__).resolve().parent)
    def project(value, original=None):
        # Request bodies, URLs and plugin exception messages may contain the
        # paired token. Keep type/status and our source locations only.
        value['message'] = f"ClawChat 资料同步失败（{value['name']}）。"
        response = getattr(original, 'response', None)
        status = getattr(response, 'status_code', None) or getattr(original, 'status', None)
        if type(status) is int and 400 <= status <= 599:
            value['code'] = status
        if isinstance(value.get('cause'), dict):
            cause = getattr(original, '__cause__', None) or getattr(original, '__context__', None)
            project(value['cause'], cause)
        for item in value.get('secondaryErrors', []):
            project(item['error'])
    project(detail, error)
    return {'ok': False, 'error': 'ClawChat 已配对，但诺拉的名字和头像未完成同步。配对已保留，请重新检查连接。',
            'diagnostic': detail}


if __name__ == "__main__":
    try:
        result = main()
    except Exception as error:
        result = failure_result(error)
    print(json.dumps(result, ensure_ascii=False))
