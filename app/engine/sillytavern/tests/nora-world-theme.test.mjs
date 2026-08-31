import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { normalizeWorldTheme, projectWorldTheme } from '../public/scripts/nora-worlds/world-theme.js';
import { createWorldThemeController } from '../../../native-extensions/nora-ui/world-theme-controller.js';
import { createNoraWorldCore } from '../src/nora-world-core/index.js';
import { importThemeBackground, validateThemeAssets } from '../src/nora-world-core/theme-assets.js';
import { createThemeActions } from '../public/scripts/nora-controls/theme-actions.js';
import { validateControl } from '../public/scripts/nora-controls/contract.js';
import { createNoraWorldsV2Router } from '../src/endpoints/nora-worlds-v2.js';

test('old visual schema only: presets, colors, desktop/mobile backgrounds; defaults add nothing', () => {
    assert.deepEqual(projectWorldTheme({}), { properties: {}, readingSurface: 'plain' });
    const value = normalizeWorldTheme({ theme: { font: 'literary', narration_font: 'classic', text: '#abc', overlay: '#11223388', content_width: 560, background_fit_mobile: 'contain' }, assets: { background_desktop: '/backgrounds/example.png' } });
    const projected = projectWorldTheme(value);
    assert.equal(projected.properties['--nora-content'], '560px');
    assert.equal(projected.properties['--world-image'], 'url("/backgrounds/example.png")');
    assert.equal(projected.properties['--world-image-mobile'], projected.properties['--world-image']);
    assert.equal(projected.properties['--world-fit-mobile'], 'contain');
    for (const invalid of [null, [], { version: 2 }, { theme: { font: 'url(evil)' } }, { theme: { content_width: 10 } },
        { theme: { text: 'red;display:none' } }, { theme: { html: '<b>hi</b>' } }, { items: [] },
        { assets: { background: 'javascript:alert(1)' } }, { assets: { background: 'https://user:password@example.org/x' } },
        { assets: { background: '/backgrounds/..%2fsecret.png' } }, { assets: { background: '/backgrounds/a.svg' } },
        JSON.parse('{"theme":{"__proto__":{}}}')]) {
        assert.throws(() => normalizeWorldTheme(invalid), { code: 'NORA_WORLD_THEME_INVALID' });
    }
});

function element() {
    const values = new Map(); const attrs = new Map();
    return { style: { setProperty: (k, v, priority = '') => values.set(k, [v, priority]),
        getPropertyValue: k => values.get(k)?.[0] || '', getPropertyPriority: k => values.get(k)?.[1] || '', removeProperty: k => values.delete(k) },
    setAttribute: (k, v) => attrs.set(k, v), removeAttribute: k => attrs.delete(k), getAttribute: k => attrs.get(k) };
}
test('renderer modifies only existing stage/panel styles and restores overrides on switch/clear', () => {
    const stage = element(); const panel = element(); const rail = element();
    stage.style.setProperty('--nora-ink', '#123456', 'important');
    const targets = { '#nora-stage': stage, '#nora-panel': panel, '#nora-rail': rail };
    const renderer = createWorldThemeController(selector => targets[selector]);
    renderer.render({ id: 'a', ui: { theme: { text: '#fff', font: 'classic', reading_surface: 'glass' } } });
    assert.equal(stage.style.getPropertyValue('--nora-ink'), '#fff');
    assert.equal(rail.style.getPropertyValue('--nora-ink'), '');
    assert.equal(stage.getAttribute('data-world-reading-surface'), 'glass');
    renderer.render({ id: 'b' });
    assert.equal(stage.style.getPropertyValue('--nora-ink'), '#123456');
    assert.equal(stage.style.getPropertyPriority('--nora-ink'), 'important');
    assert.equal(panel.style.getPropertyValue('--nora-ink'), '');
    assert.equal(stage.getAttribute('data-world-reading-surface'), undefined);
    renderer.render({ id: 'b', ui: { theme: { font: 'typewriter' } } });
    renderer.render({ id: 'b', ui: {} });
    assert.equal(stage.style.getPropertyValue('--world-font'), '');
    assert.equal(renderer.inspect().visualVerified, false);
});

async function temporary(t) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'nora-theme-test-'));
    t.after(() => fs.rm(root, { recursive: true, force: true })); return root;
}
test('theme persistence uses World revisions, keeps data unchanged and survives reopening', async t => {
    const root = await temporary(t);
    const materializer = { async materialize(_command, { worldId }) { return {
        runtimeCard: { engine: 'sillytavern', binding: { avatar: `${worldId}.png` }, ownership: 'owned' },
        defaultSession: { engine: 'sillytavern', binding: { chat_id: 'chat' } }, knowledge: [], declaredCapabilities: [],
    }; } };
    const core = createNoraWorldCore({ root, materializer });
    const command = { name: 'Fixture', persona: { name: 'Player', description: '' }, source: { type: 'manual', sha256: '', original_name: '', format: 'json' } };
    const a = (await core.createWorld(command, { idempotencyKey: 'a' })).world;
    const b = (await core.createWorld(command, { idempotencyKey: 'b' })).world;
    const updated = await core.setWorldTheme(a.world_id, { theme: { font: 'classic', text: '#fff' } }, { expectedRevision: a.revision });
    for (const field of ['persona', 'sessions', 'runtime_card', 'knowledge', 'capabilities']) assert.deepEqual(updated[field], a[field]);
    assert.equal((await core.getWorld(b.world_id)).ui, undefined);
    assert.deepEqual((await createNoraWorldCore({ root, materializer }).prepareOpen(a.world_id)).ui, updated.ui);
    await assert.rejects(core.setWorldTheme(a.world_id, {}, { expectedRevision: a.revision }), { code: 'NORA_WORLD_REVISION_CONFLICT' });
    await assert.rejects(core.setWorldTheme(a.world_id, { script: '' }, { expectedRevision: updated.revision }), { code: 'NORA_WORLD_INVALID' });
    const cleared = await core.setWorldTheme(a.world_id, {}, { expectedRevision: updated.revision });
    assert.deepEqual(cleared.ui, normalizeWorldTheme({}));
});

test('background import is content addressed, rejects traversal/symlinks and never modifies a world', async t => {
    const root = await temporary(t); const source = path.join(root, 'input.png'); const images = path.join(root, 'backgrounds');
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZQmcAAAAASUVORK5CYII=', 'base64');
    await fs.writeFile(source, png);
    const a = await importThemeBackground(source, images); const b = await importThemeBackground(source, images);
    assert.equal(a.url, b.url); assert.equal(a.worldChanged, false);
    assert.equal((await fs.readdir(images)).length, 1);
    assert.equal((await validateThemeAssets({ assets: { background: a.url } }, images)).assets.background, a.url);
    await assert.rejects(validateThemeAssets({ assets: { background: '/backgrounds/missing.png' } }, images));
    await fs.symlink(source, path.join(images, 'link.png'));
    await assert.rejects(validateThemeAssets({ assets: { background: '/backgrounds/link.png' } }, images));
    await fs.writeFile(source, '<svg></svg>');
    await assert.rejects(importThemeBackground(source, images));
});

test('control apply persists before refreshing existing World runtime; stale writes, scope drift and clear are explicit', async () => {
    let id = 'world:one'; let revision = 1; let ui = {}; let refreshes = 0;
    const action = createThemeActions({ getContext: () => ({ chatMetadata: { nora_world: { id } } }),
        request: async (_route, body) => body ? (ui = body.ui, revision++, { world: { ui, revision } }) : { plan: { world_revision: revision, ui } },
        story: { worlds: { refresh: async () => { refreshes++; } } }, readTheme: () => ({ worldId: id, ready: true }) });
    const first = await action('theme.inspect', {});
    const saved = await action('theme.apply', { ui: { theme: { font: 'modern' } }, expectedRevision: first.revision });
    assert.equal(saved.saved, true); assert.equal(refreshes, 1); assert.equal(ui.theme.font, 'modern');
    await assert.rejects(action('theme.clear', { expectedRevision: '1' }), { code: 'NORA_CONTROL_EDIT_STALE' });
    await action('theme.clear', { expectedRevision: saved.revision }); assert.deepEqual(ui, normalizeWorldTheme({}));
    assert.throws(() => validateControl({ action: 'theme.apply', params: { ui: {}, expectedRevision: '1' } }), { code: 'NORA_CONFIRMATION_REQUIRED' });
    assert.throws(() => validateControl({ action: 'theme.clear', confirm: true, params: { expectedRevision: '1' } }, { readOnly: true }), { code: 'NORA_CONTROL_WRITE_DENIED' });
    id = ''; await assert.rejects(action('theme.inspect', {}), { code: 'NORA_CONTROL_NO_WORLD' });
});

test('theme reads reject World switches; a refresh failure does not misreport successful persistence as a failed save', async () => {
    let id = 'a';
    const dependencies = { getContext: () => ({ chatMetadata: { nora_world: { id } } }),
        request: async (_route, body) => body ? { world: { revision: 2, ui: body.ui } } : { plan: { world_revision: 1 } },
        story: { worlds: { refresh: async () => { throw Error('disconnected'); } } }, readTheme: () => ({ ready: false }) };
    const result = await createThemeActions(dependencies)('theme.apply', { ui: {}, expectedRevision: '1' });
    assert.equal(result.saved, true); assert.equal(result.reopenRequired, true);
    const switched = createThemeActions({ ...dependencies, request: async () => { id = 'b'; return { plan: { world_revision: 1 } }; } });
    await assert.rejects(switched('theme.inspect', {}), { code: 'NORA_CONTROL_SCOPE_CHANGED' });
});

test('theme HTTP rejects absent ui and missing images before persistence; explicit empty ui clears', async t => {
    const backgrounds = await temporary(t); let writes = 0;
    const router = createNoraWorldsV2Router({ resolveCore: () => ({ setWorldTheme: async (_id, ui) => { writes++; return { ui }; } }) });
    const route = router.stack.find(item => item.route?.path === '/worlds/:worldId/theme').route.stack[0].handle;
    let code = 200; let result;
    const response = { status(value) { code = value; return this; }, json(value) { result = value; return this; }, setHeader() {} };
    const request = { user: { directories: { backgrounds } }, params: { worldId: 'a' }, body: { expected_revision: 1 } };
    await route(request, response); assert.equal(code, 400); assert.equal(writes, 0);
    request.body.ui = { assets: { background: '/backgrounds/no.png' } };
    await route(request, response); assert.equal(code, 400); assert.equal(writes, 0);
    request.body.ui = {}; code = 200;
    await route(request, response); assert.equal(code, 200); assert.equal(writes, 1); assert.deepEqual(result.world.ui, normalizeWorldTheme({}));
});

test('concurrent imports of identical bytes produce one complete background and no temporary files', async t => {
    const root = await temporary(t); const source = path.join(root, 'source.png'); const images = path.join(root, 'images');
    const bytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZQmcAAAAASUVORK5CYII=', 'base64');
    await fs.writeFile(source, bytes);
    const imports = await Promise.all(Array.from({ length: 5 }, () => importThemeBackground(source, images)));
    assert.equal(new Set(imports.map(item => item.url)).size, 1);
    assert.deepEqual(await fs.readdir(images), [imports[0].filename]);
    assert.deepEqual(await fs.readFile(path.join(images, imports[0].filename)), bytes);
});
