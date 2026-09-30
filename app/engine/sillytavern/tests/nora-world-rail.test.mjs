import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';

const source = fs.readFileSync(new URL('../../../native-extensions/nora-ui/shell-controller.js', import.meta.url), 'utf8')
    .replace(/^import .*;\n/gm, '').replace(/^export /gm, '');

function harness({ mobile = false, stored = null, storageBlocked = false } = {}) {
    const classes = new Set();
    const nodes = new Map();
    const listeners = {};
    const writes = [];
    const document = { activeElement: null, body: { classList: {
        add: (...names) => names.forEach(name => classes.add(name)),
        remove: (...names) => names.forEach(name => classes.delete(name)),
        contains: name => classes.has(name),
        toggle(name, force = !classes.has(name)) { force ? classes.add(name) : classes.delete(name); },
    } }, addEventListener: (name, callback) => { listeners[name] = callback; } };
    const select = id => {
        if (!nodes.has(id)) nodes.set(id, { attrs: {}, handlers: {},
            setAttribute(name, value) { this.attrs[name] = value; },
            getAttribute(name) { return this.attrs[name]; },
            contains: node => node?.inRail === true,
            focus() { document.activeElement = this; },
            querySelector: select,
            addEventListener(name, callback) { this.handlers[name] = callback; },
        });
        return nodes.get(id);
    };
    const media = { matches: mobile, addEventListener: (_name, callback) => { media.changed = callback; } };
    const window = { matchMedia: () => media, localStorage: {
        getItem() { if (storageBlocked) throw new Error('Denied'); return stored; },
        setItem(key, value) { if (storageBlocked) throw new Error('Denied'); writes.push([key, value]); },
    } };
    const create = vm.runInNewContext(`${source}\ncreateShellController`, { window, document,
        tr: text => text, createComposerFormatController: () => ({ mount() {} }),
        createViewportController: () => ({ mount() {} }), console,
    });
    const shell = create({ select, selectAll: () => [], icons: {}, messageView: { mountRuntime() {} }, exposeMessageApi() {} });
    shell.buildLayout();
    shell.bindLayoutEvents({ closeModal() {} });
    const toggle = () => select('#nora-rail-toggle').handlers.click();
    return { shell, select, media, classes, writes, document, listeners, toggle, window };
}

test('desktop toggle preserves layout and records a reversible browser preference', () => {
    const h = harness();
    const rail = h.select('#nora-rail');
    const button = h.select('#nora-rail-toggle');
    assert.equal(button.attrs['aria-expanded'], 'true');
    assert.equal(button.attrs.title, '收起世界栏');
    h.toggle();
    assert.equal(h.classes.has('nora-rail-collapsed'), true);
    assert.equal(rail.inert, true);
    assert.equal(button.attrs.title, '展开世界栏');
    assert.equal(h.classes.has('nora-rail-open'), false, 'desktop never opens a scrim');
    h.shell.closeDrawers();
    h.shell.buildLayout();
    assert.equal(h.classes.has('nora-rail-collapsed'), true, 'world navigation and shell refresh retain preference');
    h.toggle();
    assert.equal(h.select('#nora-rail'), rail, 'do not rebuild the world list');
    assert.equal(rail.inert, false);
    assert.deepEqual(h.writes, [['nora.ui.world-rail-collapsed', 'true'], ['nora.ui.world-rail-collapsed', 'false']]);
});

test('shell message bridge preserves toast, confirmation, errors and character capability targeting', () => {
    const h = harness();
    const calls = [];
    let messageController;
    const selected = { name: 'selected' }, requested = { name: 'requested' };
    h.shell.installMessageApi({
        showToast: (...args) => calls.push(['toast', ...args]),
        confirmAction: value => calls.push(['confirm', value]),
        getMessageController: () => messageController,
        readState: () => ({ characters: [selected, requested], activeCharacterId: 0 }),
        promptCharacterCapabilities: (character, options) => calls.push(['capability', character.name, options]),
    });
    messageController = { showSendError: error => calls.push(['error', error]) };
    h.window.__NORA_MESSAGES__.toast('hello');
    h.window.__NORA_MESSAGES__.confirm('confirm');
    h.window.__NORA_MESSAGES__.composerError('failure');
    h.window.__NORA_CONFIRM_CHARACTER_CAPABILITIES__({ characterName: 'requested', refresh: true });
    h.window.__NORA_CONFIRM_CHARACTER_REGEX__();
    assert.deepEqual(calls.slice(0, 3), [['toast', 'hello', undefined], ['confirm', 'confirm'], ['error', 'failure']]);
    assert.equal(calls[3][1], 'requested');
    assert.equal(calls[3][2].refresh, true);
    assert.equal(calls[3][2].force, true);
    assert.equal(calls[4][1], 'selected');
});

test('reload restores collapse and unavailable storage never blocks toggling', () => {
    const restored = harness({ stored: 'true' });
    assert.equal(restored.select('#nora-rail').attrs['aria-hidden'], 'true');
    restored.toggle();
    assert.equal(restored.select('#nora-rail').inert, false);
    const blocked = harness({ storageBlocked: true });
    blocked.toggle(); blocked.toggle();
    assert.equal(blocked.select('#nora-rail').inert, false);
});

test('Helper confirmation targets the requested avatar among same-name Worlds and never falls back after deletion', async () => {
    const h = harness();
    const calls = [];
    const characters = [{ name: 'Same', avatar: 'a.png' }, { name: 'Same', avatar: 'b.png' }];
    h.shell.installMessageApi({
        readState: () => ({ characters, activeCharacterId: 0 }),
        promptCharacterCapabilities: character => { calls.push(character.avatar); return true; },
    });
    assert.equal(await h.window.__NORA_CONFIRM_CHARACTER_CAPABILITIES__({ characterAvatar: 'b.png' }), true);
    assert.equal(await h.window.__NORA_CONFIRM_CHARACTER_CAPABILITIES__({ characterAvatar: 'deleted.png' }), false);
    assert.deepEqual(calls, ['b.png']);
});

test('mobile drawers and breakpoint changes do not overwrite desktop preference', () => {
    const h = harness({ stored: 'true', mobile: true });
    h.toggle();
    assert.equal(h.select('#nora-rail').inert, false);
    assert.equal(h.classes.has('nora-rail-open'), true);
    h.shell.openDrawer('panel');
    assert.equal(h.select('#nora-rail').inert, true);
    h.toggle();
    h.media.matches = false; h.media.changed();
    assert.equal(h.classes.has('nora-rail-open'), false);
    assert.equal(h.select('#nora-rail').inert, true);
    h.media.matches = true; h.media.changed();
    assert.equal(h.select('#nora-rail').inert, true);
    assert.deepEqual(h.writes, []);
});

test('closing an active mobile drawer restores focus; Escape does not reopen a desktop rail', () => {
    const h = harness({ mobile: true });
    h.toggle();
    h.document.activeElement = { inRail: true };
    h.listeners.keydown({ key: 'Escape' });
    assert.equal(h.document.activeElement, h.select('#nora-rail-toggle'));
    assert.equal(h.select('#nora-rail').attrs['aria-expanded'], undefined);
    assert.equal(h.select('#nora-rail-toggle').attrs['aria-expanded'], 'false');
    h.media.matches = false; h.media.changed();
    h.toggle();
    h.listeners.keydown({ key: 'Escape' });
    assert.equal(h.classes.has('nora-rail-collapsed'), true);
});

test('CSS keeps the desktop toggle reachable and collapse styles outside mobile layout', () => {
    const css = fs.readFileSync(new URL('../../../native-extensions/nora-ui/style.css', import.meta.url), 'utf8');
    assert.match(css, /#nora-topbar \{[^}]*display: flex/);
    assert.doesNotMatch(css, /#nora-rail-toggle\s*\{[^}]*display:\s*none/);
    assert.match(css, /@media \(min-width: 761px\) \{[^]*?body\.nora-rail-collapsed #nora-rail/);
    assert.match(css, /@media \(prefers-reduced-motion: reduce\) \{ #nora-rail \{ transition: none;/);
});

test('early shell toggles and hands the current preference to hydrated controls', () => {
    const html = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
    const start = html.indexOf('function renderEarlyRail(');
    const end = html.indexOf("\n            try { document.body.classList.toggle('nora-rail-collapsed'", start);
    assert.ok(start > 0 && end > start);
    const h = harness();
    h.document.getElementById = id => h.select(`#${id}`);
    const early = vm.runInNewContext(`${html.slice(start, end)}\nrenderEarlyRail`, {
        document: h.document, matchMedia: h.window.matchMedia, localStorage: h.window.localStorage, tr: text => text,
    });
    early(true);
    assert.equal(h.classes.has('nora-rail-collapsed'), true);
    h.shell.bindLayoutEvents({ closeModal() {} });
    assert.equal(h.select('#nora-rail-toggle').attrs['aria-expanded'], 'false');
    h.toggle();
    assert.equal(h.select('#nora-rail').inert, false);
    h.media.matches = true;
    early(true);
    assert.equal(h.classes.has('nora-rail-open'), true);
    assert.equal(h.select('#nora-rail-toggle').attrs['aria-expanded'], 'true');
});
