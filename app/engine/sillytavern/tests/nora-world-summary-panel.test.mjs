import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const sourceDir = process.env.NORA_PANEL_FIXTURE_DIR;
const panel = fs.readFileSync(sourceDir ? path.join(sourceDir, 'panel-controller.js') : path.join(root, 'native-extensions/nora-ui/panel-controller.js'), 'utf8');
const story = fs.readFileSync(sourceDir ? path.join(sourceDir, 'story-context.js') : path.join(root, 'engine/sillytavern/public/scripts/nora-worlds/story-context.js'), 'utf8');
const executable = text => text.replace(/^import .*;\n/gm, '').replace(/^export /gm, '');

function render({ format = 'nora-world-card/2', count = 7, editing = false, disabled = false } = {}) {
    const members = Array.from({ length: count }, (_, i) => ({ id: `actor-${i}`, profile: { identity: { name: `Actor ${i}` } }, persistent_status: {}, activation: i < 5 ? { mode: 'constant' } : { mode: 'triggered', keys: [`key-${i}`] } }));
    if (disabled && members[5]) members[5].activation.enabled = false;
    const storyContext = { ...(format ? { card_format: format } : {}), characters: members, relationships: [] };
    const world = { id: 'world:fixture', name: 'World title', storyContext, preset: { name: 'Independent preset' } };
    const card = { name: 'World title', description: 'Reader summary' };
    const body = { innerHTML: '' };
    let edit;
    const sandbox = {
        tr: text => text,
        t: (strings, ...values) => strings.reduce((s, part, i) => s + part + (values[i] ?? ''), ''),
        projectTextModelDisplay: () => ({ label: 'Model' }),
        buildCuratorReviewLink: () => '', storyProfileHref: () => '/profile',
    };
    vm.createContext(sandbox);
    vm.runInContext(executable(story) + '\n' + executable(panel), sandbox);
    const controller = sandbox.createPanelController({
        activeWorldModel: () => world, currentCharacter: () => card,
        readState: () => ({ activeCharacterId: 0 }), settings: () => ({}),
        currentWorldPersona: () => ({ name: 'Player' }), characterField: (c, key) => c?.[key],
        escapeHtml: value => String(value ?? ''), icons: {}, worldbookSummary: () => '',
        select: () => body,
        selectAll: selector => selector === '[data-edit-section="cast"]' ? [{ addEventListener: (_type, handler) => { edit = handler; } }] : [],
        currentUrl: () => 'http://localhost/',
    });
    controller.render();
    if (editing) edit({ stopPropagation() {} });
    return body.innerHTML;
}

test('world card renders seven array characters, never a synthetic eighth card profile', () => {
    const html = render();
    assert.equal((html.match(/data-cast-character=/g) || []).length, 7);
    assert.ok(!html.includes('data-cast-character="0"'));
    assert.match(html, /世界概要/);
    assert.match(html, /Reader summary/);
});

test('world card with no characters has no legacy edit or injection controls', () => {
    const html = render({ count: 0, editing: true });
    assert.ok(!html.includes('data-cast-edit="0"'));
    assert.ok(!html.includes('data-cast-toggle="card-profile"'));
    assert.match(html, /添加第一条设定/);
});

test('unmarked and v1 legacy cards keep their editable card profile', () => {
    for (const format of [null, 'nora-world-card/1']) {
        const html = render({ format, count: 0, editing: true });
        assert.match(html, /data-cast-character="0"/);
        assert.match(html, /data-cast-toggle="card-profile"/);
        assert.ok(!html.includes('世界概要'));
    }
});

test('all seven array edit targets remain available', () => {
    const html = render({ editing: true });
    for (let i = 0; i < 7; i++) assert.ok(html.includes(`data-cast-edit="world-character:actor-${i}"`));
    assert.doesNotMatch(html, /data-copy-character|fa-copy/);
    assert.doesNotMatch(render(), /data-copy-character|fa-copy/);
});

test('v2.3.5 integration keeps independent-world-preset UI', () => {
    assert.match(render(), /data-action="world-preset"/);
    assert.match(render(), /Independent preset/);
});

test('cast uses the same constant/triggered group headings and styles as world settings', () => {
    const html = render({ disabled: true });
    const constant = html.indexOf('常驻角色');
    const triggered = html.indexOf('触发角色');
    assert.ok(constant >= 0 && triggered > constant);
    for (let i = 0; i < 5; i++) {
        const position = html.indexOf(`data-cast-character="world-character:actor-${i}"`);
        assert.ok(position > constant && position < triggered);
    }
    for (let i = 5; i < 7; i++) assert.ok(html.indexOf(`data-cast-character="world-character:actor-${i}"`) > triggered);
    assert.match(html, /loreSummaryItem is-triggered is-disabled/);
    assert.match(html, /loreGroupTitle is-triggered/);
});

test('empty groups have explanatory placeholders', () => {
    const html = render({ count: 0 });
    assert.match(html, /暂无常驻角色/);
    assert.match(html, /暂无触发角色/);
});

test('actor read-only detail displays trigger keys without entering edit mode', () => {
    const characterSource = fs.readFileSync(sourceDir ? path.join(sourceDir, 'character-controller.js') : path.join(root, 'native-extensions/nora-ui/character-controller.js'), 'utf8');
    for (const mode of ['constant', 'triggered']) {
        let markup = '';
        const member = { id: 'actor', profile: { identity: { name: 'Actor' } }, persistent_status: {}, activation: { mode, enabled: false, keys: ['<news>', '采访'] } };
        const sandbox = { tr: text => text, t: (strings, ...values) => strings.reduce((s, part, i) => s + part + (values[i] ?? ''), '') };
        vm.createContext(sandbox);
        vm.runInContext(executable(story) + '\n' + executable(characterSource), sandbox);
        sandbox.createCharacterController({
            readState: () => ({}), activeWorldModel: () => ({ storyContext: { characters: [member], relationships: [] } }),
            characterField: (card, key) => card?.data?.[key],
            characterCapabilities: () => ({ regexScripts: [], helperScripts: [] }), worldbookEntries: () => [],
            escapeHtml: value => String(value ?? '').replaceAll('<', '&lt;').replaceAll('>', '&gt;'),
            dialogs: { open: (_title, html) => { markup = html; return {}; } }, select: () => null,
        }).openSheet('world-character:actor');
        assert.match(markup, /进入方式/);
        assert.match(markup, /已关闭/);
        if (mode === 'triggered') {
            assert.match(markup, /触发词：&lt;news&gt;、采访/);
            assert.ok(!markup.includes('<news>'));
        } else assert.match(markup, /常驻：无需关键词触发/);
    }
});
