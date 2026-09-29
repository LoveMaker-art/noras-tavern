import { translate as tr, t } from '../../engine/sillytavern/public/scripts/nora-i18n/core.js';

const bytes = value => `${(Number(value || 0) / 1048576).toFixed(2)} MiB`;
const time = value => Number.isFinite(Number(value)) ? new Date(Number(value)).toLocaleString() : tr('时间未知');

export function createBackupController({ dialogs, select, selectAll, escapeHtml: esc, headers,
    worlds = () => [], fetchImpl = globalThis.fetch, saveFile = downloadFile, reloadPage = () => globalThis.location.reload() }) {
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
        let busy = false, ready = false, data, page = 0, pendingRestore = null;
        const selected = new Set();
        const alive = () => host.isConnected;
        dialogs.setCloseGuard(() => !busy);
        function controls() {
            if (!alive()) return;
            selectAll('button', host).forEach(button => { button.disabled = busy; });
            selectAll('[data-backup-select]', host).forEach(input => {
                input.disabled = busy || !ready || data?.snapshots.find(item => item.id === input.dataset.backupSelect)?.protected === true;
            });
            selectAll('[data-backup-protect]', host).forEach(button => { button.disabled = busy || !ready || !!pendingRestore; });
            selectAll('[data-backup-restore]', host).forEach(button => {
                button.disabled = busy || !ready || !!pendingRestore && pendingRestore.id !== button.dataset.backupRestore;
                button.textContent = tr(pendingRestore?.id === button.dataset.backupRestore ? '核实恢复结果' : '恢复聊天');
            });
            const remove = select('[data-backup-delete]', host);
            if (remove) { remove.disabled = busy || !ready || !!pendingRestore || !selected.size; remove.textContent = t`删除所选（${selected.size}）`; }
            const previous = select('[data-backup-prev]', host), next = select('[data-backup-next]', host);
            if (previous) previous.disabled = busy || page === 0;
            if (next) next.disabled = busy || (page + 1) * 20 >= (data?.snapshots.length || 0);
        }
        function error(message) {
            if (alive()) select('[data-backup-error]', host).textContent = String(message);
        }
        function render() {
            const names = new Map(worlds().map(world => [world.id, world.name]));
            const snapshots = data?.snapshots || [];
            page = Math.min(page, Math.max(0, Math.ceil(snapshots.length / 20) - 1));
            const row = item => `<div class="nora-backup-row" data-backup-row="${esc(item.id)}">
                <input type="checkbox" data-backup-select="${esc(item.id)}" aria-label="${esc(t`选择备份 ${time(item.createdAt)}`)}" ${selected.has(item.id) ? 'checked' : ''} ${item.protected ? 'disabled' : ''}>
                <div class="nora-backup-info"><strong>${esc(names.get(item.worldId) || (item.worldId ? tr('未在当前列表中的世界') : tr('旧格式聊天')))}</strong>
                <small>${esc(time(item.createdAt))} · ${bytes(item.bytes)}${item.protected ? ` · ${tr('已保护')}` : ''}</small>
                <small>${tr('范围：聊天及消息附带数据，未验证完整恢复一致性')}</small>
                <small>${tr(({ confirmed: '变量更新已确认', pending: '变量更新中', incomplete: '变量更新未完成' })[item.mvuState] || '变量状态未确认')}</small>
                <details><summary>${tr('归属标识')}</summary><small>${esc(item.worldId || item.sessionKey || '')}<br>${esc(item.sessionId || '')}</small></details></div>
                <div class="nora-backup-actions"><button type="button" class="nora-secondary" data-backup-download="${esc(item.id)}">${tr('下载')}</button><button type="button" class="nora-secondary" data-backup-protect="${esc(item.id)}">${tr(item.protected ? '取消保护' : '保护')}</button>${names.has(item.worldId) && item.sessionId ? `<button type="button" class="nora-secondary" data-backup-restore="${esc(item.id)}">${tr('恢复聊天')}</button>` : ''}</div></div>`;
            const failures = [...new Set((data?.status?.recent || []).filter(item => item.status === 'failed').map(item => item.code))];
            host.innerHTML = `<p class="nora-model-note">${tr('所有世界的聊天备份。不是完整世界存档；仅可恢复仍存在的世界聊天，不替换卡片、世界书或库原件。')}</p>
                <div class="nora-backup-toolbar"><span>${data ? `${bytes(data.totalBytes)} / ${bytes(data.policy.maxBytes)}` : tr('正在读取备份…')}</span><button type="button" class="nora-secondary" data-backup-refresh>${tr('刷新')}</button></div>
                ${data ? `<p class="nora-model-note">${esc(t`每会话最多 ${data.policy.maxPerSession} 份，保留 ${data.policy.maxAgeDays} 天。保护的备份不自动删除。`)}${data.status?.enabled === false ? ` ${tr('自动备份已关闭。')}` : ''}${data.status?.pending ? ` ${esc(t`等待备份：${data.status.pending}`)}` : ''}</p>` : ''}
                ${data?.overBudget ? `<p role="status">${tr('已超出备份预算，暂停新增。聊天保存不受影响。')}</p>` : ''}
                ${failures.length ? `<p role="status">${tr('近期备份异常，不代表聊天保存失败：')}${esc(failures.join('、'))}</p>` : ''}
                ${data?.warnings?.length ? `<p role="status">${tr('部分备份无法验证，已保留，不参与自动清理。')}</p>` : ''}
                <p role="alert" data-backup-error></p>
                <p role="status" class="nora-model-note" data-backup-result></p>
                <button type="button" class="nora-secondary" data-backup-reload hidden>${tr('重新加载页面')}</button>
                <div data-backup-list>${snapshots.slice(page * 20, (page + 1) * 20).map(row).join('') || (data ? `<p>${tr('暂无可管理的新备份。')}</p>` : '')}</div>
                ${snapshots.length ? `<div class="nora-backup-toolbar"><div class="nora-backup-actions"><button type="button" class="nora-secondary" data-backup-prev>${tr('上一页')}</button><span>${page + 1} / ${Math.ceil(snapshots.length / 20)}</span><button type="button" class="nora-secondary" data-backup-next>${tr('下一页')}</button></div><button type="button" class="nora-secondary" data-backup-delete></button></div>` : ''}
                <p class="nora-model-note">${tr('保护只阻止本程序自动淘汰。取消保护后，备份会重新受数量和期限限制。')}</p>
                ${data?.legacyFiles ? `<div class="nora-backup-legacy"><button type="button" class="nora-secondary" data-backup-legacy>${esc(t`旧备份及未受管文件（${data.legacyFiles}）· 仅预览`)}</button><div data-backup-legacy-list></div></div>` : ''}`;
            select('[data-backup-refresh]', host).addEventListener('click', () => { if (!busy) return load(); });
            select('[data-backup-reload]', host).addEventListener('click', () => { if (!busy) reloadPage(); });
            selectAll('[data-backup-restore]', host).forEach(button => button.addEventListener('click', () => action(async () => {
                if (!ready) return;
                const item = data.snapshots.find(item => item.id === button.dataset.backupRestore);
                if (pendingRestore && pendingRestore.id !== item.id) return;
                if (!pendingRestore) {
                    const target = { id: item.id, worldId: item.worldId, sessionId: item.sessionId };
                    const preview = await request('restore-preview', target);
                    if (!alive()) return;
                    const approved = await dialogs.confirm({ title: tr('恢复这份聊天备份？'),
                        body: `${names.get(item.worldId)} · ${time(preview.snapshot.createdAt)}\n${tr('先保护当前聊天，再用选定备份替换该会话。保护失败则不会覆盖。请先保留其他页面尚未保存的内容。')}`,
                        details: [`${names.get(item.worldId)} · ${time(preview.snapshot.createdAt)}`,
                            `${tr('会话：')}${item.sessionId}`,
                            t`消息：${preview.current.messageCount} → ${preview.snapshot.messageCount}；候选回复：${preview.snapshot.swipeCount}。`,
                            tr('恢复消息、消息附带的变量和候选回复；不替换卡片、世界书或库原件。'),
                            tr(preview.snapshot.mvuState === 'confirmed' ? '已记录变量更新成功，但不代表完整世界存档。' : '变量状态未确认或未完成，只恢复备份中实际存在的数据，不自动补齐。'),
                            tr('旧压缩账本失效；本次不调用模型，继续聊天后按原文重新积累。'),
                            tr('恢复后请保留未发送的输入，再主动重新加载页面；其他打开该会话的页面也需重新载入。')],
                        confirmLabel: tr('保护并恢复'), tone: 'danger', restoreSheet: true });
                    if (!approved || !alive()) return;
                    pendingRestore = { ...target, expectedRevision: preview.current.revision, sha256: preview.snapshot.sha256 };
                }
                try {
                    const result = await request('restore', pendingRestore);
                    if (!['restored', 'already-restored'].includes(result.status)
                        || result.worldId !== pendingRestore.worldId || result.sessionId !== pendingRestore.sessionId) throw new Error('NORA_BACKUP_RESTORE_UNCONFIRMED');
                    pendingRestore = null;
                    await load();
                    if (!alive()) return;
                    select('[data-backup-result]', host).textContent = tr('聊天已恢复。请先保留未发送的输入，再重新加载页面查看结果。')
                        + (result.projectionPending ? ` ${tr('摘要同步待重试，聊天已保存。')}` : '');
                    select('[data-backup-reload]', host).hidden = false;
                } catch (cause) {
                    const code = cause.message;
                    if (cause.status >= 400 && cause.status < 500) pendingRestore = null;
                    if (pendingRestore) throw new Error(tr('恢复结果尚未确认，请点击“核实恢复结果”；不要重复创建新的恢复请求。'));
                    if (['NORA_CHAT_OPERATION_BUSY', 'NORA_LEDGER_BUSY'].includes(code)) throw new Error(tr('该会话仍在生成、保存或处理账本，可能来自其他页面。请等待完成后再恢复。'));
                    if (code === 'NORA_BACKUP_RESTORE_STALE') throw new Error(tr('聊天或备份已变化，本次未恢复。请重新预览并确认。'));
                    if (code === 'NORA_BACKUP_REQUIRED') throw new Error(tr('无法保护当前聊天，本次未恢复。请检查备份空间和权限后重试。'));
                    if (['NORA_LEDGER_SESSION_UNAVAILABLE', 'NORA_BACKUP_RESTORE_TARGET_UNAVAILABLE'].includes(code)) throw new Error(tr('目标世界或会话已不可用，不能用聊天备份重建世界。'));
                    throw cause;
                }
            })));
            selectAll('[data-backup-select]', host).forEach(input => input.addEventListener('change', () => {
                if (busy || input.disabled || !input.isConnected) return;
                if (input.checked) selected.add(input.dataset.backupSelect);
                else selected.delete(input.dataset.backupSelect);
                controls();
            }));
            selectAll('[data-backup-download]', host).forEach(button => button.addEventListener('click', () => action(async () => {
                const id = button.dataset.backupDownload;
                const blob = await request('snapshot', { id }, true);
                if (alive()) saveFile(blob, `chat_nora1_${id}.jsonl`);
            })));
            selectAll('[data-backup-protect]', host).forEach(button => button.addEventListener('click', () => action(async () => {
                if (!ready || pendingRestore) return;
                const item = data.snapshots.find(item => item.id === button.dataset.backupProtect);
                await request('protect', { id: item.id, protected: !item.protected });
                await load();
            })));
            select('[data-backup-delete]', host)?.addEventListener('click', () => action(async () => {
                if (!ready || pendingRestore) return;
                const targets = data.snapshots.filter(item => selected.has(item.id) && !item.protected);
                if (!targets.length) return;
                const approved = await dialogs.confirm({ title: tr('删除所选聊天备份？'),
                    body: t`将永久删除 ${targets.length} 份备份（${bytes(targets.reduce((sum, item) => sum + item.bytes, 0))}）。不删除当前聊天、世界或库原件。`,
                    details: targets.map(item => `${names.get(item.worldId) || item.worldId || tr('旧格式聊天')} · ${time(item.createdAt)} · ${item.id}`),
                    confirmLabel: tr('永久删除'), tone: 'danger', restoreSheet: true });
                if (!approved || !alive()) return;
                let deleted = 0;
                const failures = [];
                for (const item of targets) {
                    try { await request('remove', { id: item.id }); deleted++; selected.delete(item.id); }
                    catch (cause) { failures.push(`${item.id}: ${cause.message}`); }
                }
                const refreshed = await load();
                if (alive()) select('[data-backup-result]', host).textContent = t`已删除 ${deleted} 份备份，无法通过本页面恢复。`;
                error((failures.length ? `${t`另有 ${failures.length} 份未删除：`}${failures.join('；')}` : '')
                    + (refreshed ? '' : ` ${tr('列表刷新失败，请刷新后继续管理。')}`));
            }));
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
            select('[data-backup-result]', host).textContent = '';
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
                ready = true;
                for (const id of selected) if (!data.snapshots.some(item => item.id === id && !item.protected)) selected.delete(id);
                render();
                return true;
            } catch (cause) { error(`${tr('列表刷新失败，请刷新后继续管理。')} ${cause.message}`); return false; }
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
