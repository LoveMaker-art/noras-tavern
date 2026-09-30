import './fixtures/nora-zh-locale.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { load } from 'cheerio';
import { createBackupController } from '../../../native-extensions/nora-ui/backup-controller.js';

function fixture() {
    let dom, modal, accepted = true, failRemove = '', failList = false, hold, restoreError = '', reloads = 0;
    const nodes = new WeakMap(), calls = [], confirmations = [], downloads = [];
    const snapshots = [
        { id: 'a', worldId: 'world:a', sessionId: 'session:a', createdAt: 1790630400000, bytes: 2048, protected: false, consistency: 'chat-only' },
        { id: 'b', worldId: 'world:b', sessionId: 'session:b', createdAt: 1790630400000, bytes: 1024, protected: true, consistency: 'chat-only' },
    ];
    const wrap = raw => {
        if (!raw) return null;
        if (nodes.has(raw)) return nodes.get(raw);
        const node = { raw, listeners: {}, dataset: Object.fromEntries(Object.entries(raw.attribs || {}).filter(([k]) => k.startsWith('data-')).map(([k, v]) => [k.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase()), v])),
            get isConnected() { return dom.root().find('*').toArray().includes(raw); },
            addEventListener(type, fn) { this.listeners[type] = fn; }, fire(type = 'click') { return this.listeners[type]?.({ preventDefault() {} }); } };
        for (const attr of ['disabled', 'hidden', 'checked']) Object.defineProperty(node, attr, {
            get: () => dom(raw).attr(attr) !== undefined, set: value => { if (value) dom(raw).attr(attr, ''); else dom(raw).removeAttr(attr); },
        });
        Object.defineProperty(node, 'innerHTML', { get: () => dom(raw).html(), set: value => dom(raw).html(value) });
        Object.defineProperty(node, 'textContent', { get: () => dom(raw).text(), set: value => dom(raw).text(value) });
        nodes.set(raw, node); return node;
    };
    const select = (selector, root = modal) => wrap(dom(root.raw).find(selector).get(0));
    const selectAll = (selector, root = modal) => dom(root.raw).find(selector).toArray().map(wrap);
    const controller = createBackupController({ select, selectAll,
        escapeHtml: value => String(value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;'),
        worlds: () => [{ id: 'world:a', name: '<img src=x onerror=bad()>' }],
        headers: () => ({ 'Content-Type': 'application/json', 'X-CSRF-Token': 'fixture' }),
        dialogs: { open(_title, html) { dom = load(`<div id="modal">${html}</div>`); modal = wrap(dom('#modal').get(0)); return modal; },
            setCloseGuard() {}, async confirm(options) { confirmations.push(options); return accepted; } },
        saveFile: (blob, name) => downloads.push({ blob, name }),
        reloadPage: () => { reloads++; },
        fetchImpl: async (url, options) => {
            const body = JSON.parse(options.body);
            calls.push({ url, body, headers: options.headers });
            if (hold) await hold;
            if (url.endsWith('/restore') && restoreError === 'network') throw new Error('connection lost');
            const error = url.endsWith('/managed') && failList || url.endsWith('/remove') && body.id === failRemove
                || url.endsWith('/restore') && restoreError;
            if (!error && url.endsWith('/remove')) snapshots.splice(snapshots.findIndex(item => item.id === body.id), 1);
            if (!error && url.endsWith('/protect')) snapshots.find(item => item.id === body.id).protected = body.protected;
            return { ok: !error, status: error ? 409 : 200, json: async () => error ? { error: restoreError || 'NORA_BACKUP_CHANGED' } : url.endsWith('/restore-preview')
                ? { worldId: body.worldId, sessionId: body.sessionId, current: { revision: 'current-revision', messageCount: 10 },
                    snapshot: { id: body.id, sha256: 'snapshot-digest', createdAt: 1790630400000, messageCount: 3, swipeCount: 2, mvuState: 'unverified' } }
                : url.endsWith('/restore') ? { status: 'restored', worldId: body.worldId, sessionId: body.sessionId }
                : url.endsWith('/managed')
                ? { snapshots: structuredClone(snapshots), totalBytes: 4096, legacyFiles: 1, warnings: [],
                    policy: { maxPerSession: 20, maxAgeDays: 30, maxBytes: 536870912 },
                    status: { enabled: true, pending: 0, recent: [{ status: 'failed', code: 'ENOSPC' }] } }
                : url.endsWith('/inventory') ? { complete: false, backups: [{ name: 'chat_legacy.jsonl', bytes: 1024, modifiedAt: 1790630400000, owner: { confidence: 'unknown' } }], warnings: [] } : {},
            blob: async () => new Blob(['fixture']) };
        },
    });
    return { controller, select, selectAll, calls, confirmations, downloads, snapshots, text: () => dom.text(),
        accepted: value => { accepted = value; }, failRemove: value => { failRemove = value; }, failList: value => { failList = value; },
        restoreError: value => { restoreError = value; }, reloads: () => reloads,
        hold: value => { hold = value; }, close: () => dom('#modal').empty() };
}

test('backup sheet shows real scope, budget and backup-only errors without injecting markup', async () => {
    const f = fixture();
    await f.controller.open();
    assert.equal(f.selectAll('[data-backup-row]').length, 2);
    assert.equal(f.selectAll('img').length, 0);
    assert.match(f.text(), /所有世界/);
    assert.match(f.text(), /不是完整世界/);
    assert.match(f.text(), /20/);
    assert.match(f.text(), /ENOSPC/);
    assert.doesNotMatch(f.text(), /回复生成失败/);
    assert.equal(f.select('[data-backup-select="b"]').disabled, true);
    assert.equal(f.select('[data-backup-delete]').disabled, true);
    assert.ok(f.select('[data-backup-restore="a"]'));
    assert.equal(f.select('[data-backup-restore="b"]'), null, 'unavailable Worlds do not offer restoration');
    assert.ok(f.calls.every(call => call.headers['X-CSRF-Token'] === 'fixture'));
});

test('restore previews and confirms exact scope, preserves cancellation and requires explicit reload', async () => {
    const f = fixture();
    await f.controller.open();
    f.accepted(false);
    await f.select('[data-backup-restore="a"]').fire();
    assert.equal(f.calls.filter(call => call.url.endsWith('/restore')).length, 0);
    const confirmation = f.confirmations[0];
    assert.equal(confirmation.restoreSheet, true);
    assert.match(confirmation.body, /保护当前聊天/);
    assert.match(confirmation.details.join(' '), /不替换卡片/);
    assert.match(confirmation.details.join(' '), /变量状态未确认/);
    assert.match(confirmation.details.join(' '), /账本.*失效/);
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

test('unknown restore outcome reuses the confirmed proof and busy conflicts never claim success', async () => {
    const f = fixture();
    await f.controller.open();
    f.restoreError('network');
    await f.select('[data-backup-restore="a"]').fire();
    assert.match(f.text(), /尚未确认/);
    assert.doesNotMatch(f.text(), /聊天已恢复/);
    assert.equal(f.select('[data-backup-protect="a"]').disabled, true);
    assert.equal(f.select('[data-backup-delete]').disabled, true);
    f.restoreError('');
    await f.select('[data-backup-restore="a"]').fire();
    const requests = f.calls.filter(call => call.url.endsWith('/restore'));
    assert.deepEqual(requests[0].body, requests[1].body);
    assert.equal(f.calls.filter(call => call.url.endsWith('/restore-preview')).length, 1);
    assert.match(f.text(), /聊天已恢复/);
    const busy = fixture();
    busy.restoreError('NORA_CHAT_OPERATION_BUSY');
    await busy.controller.open();
    await busy.select('[data-backup-restore="a"]').fire();
    assert.match(busy.text(), /其他页面|生成|占用/);
    assert.doesNotMatch(busy.text(), /聊天已恢复/);
});

test('backup rows distinguish observed MVU states without claiming complete World restoration', async () => {
    const f = fixture();
    f.snapshots[0].mvuState = 'confirmed';
    f.snapshots[1].mvuState = 'pending';
    await f.controller.open();
    assert.match(f.text(), /变量更新已确认/);
    assert.match(f.text(), /变量更新中/);
    f.snapshots[0].mvuState = 'incomplete';
    delete f.snapshots[1].mvuState;
    await f.select('[data-backup-refresh]').fire();
    assert.match(f.text(), /变量更新未完成/);
    assert.match(f.text(), /变量状态未确认/);
    assert.match(f.text(), /不是完整世界存档/);
});

test('download uses the selected snapshot, cancel deletes nothing, and protection changes update selection eligibility', async () => {
    const f = fixture();
    await f.controller.open();
    await f.select('[data-backup-download="a"]').fire();
    assert.equal(f.downloads[0]?.name, 'chat_nora1_a.jsonl');
    const input = f.select('[data-backup-select="a"]');
    input.checked = true;
    await input.fire('change');
    assert.equal(f.select('[data-backup-delete]').disabled, false);
    f.accepted(false);
    await f.select('[data-backup-delete]').fire();
    assert.equal(f.calls.filter(call => call.url.endsWith('/remove')).length, 0);
    assert.equal(f.confirmations[0]?.restoreSheet, true);
    await f.select('[data-backup-protect="a"]').fire();
    assert.equal(f.select('[data-backup-select="a"]').disabled, true);
    assert.equal(f.select('[data-backup-delete]').disabled, true);
    await f.select('[data-backup-protect="a"]').fire();
    assert.equal(f.select('[data-backup-select="a"]').disabled, false);
});

test('batch deletion reports partial failure, leaves failed rows selected, and old files have preview only', async () => {
    const f = fixture();
    f.snapshots[1].protected = false;
    await f.controller.open();
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
    f.failList(true);
    await f.select('[data-backup-refresh]').fire();
    assert.match(f.text(), /NORA_BACKUP_CHANGED/);
    assert.equal(f.select('[data-backup-protect="a"]').disabled, true);
    assert.equal(f.select('[data-backup-refresh]').disabled, false);
});

test('selection survives pagination and successful deletion is reported as a result, not an error', async () => {
    const f = fixture();
    f.snapshots[1].protected = false;
    for (let i = 2; i < 22; i++) f.snapshots.push({ ...f.snapshots[0], id: `copy-${i}` });
    await f.controller.open();
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
