"""Shared owner-facing guidance for a successfully installed release.

This module only formats output. Restarting Hermes belongs to its native
ClawChat command, not to the updater process running inside that gateway.
"""


def installation_guidance(receipt, *, isolated=False):
    if receipt.get('status') == 'already-installed':
        return {'next_step': '已是同一发布版本，未停服、未重复迁移或修改模型。网关是否激活需另行核对。'}
    if receipt.get('status') != 'installed-awaiting-hermes-reload':
        raise ValueError('Update did not complete: receipt is not an installed release.')
    notes = []
    data = receipt.get('dataImport', {})
    if data.get('status') == 'partial':
        notes.append(f"旧数据已导入 {data['worldsImported']} 个世界；另有 {data['deferredCount']} 项保留待转换，未阻止程序更新。"
                     f"原始备份：{data['backupPath']}；逐项清单：{data['reportPath']}。"
                     '待转换数据不等于已能通过角色卡导入按钮直接载入。')
    if receipt.get('liveware', {}).get('status') == 'external-entry-unverified':
        notes.append('两个 App 的绑定和名称已核对，但公网入口尚未验证通过；请检查 ClawChat 访问和网络，不代表更新回滚。')
    suffix = ''.join(notes)
    if isolated:
        return {'next_step': '隔离更新验证已完成，无需重启正在使用的 Hermes 网关。' + suffix}
    return {
        'restartCommand': '/restart',
        'restartSurface': 'ClawChat',
        'next_step': 'Tavern 更新已安装。请在 ClawChat 与若棠的对话中发送 /restart，'
                     '重启 Hermes 并重新加载 MCP 和技能；等待重启成功通知后继续使用。'
                     '更新器不会自动执行重启。' + suffix,
    }
