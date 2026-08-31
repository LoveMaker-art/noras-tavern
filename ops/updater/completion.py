"""Shared owner-facing guidance for a successfully installed release.

This module only formats output. Restarting Hermes belongs to its native
ClawChat command, not to the updater process running inside that gateway.
"""


def installation_guidance(receipt, *, isolated=False):
    if receipt.get('status') == 'already-installed':
        return {'next_step': '已是同一发布版本，未停服、未重复迁移或修改模型。网关是否激活需另行核对。'}
    if receipt.get('status') != 'installed-awaiting-hermes-reload':
        raise ValueError('Update did not complete: receipt is not an installed release.')
    if isolated:
        return {'next_step': '隔离更新验证已完成，无需重启正在使用的 Hermes 网关。'}
    return {
        'restartCommand': '/restart',
        'restartSurface': 'ClawChat',
        'next_step': 'Tavern 更新已安装。请在 ClawChat 与若棠的对话中发送 /restart，'
                     '重启 Hermes 并重新加载 MCP 和技能；等待重启成功通知后继续使用。'
                     '更新器不会自动执行重启。',
    }
