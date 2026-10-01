import { addLocaleData, translate as tr, t } from '../../engine/sillytavern/public/scripts/nora-i18n/core.js';

const backupMessages = {
    '当前聊天': 'Current chat', '全部世界': 'All worlds', '筛选聊天备份': 'Filter chat backups',
    '${0} 条消息': '${0} messages', '消息数未读取': 'Message count unavailable', '无聊天消息': 'No chat messages',
    '查看备份 ${0}': 'View backup ${0}', '管理': 'Manage',
    '完成管理': 'Done', '保留此备份': 'Keep this backup', '取消保留': 'Stop keeping this backup', '已保留': 'Kept',
    '删除此备份': 'Delete this backup', '返回备份列表': 'Back to backups', '备份详情': 'Backup details',
    '仅恢复聊天记录及消息附带数据，不更改角色卡、世界书或库。': 'Restore chat history and message metadata only; cards, worldbooks and libraries are unchanged.',
    '此备份的目标世界已不可用，只能查看或下载。': 'The target world is unavailable. This backup can only be viewed or downloaded.',
    '保留的备份不会自动清理。': 'Kept backups are excluded from automatic cleanup.',
    '聊天内容无法读取，可下载原文件检查。': 'Chat content could not be read. Download the original file to inspect it.',
    '内容较大，未展开正文。可下载完整备份。': 'Content is too large to display. The complete backup can be downloaded.',
    '仅预览最后 ${0} 条消息，完整内容保留在备份中。': 'Showing the last ${0} messages only. The backup retains the complete content.',
    '部分长消息已截短，完整内容保留在备份中。': 'Some long messages are shortened here. The backup retains their complete content.',
    '未知发言者': 'Unknown speaker', '备份信息': 'Backup information',
    '时间未知': 'Unknown time', '聊天备份': 'Chat backups', '删除所选（${0}）': 'Delete selected (${0})',
    '选择备份 ${0}': 'Select backup ${0}', '未在当前列表中的世界': 'World not in the current list',
    '旧格式聊天': 'Legacy chat',
    '会话：${0}': 'Session: ${0}',
    '变量更新已确认': 'Variable update confirmed', '变量更新中': 'Variable update pending',
    '变量更新未完成': 'Variable update incomplete', '变量状态未确认': 'Variable state unconfirmed',
    '下载': 'Download', '恢复聊天': 'Restore chat', '核实恢复结果': 'Verify restore result',
    '备份整理暂未完成，当前聊天不受影响，系统稍后重试。': 'Backup maintenance is pending. Your chat is unaffected; the system will retry.',
    '正在读取备份…': 'Loading backups...', '刷新': 'Refresh',
    '每会话最多 ${0} 份，保留 ${1} 天。保留的备份不自动删除。': 'Up to ${0} backups per session, retained for ${1} days. Kept backups are not automatically deleted.',
    '自动备份已关闭。': 'Automatic backups are disabled.', '等待备份：${0}': 'Pending backups: ${0}',
    '已超出备份预算，暂停新增。聊天保存不受影响。': 'Backup budget exceeded; new backups are paused. Chat saving is unaffected.',
    '近期备份异常，不代表聊天保存失败：': 'Recent backup errors do not mean chat saving failed: ',
    '部分备份无法验证，已保留，不参与自动清理。': 'Unverifiable backups are retained and excluded from automatic cleanup.',
    '重新加载页面': 'Reload page', '暂无可管理的新备份。': 'No managed backups yet.',
    '旧备份及未受管文件（${0}）· 仅预览': 'Legacy and unmanaged backups (${0}) - preview only',
    '恢复这份聊天备份？': 'Restore this chat backup?',
    '先保护当前聊天，再用选定备份替换该会话。保护失败则不会覆盖。请先保留其他页面尚未保存的内容。': 'Protect the current chat before replacing this session. If protection fails, nothing is overwritten. Preserve unsaved content on other pages first.',
    '消息：${0} → ${1}；候选回复：${2}。': 'Messages: ${0} to ${1}; alternative replies: ${2}.',
    '恢复消息、消息附带的变量和候选回复；不替换卡片、世界书或库原件。': 'Restore messages, their variables and alternative replies; cards, worldbooks and library originals stay unchanged.',
    '已记录变量更新成功，但不代表完整世界存档。': 'Variable update success was recorded; this is not a complete world save.',
    '变量状态未确认或未完成，只恢复备份中实际存在的数据，不自动补齐。': 'Variable state is unconfirmed or incomplete. Only stored data is restored; missing data is not filled in.',
    '旧压缩账本失效；本次不调用模型，继续聊天后按原文重新积累。': 'Old compressed memory is invalidated. No model is called now; memory accumulates from original history when chatting continues.',
    '恢复后请保留未发送的输入，再主动重新加载页面；其他打开该会话的页面也需重新载入。': 'After restoring, preserve unsent input and reload this page and any other page viewing this session.',
    '保护并恢复': 'Protect and restore',
    '聊天已恢复。请先保留未发送的输入，再重新加载页面查看结果。': 'Chat restored. Preserve unsent input, then reload to see the result.',
    '摘要同步待重试，聊天已保存。': 'Summary synchronization is pending; the chat is saved.',
    '恢复结果尚未确认，请点击“核实恢复结果”；不要重复创建新的恢复请求。': 'Restore is not yet confirmed. Use Verify restore result; do not create a new restore request.',
    '该会话仍在生成、保存或处理账本，可能来自其他页面。请等待完成后再恢复。': 'This session is generating, saving or processing memory, possibly on another page. Wait before restoring.',
    '聊天或备份已变化，本次未恢复。请重新预览并确认。': 'Chat or backup changed; nothing was restored. Preview and confirm again.',
    '无法保护当前聊天，本次未恢复。请检查备份空间和权限后重试。': 'Current chat could not be protected; nothing was restored. Check backup space and permissions.',
    '目标世界或会话已不可用，不能用聊天备份重建世界。': 'The target world or session is unavailable. A chat backup cannot rebuild a world.',
    '删除所选聊天备份？': 'Delete selected chat backups?',
    '将永久删除 ${0} 份备份（${1}）。不删除当前聊天、世界或库原件。': 'Permanently delete ${0} backups (${1}). Current chats, worlds and library originals stay unchanged.',
    '永久删除': 'Delete permanently', '已删除 ${0} 份备份，无法通过本页面恢复。': 'Deleted ${0} backups. This page cannot undo deletion.',
    '另有 ${0} 份未删除：': '${0} backups were not deleted: ', '列表刷新失败，请刷新后继续管理。': 'Could not refresh the list. Refresh before continuing.',
    '旧文件仅预览，不自动删除；时间为文件修改时间，不能视为创建时间。': 'Legacy files are preview-only and not automatically deleted. Times are modification times, not creation times.',
    '扫描未完整完成，以下只是已读到的部分。': 'Scan incomplete; only collected results are shown.', '仅显示前 50 项。': 'Showing the first 50 items only.',
};

const bytes = value => `${(Number(value || 0) / 1048576).toFixed(2)} MiB`;
const time = value => Number.isFinite(Number(value)) ? new Date(Number(value)).toLocaleString() : tr('时间未知');

export function createBackupController({ dialogs, select, selectAll, escapeHtml: esc, headers,
    worlds = () => [], activeScope = () => null, fetchImpl = globalThis.fetch, saveFile = downloadFile, reloadPage = () => globalThis.location.reload() }) {
    addLocaleData('en', backupMessages);
    async function request(action, body = {}, binary = false) {
        const response = await fetchImpl(`/api/backups/chat/${action}`, { method: 'POST', headers: headers(), body: JSON.stringify(body) });
        if (response.ok && binary) return response.blob();
        const result = await response.json();
        if (!response.ok) throw Object.assign(new Error(result.error || 'NORA_BACKUP_OPERATION_FAILED'), { status: response.status });
        return result;
    }

    async function open() {
        const modal = dialogs.open(tr('聊天备份'), '<div class="nora-backup-manager"></div>', 'nora-detail-modal nora-plain-sheet');
        const host = select('.nora-backup-manager', modal);
        const scope = activeScope();
        let busy = false, ready = false, data, page = 0, pendingRestore = null, viewed = null, managing = false;
        let notice = '', errorMessage = '', reloadAvailable = false;
        let filter = scope?.worldId && scope?.sessionId ? 'current' : 'all';
        const selected = new Set();
        const alive = () => host.isConnected;
        const filtered = () => (data?.snapshots || []).filter(item => filter === 'all'
            || (filter === 'current' ? item.worldId === scope?.worldId && item.sessionId === scope?.sessionId : item.worldId === filter));
        const messageCount = item => Number.isSafeInteger(item.messageCount) && item.messageCount >= 0
            ? t`${item.messageCount} 条消息` : tr('消息数未读取');
        const mvuLabel = item => tr(({ confirmed: '变量更新已确认', pending: '变量更新中', incomplete: '变量更新未完成' })[item.mvuState] || '变量状态未确认');
        dialogs.setCloseGuard(() => !busy && !pendingRestore);
        function controls() {
            if (!alive()) return;
            selectAll('button', host).forEach(button => { button.disabled = busy; });
            selectAll('[data-backup-view]', host).forEach(button => { button.disabled = busy || !ready; });
            selectAll('[data-backup-select]', host).forEach(input => {
                input.disabled = busy || !ready || !!pendingRestore || data?.snapshots.find(item => item.id === input.dataset.backupSelect)?.protected === true;
            });
            selectAll('[data-backup-protect], [data-backup-remove]', host).forEach(button => {
                button.disabled = busy || !ready || !!pendingRestore || button.dataset.backupRemove !== undefined
                    && data?.snapshots.find(item => item.id === button.dataset.backupRemove)?.protected === true;
            });
            const filterInput = select('[data-backup-filter]', host);
            if (filterInput) filterInput.disabled = busy;
            selectAll('[data-backup-restore]', host).forEach(button => {
                button.disabled = busy || !!pendingRestore || !ready;
                button.textContent = tr(pendingRestore?.id === button.dataset.backupRestore ? '核实恢复结果' : '恢复聊天');
            });
            const remove = select('[data-backup-delete]', host);
            if (remove) { remove.disabled = busy || !ready || !!pendingRestore || !selected.size; remove.textContent = t`删除所选（${selected.size}）`; }
            const previous = select('[data-backup-prev]', host), next = select('[data-backup-next]', host);
            if (previous) previous.disabled = busy || page === 0;
            if (next) next.disabled = busy || (page + 1) * 20 >= filtered().length;
        }
        function error(message) {
            errorMessage = String(message);
            if (alive()) select('[data-backup-error]', host).textContent = errorMessage;
        }
        function showResult(message) {
            notice = message;
            if (alive()) select('[data-backup-result]', host).textContent = notice;
        }
        function render() {
            const names = new Map(worlds().map(world => [world.id, world.name]));
            const snapshots = filtered();
            const name = item => names.get(item.worldId) || (item.worldId ? tr('未在当前列表中的世界') : tr('旧格式聊天'));
            const session = item => scope?.worldId === item.worldId && scope?.sessionId === item.sessionId
                ? tr('当前聊天') : t`会话：${item.sessionId || tr('旧格式聊天')}`;
            const detailActions = item => `<div class="nora-backup-detail-actions"><button type="button" class="nora-backup-view" data-backup-download="${esc(item.id)}"><i class="fa-solid fa-download" aria-hidden="true"></i>${tr('下载')}</button><button type="button" class="nora-backup-view" data-backup-protect="${esc(item.id)}" aria-pressed="${item.protected}"><i class="fa-${item.protected ? 'solid' : 'regular'} fa-bookmark" aria-hidden="true"></i>${tr(item.protected ? '取消保留' : '保留此备份')}</button><button type="button" class="nora-backup-view nora-backup-danger" data-backup-remove="${esc(item.id)}"><i class="fa-solid fa-trash" aria-hidden="true"></i>${tr('删除此备份')}</button></div>`;
            page = Math.min(page, Math.max(0, Math.ceil(snapshots.length / 20) - 1));
            const row = item => `<div class="nora-backup-row" data-backup-row="${esc(item.id)}">
                ${managing ? `<input type="checkbox" data-backup-select="${esc(item.id)}" aria-label="${esc(t`选择备份 ${time(item.createdAt)}`)}" ${selected.has(item.id) ? 'checked' : ''}>` : ''}
                <button type="button" class="nora-backup-open" data-backup-view="${esc(item.id)}" aria-label="${esc(t`查看备份 ${time(item.createdAt)}`)}"><span class="nora-backup-info"><strong>${esc(time(item.createdAt))}</strong><small>${filter === 'all' ? `${esc(name(item))} · ` : ''}${filter !== 'current' ? `${esc(session(item))} · ` : ''}${esc(messageCount(item))}${item.protected ? ` · ${tr('已保留')}` : ''}</small>
                ${item.preview ? `<span class="nora-backup-excerpt">${esc(item.preview)}</span>` : ''}</span><i class="fa-solid fa-chevron-right" aria-hidden="true"></i></button></div>`;
            const failures = [...new Set((data?.status?.recent || []).filter(item => item.status === 'failed').map(item => item.code))];
            const failureText = failures.map(code => code === 'NORA_BACKUP_UPGRADE_PENDING'
                ? tr('备份整理暂未完成，当前聊天不受影响，系统稍后重试。') : code).join('、');
            const detail = viewed && data?.snapshots.find(item => item.id === viewed.id);
            const refreshButton = `<button type="button" class="nora-icon-button" data-backup-refresh title="${tr('刷新')}" aria-label="${tr('刷新')}"><i class="fa-solid fa-rotate-right" aria-hidden="true"></i></button>`;
            const policy = data ? `<section class="nora-backup-policy" aria-label="${tr('备份信息')}"><div class="nora-backup-policy-heading"><h3>${tr('备份信息')}</h3><span>${bytes(data.totalBytes)} / ${bytes(data.policy.maxBytes)}</span></div><p class="nora-model-note">${esc(t`每会话最多 ${data.policy.maxPerSession} 份，保留 ${data.policy.maxAgeDays} 天。保留的备份不自动删除。`)}</p>${data.status?.enabled === false || data.status?.pending ? `<p class="nora-model-note">${data.status?.enabled === false ? tr('自动备份已关闭。') : ''}${data.status?.pending ? ` ${esc(t`等待备份：${data.status.pending}`)}` : ''}</p>` : ''}</section>` : '';
            host.innerHTML = `${policy}${detail ? `<div class="nora-backup-toolbar"><button type="button" class="nora-backup-view" data-backup-back><i class="fa-solid fa-arrow-left" aria-hidden="true"></i>${tr('返回备份列表')}</button>${refreshButton}</div>` : `<div class="nora-backup-toolbar"><select class="nora-backup-filter" data-backup-filter aria-label="${tr('筛选聊天备份')}">${scope?.worldId && scope?.sessionId ? `<option value="current" ${filter === 'current' ? 'selected' : ''}>${tr('当前聊天')}</option>` : ''}<option value="all" ${filter === 'all' ? 'selected' : ''}>${tr('全部世界')}</option>${[...names].map(([id, title]) => `<option value="${esc(id)}" ${filter === id ? 'selected' : ''}>${esc(title)}</option>`).join('')}</select><button type="button" class="nora-backup-view" data-backup-manage aria-pressed="${managing}">${tr(managing ? '完成管理' : '管理')}</button></div>${managing || !ready ? `<div class="nora-backup-management">${refreshButton}${managing && data?.legacyFiles ? `<button type="button" class="nora-backup-view" data-backup-legacy>${esc(t`旧备份及未受管文件（${data.legacyFiles}）· 仅预览`)}</button>` : ''}${managing ? '<button type="button" class="nora-library-action nora-library-action-danger" data-backup-delete></button>' : ''}</div>` : ''}`}
                ${data?.overBudget ? `<p role="status">${tr('已超出备份预算，暂停新增。聊天保存不受影响。')}</p>` : ''}
                ${failures.length ? `<p role="status">${tr('近期备份异常，不代表聊天保存失败：')}${esc(failureText)}</p>` : ''}
                ${data?.warnings?.length ? `<p role="status">${tr('部分备份无法验证，已保留，不参与自动清理。')}</p>` : ''}
                <p role="alert" data-backup-error>${esc(errorMessage || (pendingRestore ? tr('恢复结果尚未确认，请点击“核实恢复结果”；不要重复创建新的恢复请求。') : ''))}</p>
                ${pendingRestore ? `<button type="button" class="nora-library-action" data-backup-verify>${tr('核实恢复结果')}</button>` : ''}
                <p role="status" class="nora-model-note" data-backup-result>${esc(notice)}</p>
                <button type="button" class="nora-library-action" data-backup-reload ${reloadAvailable ? '' : 'hidden'}>${tr('重新加载页面')}</button>
                ${detail ? `<div class="nora-backup-info"><strong>${esc(name(detail))}</strong><small>${esc(t`会话：${detail.sessionId || tr('旧格式聊天')}`)}</small><small>${esc(time(detail.createdAt))} · ${esc(messageCount({ ...detail, messageCount: viewed.messageCount ?? detail.messageCount }))} · ${bytes(detail.bytes)}${detail.protected ? ` · ${tr('已保留')}` : ''}</small><small>${esc(mvuLabel(detail))}</small></div>
                    <div class="nora-backup-transcript" aria-label="${tr('备份详情')}">${viewed.large ? `<p>${tr('内容较大，未展开正文。可下载完整备份。')}</p>` : viewed.invalid ? `<p>${tr('聊天内容无法读取，可下载原文件检查。')}</p>` : `${viewed.omitted ? `<p class="nora-model-note">${esc(t`仅预览最后 ${viewed.messages.length} 条消息，完整内容保留在备份中。`)}</p>` : ''}${viewed.shortened ? `<p class="nora-model-note">${tr('部分长消息已截短，完整内容保留在备份中。')}</p>` : ''}${viewed.messages.map(message => `<div class="nora-backup-message"><small>${esc(message.name || tr('未知发言者'))}</small><p>${esc(message.mes)}</p></div>`).join('') || `<p>${tr('无聊天消息')}</p>`}`}</div>
                    <div class="nora-backup-restore-bar"><p class="nora-model-note">${tr('仅恢复聊天记录及消息附带数据，不更改角色卡、世界书或库。')}</p>${names.has(detail.worldId) && detail.sessionId ? !viewed.invalid ? `<button type="button" class="nora-library-action" data-backup-restore="${esc(detail.id)}">${tr('恢复聊天')}</button>` : '' : `<p class="nora-model-note">${tr('此备份的目标世界已不可用，只能查看或下载。')}</p>`}</div>${detailActions(detail)}`
                    : `<div data-backup-list>${snapshots.slice(page * 20, (page + 1) * 20).map(row).join('') || (data ? `<p>${tr('暂无可管理的新备份。')}</p>` : `<p>${tr('正在读取备份…')}</p>`)}</div>
                    ${snapshots.length > 20 ? `<div class="nora-backup-pagination"><button type="button" class="nora-icon-button" data-backup-prev title="${tr('上一页')}" aria-label="${tr('上一页')}"><i class="fa-solid fa-chevron-left" aria-hidden="true"></i></button><span>${page + 1} / ${Math.ceil(snapshots.length / 20)}</span><button type="button" class="nora-icon-button" data-backup-next title="${tr('下一页')}" aria-label="${tr('下一页')}"><i class="fa-solid fa-chevron-right" aria-hidden="true"></i></button></div>` : ''}
                    <div data-backup-legacy-list></div>`}`;
            select('[data-backup-refresh]', host)?.addEventListener('click', () => { if (!busy) return load(); });
            select('[data-backup-back]', host)?.addEventListener('click', () => { if (!busy) { viewed = null; render(); } });
            select('[data-backup-manage]', host)?.addEventListener('click', () => { if (!busy) { managing = !managing; selected.clear(); render(); } });
            select('[data-backup-filter]', host)?.addEventListener('change', event => {
                if (busy) return;
                filter = event.target.value; page = 0; selected.clear(); render();
            });
            selectAll('[data-backup-view]', host).forEach(button => button.addEventListener('click', () => action(async () => {
                if (!ready) return;
                const item = data.snapshots.find(item => item.id === button.dataset.backupView);
                if (item.bytes > 16 * 1024 * 1024) viewed = { id: item.id, sha256: item.sha256, large: true };
                else {
                    try {
                        let first = await request('read', { id: item.id, sha256: item.sha256, offset: Math.max(0, (item.messageCount || 0) - 40), limit: 20 });
                        const offset = Math.max(0, first.messageCount - 40);
                        if (first.offset !== offset) first = await request('read', { id: item.id, sha256: item.sha256, offset, limit: 20 });
                        const messages = [...first.messages];
                        if (first.hasMore) messages.push(...(await request('read', { id: item.id, sha256: item.sha256, offset: offset + 20, limit: 20 })).messages);
                        viewed = { id: item.id, sha256: item.sha256, messageCount: first.messageCount, omitted: first.messageCount > 40,
                            shortened: messages.some(message => message.truncated),
                            messages: messages.map(message => ({ name: message.name, mes: message.text })) };
                    } catch (cause) {
                        if (cause.message !== 'NORA_BACKUP_INVALID_RESTORE_CHAT') throw cause;
                        viewed = { id: item.id, sha256: item.sha256, invalid: true };
                    }
                }
                if (alive()) { render(); select('[data-backup-back]', host)?.focus(); }
            })));
            select('[data-backup-reload]', host).addEventListener('click', () => { if (!busy) reloadPage(); });
            selectAll('[data-backup-restore]', host).forEach(button => button.addEventListener('click', () => action(async () => {
                if (!ready) return;
                const item = data.snapshots.find(item => item.id === button.dataset.backupRestore);
                if (pendingRestore) return;
                if (!pendingRestore) {
                    const target = { id: item.id, worldId: item.worldId, sessionId: item.sessionId };
                    const preview = await request('restore-preview', target);
                    if (!alive()) return;
                    const approved = await dialogs.confirm({ title: tr('恢复这份聊天备份？'),
                        body: `${names.get(item.worldId)} · ${t`会话：${item.sessionId}`} · ${time(preview.snapshot.createdAt)}\n${t`消息：${preview.current.messageCount} → ${preview.snapshot.messageCount}；候选回复：${preview.snapshot.swipeCount}。`}\n${tr('先保护当前聊天，再用选定备份替换该会话。保护失败则不会覆盖。请先保留其他页面尚未保存的内容。')}`,
                        details: [`${names.get(item.worldId)} · ${t`会话：${item.sessionId}`} · ${time(preview.snapshot.createdAt)}`,
                            ...(scope?.worldId === item.worldId && scope?.sessionId === item.sessionId ? [tr('当前聊天')] : []),
                            tr('恢复消息、消息附带的变量和候选回复；不替换卡片、世界书或库原件。'),
                            tr(preview.snapshot.mvuState === 'confirmed' ? '已记录变量更新成功，但不代表完整世界存档。' : '变量状态未确认或未完成，只恢复备份中实际存在的数据，不自动补齐。'),
                            tr('旧压缩账本失效；本次不调用模型，继续聊天后按原文重新积累。'),
                            tr('恢复后请保留未发送的输入，再主动重新加载页面；其他打开该会话的页面也需重新载入。')],
                        confirmLabel: tr('保护并恢复'), tone: 'danger', restoreSheet: true });
                    if (!approved || !alive()) return;
                    pendingRestore = { ...target, expectedRevision: preview.current.revision, sha256: preview.snapshot.sha256 };
                }
                await verifyRestore();
            })));
            select('[data-backup-verify]', host)?.addEventListener('click', () => action(verifyRestore));
            async function verifyRestore() {
                if (!pendingRestore) return;
                try {
                    const result = await request('restore', pendingRestore);
                    if (!['restored', 'already-restored'].includes(result.status)
                        || result.worldId !== pendingRestore.worldId || result.sessionId !== pendingRestore.sessionId) throw new Error('NORA_BACKUP_RESTORE_UNCONFIRMED');
                    pendingRestore = null;
                    await load();
                    if (!alive()) return;
                    showResult(tr('聊天已恢复。请先保留未发送的输入，再重新加载页面查看结果。')
                        + (result.projectionPending ? ` ${tr('摘要同步待重试，聊天已保存。')}` : ''));
                    reloadAvailable = true;
                    select('[data-backup-reload]', host).hidden = false;
                } catch (cause) {
                    const code = cause.message;
                    if (cause.status >= 400 && cause.status < 500) pendingRestore = null;
                    render();
                    if (pendingRestore) throw new Error(tr('恢复结果尚未确认，请点击“核实恢复结果”；不要重复创建新的恢复请求。'));
                    if (['NORA_CHAT_OPERATION_BUSY', 'NORA_LEDGER_BUSY'].includes(code)) throw new Error(tr('该会话仍在生成、保存或处理账本，可能来自其他页面。请等待完成后再恢复。'));
                    if (code === 'NORA_BACKUP_RESTORE_STALE') throw new Error(tr('聊天或备份已变化，本次未恢复。请重新预览并确认。'));
                    if (code === 'NORA_BACKUP_REQUIRED') throw new Error(tr('无法保护当前聊天，本次未恢复。请检查备份空间和权限后重试。'));
                    if (['NORA_LEDGER_SESSION_UNAVAILABLE', 'NORA_BACKUP_RESTORE_TARGET_UNAVAILABLE'].includes(code)) throw new Error(tr('目标世界或会话已不可用，不能用聊天备份重建世界。'));
                    throw cause;
                }
            }
            selectAll('[data-backup-select]', host).forEach(input => input.addEventListener('change', () => {
                if (busy || input.disabled || !input.isConnected) return;
                if (input.checked) selected.add(input.dataset.backupSelect);
                else selected.delete(input.dataset.backupSelect);
                controls();
            }));
            selectAll('[data-backup-download]', host).forEach(button => button.addEventListener('click', () => action(async () => {
                const id = button.dataset.backupDownload;
                const blob = await request('snapshot', { id, sha256: data.snapshots.find(item => item.id === id).sha256 }, true);
                if (alive()) saveFile(blob, `chat_nora1_${id}.jsonl`);
            })));
            selectAll('[data-backup-protect]', host).forEach(button => button.addEventListener('click', () => action(async () => {
                if (!ready || pendingRestore) return;
                const item = data.snapshots.find(item => item.id === button.dataset.backupProtect);
                await request('protect', { id: item.id, sha256: item.sha256, protected: !item.protected });
                await load();
            })));
            async function deleteBackups(targets) {
                if (!ready || pendingRestore) return;
                if (!targets.length) return;
                const approved = await dialogs.confirm({ title: tr('删除所选聊天备份？'),
                    body: t`将永久删除 ${targets.length} 份备份（${bytes(targets.reduce((sum, item) => sum + item.bytes, 0))}）。不删除当前聊天、世界或库原件。`,
                    details: targets.map(item => `${name(item)} · ${t`会话：${item.sessionId || tr('旧格式聊天')}`} · ${time(item.createdAt)} · ${messageCount(item)}`),
                    confirmLabel: tr('永久删除'), tone: 'danger', restoreSheet: true });
                if (!approved || !alive()) return;
                let deleted = 0;
                const failures = [];
                for (const item of targets) {
                    try { await request('remove', { id: item.id, sha256: item.sha256 }); deleted++; selected.delete(item.id); if (viewed?.id === item.id) viewed = null; }
                    catch (cause) { failures.push(`${item.id}: ${cause.message}`); }
                }
                const refreshed = await load();
                if (alive()) showResult(t`已删除 ${deleted} 份备份，无法通过本页面恢复。`);
                error((failures.length ? `${t`另有 ${failures.length} 份未删除：`}${failures.join('；')}` : '')
                    + (refreshed ? '' : ` ${tr('列表刷新失败，请刷新后继续管理。')}`));
            }
            select('[data-backup-delete]', host)?.addEventListener('click', () => action(() => deleteBackups(
                data.snapshots.filter(item => selected.has(item.id) && !item.protected))));
            selectAll('[data-backup-remove]', host).forEach(button => button.addEventListener('click', () => action(() => deleteBackups(
                data.snapshots.filter(item => item.id === button.dataset.backupRemove && !item.protected)))));
            select('[data-backup-prev]', host)?.addEventListener('click', () => { if (!busy && page > 0) { page--; render(); } });
            select('[data-backup-next]', host)?.addEventListener('click', () => { if (!busy && (page + 1) * 20 < snapshots.length) { page++; render(); } });
            select('[data-backup-legacy]', host)?.addEventListener('click', () => action(async () => {
                const inventory = await request('inventory');
                if (!alive()) return;
                const managedNames = new Set(data.snapshots.map(item => `chat_nora1_${item.id}.jsonl`));
                const legacy = inventory.backups.filter(item => !managedNames.has(item.name));
                select('[data-backup-legacy-list]', host).innerHTML = `<p class="nora-model-note">${tr('旧文件仅预览，不自动删除；时间为文件修改时间，不能视为创建时间。')} ${!inventory.complete ? tr('扫描未完整完成，以下只是已读到的部分。') : ''} ${legacy.length > 50 ? tr('仅显示前 50 项。') : ''}</p>`
                    + legacy.slice(0, 50).map(item => `<div class="nora-backup-info"><strong>${esc(item.name)}</strong><small>${esc(time(item.modifiedAt))} · ${bytes(item.bytes)} · ${tr(item.owner?.confidence === 'identified' ? '归属已识别' : '归属未确认')}</small></div>`).join('');
            }));
            controls();
        }
        async function action(operation) {
            if (busy || !alive()) return;
            busy = true;
            controls();
            error('');
            showResult('');
            try { await operation(); }
            catch (cause) { error(cause.message); }
            finally { busy = false; controls(); }
        }
        async function load() {
            busy = true;
            ready = false;
            controls();
            try {
                const result = await request('managed');
                if (!alive()) return;
                data = result;
                errorMessage = '';
                ready = true;
                if (viewed && !data.snapshots.some(item => item.id === viewed.id && item.sha256 === viewed.sha256)) viewed = null;
                for (const id of selected) if (!data.snapshots.some(item => item.id === id && !item.protected)) selected.delete(id);
                render();
                return true;
            } catch (cause) {
                errorMessage = `${tr('列表刷新失败，请刷新后继续管理。')} ${cause.message}`;
                if (alive()) render();
                return false;
            }
            finally { busy = false; controls(); }
        }
        render();
        await load();
    }
    return Object.freeze({ open });
}

function downloadFile(blob, name) {
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = name;
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
}
