import './fixtures/nora-zh-locale.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { load } from 'cheerio';
import { createBackupController } from '../../../native-extensions/nora-ui/backup-controller.js';

function fixture({ scope = { worldId: 'world:a', sessionId: 'session:a' }, inventory = {}, restoreWarning = null } = {}) {
    let dom, modal, accepted = true, failRemove = '', failList = false, hold, restoreError = '', readError = '', reloads = 0, closeGuard;
    let content = [{ chat_metadata: {} }, { name: 'NPC', mes: '<img src=x onerror=bad()> Last message' }].map(JSON.stringify).join('\n');
    const nodes = new WeakMap(), calls = [], confirmations = [], downloads = [];
    const snapshots = [
        { id: 'a', sha256: 'snapshot-digest', worldId: 'world:a', sessionId: 'session:a', createdAt: 1790630400000, bytes: 2048, protected: false, consistency: 'chat-only', messageCount: 1, preview: '<img src=x onerror=bad()> Last message' },
        { id: 'b', sha256: 'other-digest', worldId: 'world:b', sessionId: 'session:b', createdAt: 1790630400000, bytes: 1024, protected: true, consistency: 'chat-only' },
    ];
    const wrap = raw => {
        if (!raw) return null;
        if (nodes.has(raw)) return nodes.get(raw);
        const node = { raw, listeners: {}, dataset: Object.fromEntries(Object.entries(raw.attribs || {}).filter(([k]) => k.startsWith('data-')).map(([k, v]) => [k.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase()), v])),
            get isConnected() { return dom.root().find('*').toArray().includes(raw); },
            setAttribute(name, value) { dom(raw).attr(name, value); }, focus() {},
            addEventListener(type, fn) { this.listeners[type] = fn; }, fire(type = 'click', extra = {}) { return this.listeners[type]?.({ target: this, preventDefault() {}, ...extra }); } };
        for (const attr of ['disabled', 'hidden', 'checked', 'open']) Object.defineProperty(node, attr, {
            get: () => dom(raw).attr(attr) !== undefined, set: value => { if (value) dom(raw).attr(attr, ''); else dom(raw).removeAttr(attr); },
        });
        Object.defineProperty(node, 'innerHTML', { get: () => dom(raw).html(), set: value => dom(raw).html(value) });
        Object.defineProperty(node, 'textContent', { get: () => dom(raw).text(), set: value => dom(raw).text(value) });
        Object.defineProperty(node, 'value', { get: () => dom(raw).val(), set: value => dom(raw).val(value) });
        nodes.set(raw, node); return node;
    };
    const select = (selector, root = modal) => wrap(dom(root.raw).find(selector).get(0));
    const selectAll = (selector, root = modal) => dom(root.raw).find(selector).toArray().map(wrap);
    const controller = createBackupController({ select, selectAll,
        escapeHtml: value => String(value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;'),
        worlds: () => [{ id: 'world:a', name: '<img src=x onerror=bad()>' }],
        activeScope: () => scope,
        headers: () => ({ 'Content-Type': 'application/json', 'X-CSRF-Token': 'fixture' }),
        dialogs: { open(_title, html) { dom = load(`<div id="modal">${html}</div>`); modal = wrap(dom('#modal').get(0)); return modal; },
            setCloseGuard(guard) { closeGuard = guard; }, async confirm(options) { confirmations.push(options); return accepted; } },
        saveFile: (blob, name) => downloads.push({ blob, name }),
        reloadPage: () => { reloads++; },
        fetchImpl: async (url, options) => {
            const body = JSON.parse(options.body);
            calls.push({ url, body, headers: options.headers });
            if (hold) await hold;
            if (url.endsWith('/read')) {
                if (readError) return { ok: false, status: 409, json: async () => ({ error: readError }) };
                let result;
                try {
                    const lines = content.split('\n').filter(line => line.trim()).map(JSON.parse);
                    assert.ok(lines[0].chat_metadata && !Array.isArray(lines[0].chat_metadata));
                    const messages = lines.slice(1);
                    result = { offset: body.offset, messageCount: messages.length, hasMore: body.offset + body.limit < messages.length,
                        messages: messages.slice(body.offset, body.offset + body.limit).map(message => ({ name: message.name,
                            text: message.mes.slice(0, 4000), truncated: message.mes.length > 4000 })) };
                } catch { return { ok: false, status: 409, json: async () => ({ error: 'NORA_BACKUP_INVALID_RESTORE_CHAT' }) }; }
                return { ok: true, json: async () => result };
            }
            if (url.endsWith('/restore') && restoreError === 'network') throw new Error('connection lost');
            const error = url.endsWith('/managed') && failList || url.endsWith('/remove') && body.id === failRemove
                || url.endsWith('/restore') && restoreError;
            if (!error && url.endsWith('/remove')) snapshots.splice(snapshots.findIndex(item => item.id === body.id), 1);
            if (!error && url.endsWith('/protect')) snapshots.find(item => item.id === body.id).protected = body.protected;
            return { ok: !error, status: error ? 409 : 200, json: async () => error ? { error: restoreError || 'NORA_BACKUP_CHANGED' } : url.endsWith('/restore-preview')
                ? { worldId: body.worldId, sessionId: body.sessionId, current: { revision: 'current-revision', messageCount: 10 },
                    snapshot: { id: body.id, sha256: 'snapshot-digest', createdAt: 1790630400000, messageCount: 3, swipeCount: 2, mvuState: 'unverified' } }
                : url.endsWith('/restore') ? { status: 'restored', worldId: body.worldId, sessionId: body.sessionId, backupWarning: restoreWarning }
                : url.endsWith('/managed')
                ? { snapshots: structuredClone(snapshots), totalBytes: 4096, legacyFiles: 1, warnings: [],
                    policy: { maxPerSession: 50, maxAgeDays: 30, maxBytes: 536870912 },
                    status: { enabled: true, pending: 0, recent: [{ status: 'failed', code: 'ENOSPC' }] }, ...inventory }
                : url.endsWith('/inventory') ? { complete: false, backups: [{ name: 'chat_legacy.jsonl', bytes: 1024, modifiedAt: 1790630400000, owner: { confidence: 'unknown' } }], warnings: [] } : {},
            blob: async () => new Blob([content]) };
        },
    });
    return { controller, select, selectAll, calls, confirmations, downloads, snapshots, text: () => dom.text(),
        accepted: value => { accepted = value; }, failRemove: value => { failRemove = value; }, failList: value => { failList = value; },
        restoreError: value => { restoreError = value; }, readError: value => { readError = value; }, reloads: () => reloads, canClose: () => closeGuard(),
        content: value => { content = value; },
        view: id => select(`[data-backup-view="${id}"]`).fire(),
        manage: () => select('[data-backup-manage]').fire(),
        filter: async value => { const input = select('[data-backup-filter]'); input.value = value; await input.fire('change'); },
        hold: value => { hold = value; }, close: () => dom('#modal').empty() };
}

test('backup sheet offers whole-row viewing and management, without per-row actions or single-page pagination', async () => {
    const f = fixture();
    await f.controller.open();
    assert.equal(f.selectAll('[data-backup-row]').length, 1);
    assert.equal(f.selectAll('img').length, 0);
    assert.match(f.text(), /全部世界/);
    assert.match(f.text(), /1 条消息/);
    assert.match(f.select('[data-backup-row="a"]').textContent, /Last message/);
    assert.doesNotMatch(f.text(), /world:a|session:a|归属标识/);
    assert.match(f.text(), /20/);
    assert.equal(f.select('.nora-backup-policy').raw.name, 'section');
    assert.equal(f.select('.nora-backup-policy summary'), null);
    assert.match(f.select('.nora-backup-policy').textContent, /0\.00 MiB \/ 512\.00 MiB/);
    assert.match(f.select('.nora-backup-policy').textContent, /每会话最多 50 份自动备份，保留 30 天/);
    assert.match(f.select('.nora-backup-policy').textContent, /不占自动备份份数，不自动删除/);
    assert.equal(f.select('.nora-backup-policy').hidden, false);
    assert.equal(f.select('.nora-backup-manager').raw.children.filter(node => node.type === 'tag')[0], f.select('.nora-backup-policy').raw);
    assert.match(f.text(), /ENOSPC/);
    assert.doesNotMatch(f.text(), /回复生成失败/);
    assert.equal(f.select('[data-backup-delete]'), null);
    assert.equal(f.select('[data-backup-restore="a"]'), null);
    assert.equal(f.select('[data-backup-download="a"]'), null);
    assert.equal(f.selectAll('[data-backup-menu]').length, 0);
    assert.equal(f.select('[data-backup-next]'), null);
    assert.equal(f.select('[data-backup-refresh]'), null);
    assert.equal(f.select('[data-backup-view="a"]').raw.name, 'button');
    assert.equal(f.select('[data-backup-reload]').hidden, true);
    await f.filter('all');
    assert.equal(f.selectAll('[data-backup-row]').length, 2);
    await f.manage();
    assert.equal(f.select('[data-backup-select="b"]').disabled, true);
    assert.equal(f.select('[data-backup-restore="b"]'), null, 'unavailable Worlds do not offer restoration');
    assert.ok(f.calls.every(call => call.headers['X-CSRF-Token'] === 'fixture'));
});

test('restore previews and confirms exact scope, preserves cancellation and requires explicit reload', async () => {
    const f = fixture();
    await f.controller.open();
    await f.view('a');
    assert.equal(f.select('.nora-backup-manager').raw.children.filter(node => node.type === 'tag')[0], f.select('.nora-backup-policy').raw);
    f.accepted(false);
    await f.select('[data-backup-restore="a"]').fire();
    assert.equal(f.calls.filter(call => call.url.endsWith('/restore')).length, 0);
    const confirmation = f.confirmations[0];
    assert.equal(confirmation.restoreSheet, true);
    assert.match(confirmation.body, /备份失败不阻止恢复/);
    assert.equal(confirmation.confirmLabel, '恢复聊天');
    assert.match(confirmation.details.join(' '), /不替换卡片/);
    assert.match(confirmation.details.join(' '), /变量状态未确认/);
    assert.match(confirmation.details.join(' '), /账本.*失效/);
    assert.match(confirmation.body, /消息：10 → 3/);
    assert.match(confirmation.details.join(' '), /session:a/);
    f.accepted(true);
    await f.select('[data-backup-restore="a"]').fire();
    assert.deepEqual(f.calls.find(call => call.url.endsWith('/restore')).body, {
        id: 'a', worldId: 'world:a', sessionId: 'session:a', expectedRevision: 'current-revision', sha256: 'snapshot-digest',
    });
    assert.match(f.text(), /聊天已恢复/);
    assert.equal(f.reloads(), 0, 'never discard unsent input through automatic navigation');
    await f.select('[data-backup-reload]').fire();
    assert.equal(f.reloads(), 1);
});

test('kept backup capacity exhaustion has an obvious cleanup notice without disabling management or restoration', async () => {
    const f = fixture({ inventory: { totalBytes: 536870913, overBudget: true,
        capacity: { protectedCount: 60, protectedBytes: 536870913, protectedLimitReached: true } },
    restoreWarning: { status: 'failed', code: 'NORA_BACKUP_BUDGET_EXCEEDED' } });
    await f.controller.open();
    assert.ok(f.select('.nora-backup-capacity-warning[role="alert"]'));
    assert.match(f.text(), /已保留 60 份备份/);
    assert.match(f.text(), /先取消保留/);
    assert.match(f.text(), /正常操作仍可继续/);
    assert.equal(f.select('[data-backup-manage]').disabled, false);
    await f.view('a');
    assert.equal(f.select('[data-backup-restore="a"]').disabled, false);
    await f.select('[data-backup-restore="a"]').fire();
    assert.match(f.text(), /选定备份已成功恢复/);
    assert.equal(f.canClose(), true);
});

test('manual keeps above fifty warn without falsely claiming exhausted storage or disabling actions', async () => {
    const f = fixture({ inventory: { totalBytes: 6000, overBudget: false,
        capacity: { protectedCount: 60, protectedBytes: 6000, protectedCountExceeded: true, protectedLimitReached: true } } });
    await f.controller.open();
    assert.ok(f.select('.nora-backup-capacity-warning[role="alert"]'));
    assert.match(f.text(), /已超过 50 份/);
    assert.match(f.text(), /正常操作仍可继续/);
    assert.doesNotMatch(f.text(), /备份空间不足/);
    assert.equal(f.select('[data-backup-manage]').disabled, false);
    await f.view('a');
    assert.equal(f.select('[data-backup-restore="a"]').disabled, false);
});

test('unknown restore outcome reuses the confirmed proof and busy conflicts never claim success', async () => {
    const f = fixture();
    await f.controller.open();
    await f.view('a');
    f.restoreError('network');
    await f.select('[data-backup-restore="a"]').fire();
    assert.match(f.text(), /尚未确认/);
    assert.doesNotMatch(f.text(), /聊天已恢复/);
    assert.equal(f.select('[data-backup-protect="a"]').disabled, true);
    assert.equal(f.select('[data-backup-remove="a"]').disabled, true);
    f.restoreError('');
    await f.select('[data-backup-verify]').fire();
    const requests = f.calls.filter(call => call.url.endsWith('/restore'));
    assert.deepEqual(requests[0].body, requests[1].body);
    assert.equal(f.calls.filter(call => call.url.endsWith('/restore-preview')).length, 1);
    assert.match(f.text(), /聊天已恢复/);
    const busy = fixture();
    busy.restoreError('NORA_CHAT_OPERATION_BUSY');
    await busy.controller.open();
    await busy.view('a');
    await busy.select('[data-backup-restore="a"]').fire();
    assert.match(busy.text(), /其他页面|生成|占用/);
    assert.doesNotMatch(busy.text(), /聊天已恢复/);
});

test('backup details distinguish observed MVU states without claiming complete World restoration', async () => {
    const f = fixture();
    f.snapshots[0].mvuState = 'confirmed';
    f.snapshots[1].mvuState = 'pending';
    await f.controller.open();
    await f.view('a');
    assert.match(f.text(), /变量更新已确认/);
    await f.select('[data-backup-back]').fire();
    await f.filter('all');
    await f.view('b');
    assert.match(f.text(), /变量更新中/);
    assert.equal(f.select('[data-backup-restore="b"]'), null);
    assert.match(f.text(), /目标世界已不可用/);
    f.snapshots[0].mvuState = 'incomplete';
    delete f.snapshots[1].mvuState;
    await f.select('[data-backup-refresh]').fire();
    assert.match(f.text(), /变量状态未确认/);
    await f.select('[data-backup-back]').fire();
    await f.view('a');
    assert.match(f.text(), /变量更新未完成/);
    assert.match(f.text(), /不更改角色卡、世界书或库/);
});

test('download uses the selected snapshot, cancel deletes nothing, and protection changes update selection eligibility', async () => {
    const f = fixture();
    await f.controller.open();
    await f.view('a');
    await f.select('[data-backup-download="a"]').fire();
    assert.equal(f.downloads[0]?.name, 'chat_nora1_a.jsonl');
    await f.select('[data-backup-back]').fire();
    await f.manage();
    const input = f.select('[data-backup-select="a"]');
    input.checked = true;
    await input.fire('change');
    assert.equal(f.select('[data-backup-delete]').disabled, false);
    f.accepted(false);
    await f.select('[data-backup-delete]').fire();
    assert.equal(f.calls.filter(call => call.url.endsWith('/remove')).length, 0);
    assert.equal(f.confirmations[0]?.restoreSheet, true);
    await f.view('a');
    await f.select('[data-backup-protect="a"]').fire();
    await f.select('[data-backup-back]').fire();
    assert.equal(f.select('[data-backup-select="a"]').disabled, true);
    assert.equal(f.select('[data-backup-delete]').disabled, true);
    await f.view('a');
    await f.select('[data-backup-protect="a"]').fire();
    await f.select('[data-backup-back]').fire();
    assert.equal(f.select('[data-backup-select="a"]').disabled, false);
});

test('batch deletion reports partial failure, leaves failed rows selected, and old files have preview only', async () => {
    const f = fixture();
    f.snapshots[1].protected = false;
    await f.controller.open();
    await f.filter('all');
    await f.manage();
    for (const input of f.selectAll('[data-backup-select]')) { input.checked = true; await input.fire('change'); }
    f.failRemove('b');
    await f.select('[data-backup-delete]').fire();
    assert.match(f.text(), /已删除 1 份/);
    assert.match(f.text(), /另有 1 份未删除/);
    assert.equal(f.select('[data-backup-select="a"]'), null);
    assert.equal(f.select('[data-backup-select="b"]').checked, true);
    await f.select('[data-backup-legacy]').fire();
    assert.match(f.text(), /chat_legacy.jsonl/);
    assert.match(f.text(), /扫描未完整完成/);
    assert.equal(f.selectAll('[data-backup-select]').length, 1);
    assert.equal(f.calls.filter(call => call.url.endsWith('/delete')).length, 0);
});

test('a closed sheet ignores a delayed response and a failed refresh does not offer writes from stale data', async () => {
    const f = fixture();
    let release;
    f.hold(new Promise(resolve => { release = resolve; }));
    const pending = f.controller.open();
    f.close(); release();
    await pending;
    assert.equal(f.select('[data-backup-row]'), null);
    f.hold(null);
    await f.controller.open();
    await f.manage();
    f.failList(true);
    await f.select('[data-backup-refresh]').fire();
    assert.match(f.text(), /NORA_BACKUP_CHANGED/);
    assert.equal(f.select('[data-backup-view="a"]').disabled, true);
    assert.equal(f.select('[data-backup-refresh]').disabled, false);
});

test('selection survives pagination and successful deletion is reported as a result, not an error', async () => {
    const f = fixture();
    f.snapshots[1].protected = false;
    for (let i = 2; i < 22; i++) f.snapshots.push({ ...f.snapshots[0], id: `copy-${i}` });
    await f.controller.open();
    await f.filter('all');
    await f.manage();
    const choose = async id => {
        const input = f.select(`[data-backup-select="${id}"]`);
        input.checked = true;
        await input.fire('change');
    };
    assert.equal(f.selectAll('[data-backup-row]').length, 20);
    await choose('a');
    await f.select('[data-backup-next]').fire();
    assert.equal(f.selectAll('[data-backup-row]').length, 2);
    await choose('copy-21');
    assert.match(f.select('[data-backup-delete]').textContent, /2/);
    await f.select('[data-backup-prev]').fire();
    assert.equal(f.select('[data-backup-select="a"]').checked, true);
    await f.select('[data-backup-delete]').fire();
    assert.deepEqual(f.calls.filter(call => call.url.endsWith('/remove')).map(call => call.body.id), ['a', 'copy-21']);
    assert.equal(f.select('[data-backup-error]').textContent, '');
    assert.match(f.select('[data-backup-result][role="status"]').textContent, /已删除 2 份/);
});

test('current chat excludes another session of the same world; filtering never sends mutations', async () => {
    const f = fixture();
    f.snapshots.push({ ...f.snapshots[0], id: 'other-session', sessionId: 'session:other' });
    await f.controller.open();
    assert.equal(f.selectAll('[data-backup-row]').length, 1);
    await f.filter('world:a');
    assert.equal(f.selectAll('[data-backup-row]').length, 2);
    assert.equal(f.calls.length, 1, 'filters operate on the verified inventory without fetching or writing chats');
    const global = fixture({ scope: null });
    await global.controller.open();
    assert.equal(global.selectAll('[data-backup-row]').length, 2);
});

test('view reads only the selected backup, escapes chat content, and back navigation keeps the filter', async () => {
    const f = fixture();
    await f.controller.open();
    assert.equal(f.calls.filter(call => call.url.endsWith('/snapshot')).length, 0);
    await f.view('a');
    assert.deepEqual(f.calls.filter(call => call.url.endsWith('/read')).map(call => call.body), [{ id: 'a', sha256: 'snapshot-digest', offset: 0, limit: 20 }]);
    assert.equal(f.calls.filter(call => call.url.endsWith('/snapshot')).length, 0, 'details use the shared validated bounded read, not a second JSONL parser');
    assert.equal(f.selectAll('img').length, 0);
    assert.match(f.select('.nora-backup-transcript').textContent, /Last message/);
    assert.ok(f.select('[data-backup-restore="a"]'));
    assert.equal(f.calls.filter(call => call.url.endsWith('/restore-preview')).length, 0);
    await f.select('[data-backup-back]').fire();
    assert.equal(f.select('[data-backup-filter]').value, 'current');
    assert.equal(f.selectAll('[data-backup-row]').length, 1);
});

test('corrupt preview cannot offer restoration; oversized content stays downloadable without a browser fetch', async () => {
    const f = fixture();
    f.content('{broken');
    await f.controller.open();
    await f.view('a');
    assert.match(f.text(), /聊天内容无法读取/);
    assert.equal(f.select('[data-backup-restore]'), null);
    assert.ok(f.select('[data-backup-download="a"]'));
    const large = fixture();
    large.snapshots[0].bytes = 17 * 1024 * 1024;
    delete large.snapshots[0].messageCount;
    await large.controller.open();
    await large.view('a');
    assert.match(large.text(), /内容较大/);
    assert.match(large.text(), /消息数未读取/);
    assert.equal(large.calls.filter(call => call.url.endsWith('/snapshot')).length, 0);
    assert.ok(large.select('[data-backup-restore="a"]'), 'restoration still uses server-side scope and revision verification');
});

test('preview limits DOM content but the download retains the exact complete JSONL', async () => {
    const f = fixture();
    const content = [{ chat_metadata: {} }, ...Array.from({ length: 60 }, (_, index) => ({ name: 'NPC', mes: `message-${index} ${'x'.repeat(5000)}` }))].map(JSON.stringify).join('\n');
    f.content(content);
    await f.controller.open();
    await f.view('a');
    assert.match(f.text(), /60 条消息/);
    assert.match(f.text(), /仅预览最后 40 条/);
    assert.match(f.text(), /长消息已截短/);
    assert.equal(f.selectAll('.nora-backup-message').length, 40);
    assert.ok(f.select('.nora-backup-transcript').textContent.length < 162000);
    await f.select('[data-backup-download="a"]').fire();
    assert.equal(await f.downloads[0].blob.text(), content);
});

test('single deletion shares confirmation and protection guards; successful deletion returns to the list', async () => {
    const f = fixture();
    await f.controller.open();
    await f.view('a');
    f.accepted(false);
    await f.select('[data-backup-remove="a"]').fire();
    assert.equal(f.calls.filter(call => call.url.endsWith('/remove')).length, 0);
    await f.select('[data-backup-protect="a"]').fire();
    assert.equal(f.select('[data-backup-remove="a"]').disabled, true);
    await f.select('[data-backup-remove="a"]').fire();
    assert.equal(f.calls.filter(call => call.url.endsWith('/remove')).length, 0);
    await f.select('[data-backup-protect="a"]').fire();
    f.accepted(true);
    await f.select('[data-backup-remove="a"]').fire();
    assert.deepEqual(f.calls.filter(call => call.url.endsWith('/remove')).map(call => call.body.id), ['a']);
    assert.equal(f.select('[data-backup-back]'), null);
    assert.match(f.text(), /已删除 1 份/);
    assert.ok(f.snapshots.some(item => item.id === 'b'));
});

test('details centralize secondary actions; restored state retains its explicit reload across navigation', async () => {
    const f = fixture();
    await f.controller.open();
    await f.view('a');
    assert.ok(f.select('.nora-backup-detail-actions [data-backup-download="a"]'));
    assert.ok(f.select('.nora-backup-detail-actions [data-backup-protect="a"]'));
    assert.ok(f.select('.nora-backup-detail-actions [data-backup-remove="a"]'));
    await f.select('[data-backup-restore="a"]').fire();
    await f.select('[data-backup-back]').fire();
    assert.match(f.text(), /聊天已恢复/);
    assert.equal(f.select('[data-backup-reload]').hidden, false);
    assert.equal(f.reloads(), 0);
});

test('initial inventory failure offers refresh and recovers without opening a new dialog', async () => {
    const f = fixture();
    f.failList(true);
    await f.controller.open();
    assert.match(f.text(), /列表刷新失败/);
    assert.equal(f.select('[data-backup-refresh]').disabled, false);
    f.failList(false);
    await f.select('[data-backup-refresh]').fire();
    assert.equal(f.selectAll('[data-backup-row]').length, 1);
    assert.equal(f.select('[data-backup-refresh]'), null);
    assert.equal(f.select('[data-backup-error]').textContent, '');
});

test('failed refresh in details disables restoration but keeps refresh; changed bytes invalidate an old preview', async () => {
    const f = fixture();
    await f.controller.open();
    await f.view('a');
    f.failList(true);
    await f.select('[data-backup-refresh]').fire();
    assert.equal(f.select('[data-backup-restore="a"]').disabled, true);
    assert.equal(f.select('[data-backup-refresh]').disabled, false);
    f.failList(false);
    f.snapshots[0].sha256 = 'different-digest';
    await f.select('[data-backup-refresh]').fire();
    assert.equal(f.select('[data-backup-restore]'), null);
    assert.equal(f.select('[data-backup-view="a"]').disabled, false);
    assert.equal(f.select('[data-backup-error]').textContent, '');
});

test('unknown restore remains verifiable after navigation and loss of the snapshot from inventory', async () => {
    const f = fixture();
    await f.controller.open();
    await f.view('a');
    f.restoreError('network');
    await f.select('[data-backup-restore="a"]').fire();
    assert.equal(f.canClose(), false, 'do not silently discard the pending confirmation proof');
    await f.select('[data-backup-back]').fire();
    await f.manage();
    f.snapshots.splice(0, 1);
    await f.select('[data-backup-refresh]').fire();
    assert.equal(f.select('[data-backup-view="a"]'), null);
    assert.ok(f.select('[data-backup-verify]'));
    f.failList(true);
    await f.select('[data-backup-refresh]').fire();
    assert.match(f.text(), /列表刷新失败/);
    assert.equal(f.select('[data-backup-verify]').disabled, false, 'verification does not depend on a successful inventory refresh');
    f.failList(false);
    f.restoreError('');
    await f.select('[data-backup-verify]').fire();
    const requests = f.calls.filter(call => call.url.endsWith('/restore'));
    assert.deepEqual(requests[0].body, requests[1].body);
    assert.equal(f.calls.filter(call => call.url.endsWith('/restore-preview')).length, 1);
    assert.equal(f.canClose(), true);
    assert.match(f.text(), /聊天已恢复/);
});

test('sessions with identical dates and counts have distinct restore confirmations', async () => {
    const f = fixture();
    f.snapshots.push({ ...f.snapshots[0], id: 'other', sessionId: 'session:other' });
    await f.controller.open();
    await f.filter('world:a');
    assert.match(f.select('[data-backup-row="other"]').textContent, /session:other/);
    f.accepted(false);
    await f.view('a');
    await f.select('[data-backup-restore="a"]').fire();
    await f.select('[data-backup-back]').fire();
    await f.view('other');
    await f.select('[data-backup-restore="other"]').fire();
    assert.match(f.confirmations[0].body, /session:a/);
    assert.match(f.confirmations[1].body, /session:other/);
    assert.notEqual(f.confirmations[0].body, f.confirmations[1].body);
});

test('all selected-file operations carry the listed digest and a changed detail cannot be restored', async () => {
    const f = fixture();
    await f.controller.open();
    f.readError('NORA_BACKUP_CHANGED');
    await f.view('a');
    assert.match(f.text(), /NORA_BACKUP_CHANGED/);
    assert.equal(f.select('[data-backup-restore]'), null);
    f.readError('');
    await f.view('a');
    await f.select('[data-backup-download="a"]').fire();
    await f.select('[data-backup-protect="a"]').fire();
    await f.select('[data-backup-protect="a"]').fire();
    await f.select('[data-backup-remove="a"]').fire();
    assert.ok(f.calls.filter(call => ['/read', '/snapshot', '/protect', '/remove'].some(route => call.url.endsWith(route)))
        .every(call => call.body.sha256 === 'snapshot-digest'));
    const malformed = fixture();
    malformed.content('{"chat_metadata":[]}\n{"mes":"visible"}');
    await malformed.controller.open();
    await malformed.view('a');
    assert.match(malformed.text(), /聊天内容无法读取/);
    assert.equal(malformed.select('[data-backup-restore]'), null);
});
