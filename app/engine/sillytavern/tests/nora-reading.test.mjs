import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { parse as parseCss } from '@adobe/css-tools';
import { load as loadHtml } from 'cheerio';
import { READING_FIELDS, READING_SCHEMA, normalizeReadingValues, projectReading } from '../public/scripts/nora-worlds/reading-preferences.js';
import { READING_FILE, readReadingPreferences as read, saveReadingPreferences as save } from '../src/nora-world-core/reading-preferences.js';
import { createNoraWorldsV2Router } from '../src/endpoints/nora-worlds-v2.js';
import { createNoraWorldCore, NoraWorldCoreError } from '../src/nora-world-core/index.js';
import { mergeRuntimeSettings } from '../src/settings-runtime.js';
import { createControlBroker } from '../src/nora-control-broker.js';
import { createRuntimeControls } from '../public/scripts/nora-controls/runtime.js';
import { validateControl } from '../public/scripts/nora-controls/contract.js';
import { createReadingController } from '../../../native-extensions/nora-ui/reading-controller.js';

function temporary(t) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nora-reading-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    return { root };
}
const inspect = (dirs, worldId = '') => read(dirs, { scope: worldId ? 'world' : 'global', worldId });
function patch(dirs, values, worldId = '', revision = inspect(dirs, worldId).revision, options) {
    return save(dirs, { scope: worldId ? 'world' : 'global', ...(worldId ? { worldId } : {}), values, expectedRevision: revision }, options);
}
function surface() {
    const styles = new Map(); const listeners = new Map(); const attributes = new Map();
    return { scrollTop: 200, scrollHeight: 1000, clientHeight: 300,
        style: { getPropertyValue: k => styles.get(k)?.[0] || '', getPropertyPriority: k => styles.get(k)?.[1] || '',
            setProperty: (k, v, p = '') => styles.set(k, [v, p]), removeProperty: k => styles.delete(k) },
        getAttribute: k => attributes.get(k) ?? null, setAttribute: (k, v) => attributes.set(k, v), removeAttribute: k => attributes.delete(k),
        addEventListener: (k, f) => listeners.set(k, f), removeEventListener: (k, f) => { if (listeners.get(k) === f) listeners.delete(k); },
        fire: k => listeners.get(k)?.(), getBoundingClientRect: () => ({ top: 0 }), querySelectorAll: () => [],
    };
}
const response = value => ({ ok: true, json: async () => value });
function client(dirs, { id = 'a', fetcher, element = surface(), scheduleFrame = f => f() } = {}) {
    let worldId = id;
    const controller = createReadingController({ select: () => element, getWorldId: () => worldId,
        requestHeaders: () => ({ 'Content-Type': 'application/json' }), scheduleFrame,
        fetcher: fetcher || (async (url, options) => {
            const query = Object.fromEntries(new URL(url, 'http://localhost').searchParams);
            return response(options.body ? save(dirs, JSON.parse(options.body)) : read(dirs, query));
        }) });
    return { controller, element, switch: id => { worldId = id; controller.render(); } };
}

test('stylesheet reading rules target prose, use approved built-in spacing and exclude card widgets/navigation', () => {
    const css = fs.readFileSync(new URL('../../../native-extensions/nora-ui/style.css', import.meta.url), 'utf8');
    const rules = parseCss(css).stylesheet.rules.filter(rule => rule.type === 'rule'
        && rule.declarations.some(declaration => declaration.value?.includes('var(--nora-reading-')));
    const $ = loadHtml(`<nav><p id="nav">Menu</p></nav><div id="nora-chat">
      <div class="mes"><div class="mes_text"><p id="story">Story</p><p id="last">End</p></div></div>
      <div class="mes nora-rich-message"><div class="mes_text"><p id="prose">Story</p>
        <p id="widget"><button>Card button</button></p><div id="status" class="status">Status</div><iframe id="frame"></iframe></div></div>
      </div>`);
    const fontRules = rules.filter(rule => rule.declarations.some(declaration => declaration.property === 'font-size'));
    const matches = (id, candidates) => candidates.some(rule => rule.selectors.some(selector => $(`#${id}`).is(selector)));
    assert.equal(matches('prose', fontRules), true);
    for (const id of ['widget', 'status', 'frame', 'nav']) assert.equal(matches(id, rules), false, id);
    for (const rule of rules) assert.equal(rule.declarations.some(declaration => ['font-family', 'white-space'].includes(declaration.property)), false);
    const paragraphs = rules.filter(rule => rule.declarations.some(declaration => declaration.property === 'margin-bottom'));
    assert.equal(matches('story', paragraphs), true, 'Unset paragraph spacing uses the approved built-in default');
    for (const rule of paragraphs) assert.equal(rule.declarations.find(d => d.property === 'margin-bottom').value, 'var(--nora-reading-paragraph-spacing, 10px)');
    $('#nora-chat').attr('data-nora-reading-paragraph-spacing', '');
    assert.equal(matches('story', paragraphs), true); assert.equal(matches('last', paragraphs), false);
    assert.match(css, /margin:\s*30px auto 0 !important/);
});

test('numeric policy accepts boundaries/zero, rejects coercion, off-step and CSS/prototype fields', () => {
    for (const [key, spec] of Object.entries(READING_FIELDS)) {
        assert.equal(normalizeReadingValues({ [key]: spec.min })[key], spec.min);
        assert.equal(normalizeReadingValues({ [key]: spec.max })[key], spec.max);
        for (const value of [spec.min - spec.step, spec.max + spec.step, spec.min + spec.step / 2, '18', NaN, Infinity, true, null]) {
            assert.throws(() => normalizeReadingValues({ [key]: value }), { code: 'NORA_READING_INVALID' });
        }
    }
    for (const value of [[], null, { font_size: '18px;display:none' }, { weight: 600 }, JSON.parse('{"__proto__":18}')]) assert.throws(() => normalizeReadingValues(value));
    assert.deepEqual(projectReading({ font_size: 18, line_height: 1.8, paragraph_spacing: 0 }), {
        '--nora-reading-font-size': '18px', '--nora-reading-line-height': '1.8', '--nora-reading-paragraph-spacing': '0px',
    });
});

test('persistent defaults, per-World partial patches and reset inherit without rewriting other user content', t => {
    const dirs = temporary(t), other = temporary(t);
    for (const name of ['settings.json', 'chat.jsonl', 'USER.md', 'MEMORY.md', 'world.json']) fs.writeFileSync(path.join(dirs.root, name), `KEEP:${name}`);
    const builtIn = inspect(dirs, 'a');
    for (const role of ['assistant', 'user']) assert.deepEqual(builtIn.effective[role], { font_size: 17, line_height: 1.75, paragraph_spacing: 10 });
    assert.equal(fs.existsSync(path.join(dirs.root, READING_FILE)), false, 'Built-in defaults do not materialize user overrides');
    patch(dirs, { font_size: 18, line_height: 1.8 });
    patch(dirs, { font_size: 20, paragraph_spacing: 0 }, 'a');
    patch(dirs, { paragraph_spacing: 12 }, 'b');
    const a = inspect(dirs, 'a');
    assert.deepEqual(a.values, { font_size: 20, paragraph_spacing: 0 });
    assert.equal(a.effective.user.line_height, 1.8);
    assert.deepEqual(a.sources, { font_size: 'world', line_height: 'global', paragraph_spacing: 'world' });
    patch(dirs, { font_size: null }, 'a');
    assert.equal(inspect(dirs, 'a').effective.assistant.font_size, 18);
    patch(dirs, { line_height: null, font_size: null, paragraph_spacing: null });
    assert.equal(inspect(dirs, 'a').effective.assistant.font_size, 17);
    assert.equal(inspect(dirs, 'a').effective.assistant.paragraph_spacing, 0);
    assert.equal(inspect(dirs, 'b').values.paragraph_spacing, 12);
    assert.deepEqual(inspect(other).values, {});
    for (const name of ['settings.json', 'chat.jsonl', 'USER.md', 'MEMORY.md', 'world.json']) assert.equal(fs.readFileSync(path.join(dirs.root, name), 'utf8'), `KEEP:${name}`);
    if (process.platform !== 'win32') assert.equal(fs.statSync(path.join(dirs.root, READING_FILE)).mode & 0o777, 0o600);
});

test('stale CAS, invalid payload and atomic write failure preserve the last successful bytes', t => {
    const dirs = temporary(t); const first = patch(dirs, { font_size: 18 });
    patch(dirs, { line_height: 1.8 }, 'a');
    const before = fs.readFileSync(path.join(dirs.root, READING_FILE));
    assert.throws(() => patch(dirs, { font_size: 20 }, '', first.revision), { code: 'NORA_READING_REVISION_CONFLICT' });
    assert.throws(() => patch(dirs, { line_height: 9 }), { code: 'NORA_READING_INVALID' });
    assert.throws(() => patch(dirs, { font_size: 22 }, '', undefined, { write: () => { throw Object.assign(Error('disk full'), { code: 'ENOSPC' }); } }), { code: 'NORA_READING_WRITE_FAILED' });
    assert.deepEqual(fs.readFileSync(path.join(dirs.root, READING_FILE)), before);
    assert.equal(patch(dirs, { font_size: 18 }).changed, false);
    assert.equal(fs.readdirSync(dirs.root).length, 1);
});

test('malformed, unknown schema and linked preferences remain untouched; reset cannot destroy them', t => {
    const dirs = temporary(t); const file = path.join(dirs.root, READING_FILE);
    const revision = inspect(dirs).revision;
    for (const raw of ['{broken', JSON.stringify({ schema: 'future/2', defaults: {}, worlds: {} }), JSON.stringify({ schema: READING_SCHEMA, defaults: { weight: 900 }, worlds: {} })]) {
        fs.writeFileSync(file, raw);
        assert.throws(() => inspect(dirs), { code: 'NORA_READING_UNREADABLE' });
        assert.throws(() => patch(dirs, { font_size: null }, '', revision), { code: 'NORA_READING_UNREADABLE' });
        assert.equal(fs.readFileSync(file, 'utf8'), raw);
    }
    fs.unlinkSync(file); const outside = path.join(dirs.root, 'other.json'); fs.writeFileSync(outside, 'KEEP');
    fs.symlinkSync(outside, file);
    assert.throws(() => inspect(dirs), { code: 'NORA_READING_UNREADABLE' });
    assert.equal(fs.readFileSync(outside, 'utf8'), 'KEEP');
});

test('existing World loading and stale ordinary-settings saves leave independent reading preferences intact', async t => {
    const dirs = temporary(t); const worldRoot = path.join(dirs.root, 'world-core');
    const materializer = { async materialize(_command, { worldId }) { return {
        runtimeCard: { engine: 'sillytavern', binding: { avatar: `${worldId}.png` }, ownership: 'owned' },
        defaultSession: { engine: 'sillytavern', binding: { chat_id: 'chat' } }, knowledge: [], declaredCapabilities: [],
    }; } };
    const core = createNoraWorldCore({ root: worldRoot, materializer });
    const world = (await core.createWorld({ name: 'Keep story', persona: { name: 'Player', description: '' }, source: { type: 'manual', sha256: '', original_name: '', format: 'json' } }, { idempotencyKey: 'keep' })).world;
    patch(dirs, { font_size: 24 }, world.world_id);
    const before = fs.readFileSync(path.join(dirs.root, READING_FILE));
    const settings = mergeRuntimeSettings({ extension_settings: { nora_ui: { lastWorldId: 'a' } } }, { extension_settings: { nora_ui: { lastWorldId: 'b' } } });
    fs.writeFileSync(path.join(dirs.root, 'settings.json'), JSON.stringify(settings));
    const reopened = createNoraWorldCore({ root: worldRoot, materializer });
    assert.deepEqual(await reopened.getWorld(world.world_id), world);
    assert.deepEqual(fs.readFileSync(path.join(dirs.root, READING_FILE)), before);
});

async function server(t) {
    const users = { a: temporary(t), b: temporary(t) };
    const app = express(); app.use(express.json());
    app.use((req, _res, next) => { req.user = { directories: users[req.headers['x-user'] || 'a'] }; next(); });
    app.use('/api/nora-worlds-v2', createNoraWorldsV2Router({ resolveCore: req => ({ getWorld: async id => {
        if (id !== `${req.headers['x-user'] || 'a'}-world`) throw new NoraWorldCoreError('NORA_WORLD_NOT_FOUND', 'World not owned.');
        return { world_id: id };
    } }) }));
    const listener = app.listen(0, '127.0.0.1'); await new Promise(resolve => listener.once('listening', resolve));
    t.after(() => new Promise(resolve => listener.close(resolve)));
    const base = `http://127.0.0.1:${listener.address().port}`;
    return { users, fetcher: (url, options) => fetch(base + url, options) };
}

test('actual HTTP validates user/World scope, revisions and requests independently of open-World activation', async t => {
    const { users, fetcher } = await server(t);
    const first = await fetcher('/api/nora-worlds-v2/reading?scope=global');
    assert.equal(first.headers.get('cache-control'), 'no-store');
    const value = await first.json();
    const post = body => fetcher('/api/nora-worlds-v2/reading', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    assert.equal((await post({ scope: 'global', values: { font_size: 18 }, expectedRevision: value.revision })).status, 200);
    assert.equal((await post({ scope: 'global', values: { font_size: 20 }, expectedRevision: value.revision })).status, 409);
    assert.equal((await fetcher('/api/nora-worlds-v2/reading?scope=world&worldId=b-world')).status, 404);
    assert.equal((await fetcher('/api/nora-worlds-v2/reading?scope=bad')).status, 400);
    assert.equal((await post({ scope: 'global', values: { font_size: '20' }, expectedRevision: inspect(users.a).revision })).status, 400);
    assert.equal(inspect(users.b).values.font_size, undefined);
});

test('real broker → runtime executor → HTTP → persistent store → renderer → receipt; no World reopening or generation', async t => {
    const { users, fetcher } = await server(t);
    const f = client(users.a, { id: 'a-world', fetcher });
    const identity = { clientId: 'reading-client', worldId: 'a-world', sessionId: 'session-a' };
    const broker = createControlBroker(temporary(t).root);
    const auth = { ...identity, ...broker.hello(identity) };
    const controls = createRuntimeControls({ getContext: () => ({ characterId: 0, characters: [{}],
        chatMetadata: { nora_world: { id: identity.worldId }, nora_session: { id: identity.sessionId } } }),
        story: { messages: { isGenerating: () => false } }, assertIdle() {},
        dispatch: () => ({ execute: async command => ({ status: 'completed', value: await command.run() }) }),
        globalRef: { NoraUI: { controlReading: f.controller.execute } } });
    let sequence = 0;
    async function invoke(action, params = {}) {
        const created = broker.submit({ ...identity, action, params, confirm: true, idempotencyKey: `reading-${++sequence}` });
        const command = await broker.poll(auth, null, 1);
        const result = await controls.execute(command);
        broker.ack({ ...auth, id: created.id, status: 'completed', result });
        assert.equal(broker.inspect(created.id).status, 'completed');
        return broker.inspect(created.id).result;
    }
    const catalog = await invoke('reading.catalog'); assert.equal(catalog.fields.font_size.max, 32);
    let state = await invoke('reading.inspect', { scope: 'global' });
    const saved = await invoke('reading.apply', { scope: 'global', values: { font_size: 19, paragraph_spacing: 0 }, expectedRevision: state.revision });
    assert.equal(saved.saved, true); assert.equal(saved.applied, true); assert.equal(saved.visualVerified, false);
    assert.equal(saved.renderer.revision, saved.revision);
    assert.equal(f.element.style.getPropertyValue('--nora-reading-font-size'), '19px');
    assert.equal(f.element.style.getPropertyValue('--nora-reading-paragraph-spacing'), '0px');
    state = await invoke('reading.inspect', { scope: 'world' });
    await invoke('reading.apply', { scope: 'world', values: { font_size: 22 }, expectedRevision: state.revision });
    state = await invoke('reading.inspect', { scope: 'world' });
    await invoke('reading.reset', { scope: 'world', field: 'all', expectedRevision: state.revision });
    assert.equal(f.element.style.getPropertyValue('--nora-reading-font-size'), '19px');
    const reopened = client(users.a, { id: 'a-world', fetcher }); reopened.controller.render(); await reopened.controller.settled();
    assert.equal(reopened.element.style.getPropertyValue('--nora-reading-font-size'), '19px');
    assert.throws(() => validateControl({ action: 'reading.apply', params: {}, confirm: false }), { code: 'NORA_CONFIRMATION_REQUIRED' });
    assert.throws(() => validateControl({ action: 'reading.reset', params: { scope: 'global', field: 'all', expectedRevision: state.revision }, confirm: true }, { readOnly: true }), { code: 'NORA_CONTROL_WRITE_DENIED' });
});

test('global reading works without an active World and corrupt preferences do not prevent renderer/world switching', async t => {
    const dirs = temporary(t), f = client(dirs, { id: '' });
    const state = await f.controller.execute('reading.inspect', { scope: 'global' });
    const result = await f.controller.execute('reading.apply', { scope: 'global', values: { line_height: 2 }, expectedRevision: state.revision });
    assert.equal(result.applied, true);
    await assert.rejects(f.controller.execute('reading.inspect', { scope: 'world' }), { code: 'NORA_READING_INVALID' });
    fs.writeFileSync(path.join(dirs.root, READING_FILE), '{corrupt');
    f.switch('other'); await f.controller.settled();
    assert.equal(f.controller.inspect().ready, false); assert.equal(f.controller.inspect().error.code, 'NORA_READING_UNREADABLE');
    assert.equal(f.element.style.getPropertyValue('--nora-reading-font-size'), '');
});

test('runtime global controls need no character, model or script permission; World scope still requires a World', async t => {
    const dirs = temporary(t), f = client(dirs, { id: '' });
    const controls = createRuntimeControls({ getContext: () => ({}), story: { messages: { isGenerating: () => false } },
        assertIdle() {}, globalRef: { NoraUI: { controlReading: f.controller.execute } } });
    const command = (action, params) => ({ action, params, worldId: '', sessionId: '', confirm: true });
    const before = await controls.execute(command('reading.inspect', { scope: 'global' }));
    const result = await controls.execute(command('reading.apply', { scope: 'global', values: { font_size: 18 }, expectedRevision: before.revision }));
    assert.equal(result.saved, true); assert.equal(result.applied, true);
    await assert.rejects(controls.execute(command('reading.inspect', { scope: 'world' })), { code: 'NORA_CONTROL_NO_WORLD' });
});

test('inspect rejects a switched World, failed save never claims success and empty overrides retain built-in styling', async t => {
    const dirs = temporary(t); let id = 'a';
    const f = createReadingController({ select: () => surface(), getWorldId: () => id, requestHeaders: () => ({}), scheduleFrame: f => f(),
        fetcher: async () => { id = 'b'; return response(inspect(dirs, 'a')); } });
    await assert.rejects(f.execute('reading.inspect', { scope: 'world' }), { code: 'NORA_CONTROL_SCOPE_CHANGED' });
    const g = client(dirs); g.controller.render(); await g.controller.settled();
    assert.equal(g.element.getAttribute('data-nora-reading-paragraph-spacing'), null);
    await assert.rejects(g.controller.execute('reading.apply', { scope: 'world', values: { font_size: 20 }, expectedRevision: 'stale' }), { code: 'NORA_READING_REVISION_CONFLICT' });
    assert.deepEqual(inspect(dirs, 'a').values, {});
    assert.equal(fs.existsSync(path.join(dirs.root, READING_FILE)), false);
});

test('World switches clear overrides immediately and late responses cannot overwrite the new World', async t => {
    const dirs = temporary(t); patch(dirs, { font_size: 18 }); patch(dirs, { font_size: 22 }, 'a'); patch(dirs, { font_size: 24 }, 'b');
    const held = [];
    const f = client(dirs, { fetcher: async url => new Promise(resolve => {
        held.push(() => resolve(response(read(dirs, Object.fromEntries(new URL(url, 'http://local').searchParams)))));
    }) });
    f.controller.render(); held.shift()(); await f.controller.settled();
    assert.equal(f.element.style.getPropertyValue('--nora-reading-font-size'), '22px');
    f.switch('b'); assert.equal(f.element.style.getPropertyValue('--nora-reading-font-size'), '18px');
    const old = held.shift();
    f.switch('a'); held.shift()(); await f.controller.settled();
    old(); await new Promise(resolve => setImmediate(resolve));
    assert.equal(f.element.style.getPropertyValue('--nora-reading-font-size'), '22px');
    assert.equal(f.controller.inspect().worldId, 'a');
});

test('save success / failed application are separate; refresh recovers without a second write', async t => {
    const dirs = temporary(t); let failRead = false, writes = 0;
    const f = client(dirs, { fetcher: async (url, options) => {
        if (options.body) { writes++; const result = save(dirs, JSON.parse(options.body)); failRead = true; return response(result); }
        if (failRead) throw Error('connection lost');
        return response(read(dirs, Object.fromEntries(new URL(url, 'http://local').searchParams)));
    } });
    f.controller.render(); await f.controller.settled();
    const saved = await f.controller.execute('reading.apply', { scope: 'world', values: { font_size: 20 }, expectedRevision: inspect(dirs).revision });
    assert.equal(saved.saved, true); assert.equal(saved.applied, false); assert.equal(saved.reopenRequired, true);
    assert.equal(inspect(dirs, 'a').values.font_size, 20);
    failRead = false;
    const applied = await f.controller.execute('reading.refresh'); assert.equal(applied.applied, true); assert.equal(writes, 1);
});

test('reading style ownership restores inline values and preserves a visible anchor or latest position', async t => {
    const dirs = temporary(t); patch(dirs, { font_size: 20 });
    const frames = [], element = surface(); let y = 10;
    const anchor = { isConnected: true, getBoundingClientRect: () => ({ top: y, bottom: y + 100 }) };
    element.querySelectorAll = () => [anchor];
    element.style.setProperty('--nora-reading-font-size', '17px', 'important');
    const f = client(dirs, { element, scheduleFrame: callback => frames.push(callback) });
    f.controller.render(); await f.controller.settled(); frames.splice(0).forEach(f => f());
    const refresh = f.controller.execute('reading.refresh'); await refresh;
    y = 80; frames.splice(0).forEach(f => f()); assert.equal(element.scrollTop, 270);
    await f.controller.execute('reading.refresh'); y = 100; element.fire('wheel'); frames.splice(0).forEach(f => f());
    assert.equal(element.scrollTop, 270, 'User scroll intent cancels anchor restoration');
    element.scrollTop = 700; await f.controller.execute('reading.refresh'); element.scrollHeight = 1200; frames.splice(0).forEach(f => f());
    assert.equal(element.scrollTop, 1200);
    await f.controller.execute('reading.reset', { scope: 'global', field: 'all', expectedRevision: inspect(dirs).revision });
    assert.equal(element.style.getPropertyValue('--nora-reading-font-size'), '17px');
    assert.equal(element.style.getPropertyPriority('--nora-reading-font-size'), 'important');
});
