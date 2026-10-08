import { scopeKey } from './history.js';
import { addLocaleData, t } from '../nora-i18n/core.js';

addLocaleData('en', {
    '备份空间不足，请在“数据 → 聊天备份”取消保留或删除不需要的备份。正常操作可继续。': 'Backup storage is full. Unkeep or delete unwanted backups in Data > Chat backups. Normal operations can continue.',
    '本次未新增回滚备份，正常操作可继续。详情见“数据 → 聊天备份”。': 'No new rollback backup. Normal operations can continue. See Data > Chat backups.',
    '备份提醒': 'Backup reminder',
});

const registry = globalThis[Symbol.for('nora.story-ledger')];
const notices = registry.backupNotices ??= new Map();

export function notifyBackupWarning(scope, warning) {
    const key = scopeKey(scope);
    if (!warning) { notices.delete(key); return; }
    if (warning.code === 'NORA_BACKUP_BUSY') return;
    const last = notices.get(key);
    if (last?.code === warning.code && Date.now() - last.at < 300000) return;
    notices.set(key, { code: warning.code, at: Date.now() });
    const message = warning.code === 'NORA_BACKUP_BUDGET_EXCEEDED'
        ? t`备份空间不足，请在“数据 → 聊天备份”取消保留或删除不需要的备份。正常操作可继续。`
        : t`本次未新增回滚备份，正常操作可继续。详情见“数据 → 聊天备份”。`;
    globalThis.toastr?.warning(message, t`备份提醒`, { timeOut: 10000, preventDuplicates: true });
}
