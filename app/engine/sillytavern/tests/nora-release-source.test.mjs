import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { assertSafeReleasePath, assertSafeReleaseContent, createReleaseSource, collectRuntimeFiles, groupRuntimeModules, releaseModuleFor } from '../../../../ops/scripts/release-source.mjs';

test('release guards reject runtime/private paths and credential contents without echoing them', () => {
    for (const file of ['app/.env', 'app/engine/sillytavern/data/default-user/secrets.json', 'app/audit-runtime.log', 'app/__pycache__/a.pyc', '../app/x', 'app/x\ny']) assert.throws(() => assertSafeReleasePath(file));
    assert.doesNotThrow(() => assertSafeReleasePath('app/native-extensions/nora-ui/settings-store.js'));
    assert.throws(() => assertSafeReleaseContent('app/example.js', Buffer.from('-----BEGIN ' + 'PRIVATE KEY-----')), /Potential credential/);
});

test('release rejects model state even without a recognizable secret format', () => {
    for (const file of [
        'app/model_configs.json', 'ops/model_configs.json.bak', 'app/prepared/model-input.json',
        'app/tavern-state/anything.json', 'app/secrets.json.backup',
    ]) assert.throws(() => assertSafeReleasePath(file), /forbidden/);
    const file = 'app/engine/sillytavern/default/content/settings.json';
    for (const data of [
        { oai_settings: { custom_model: 'developer-model' } },
        { oai_settings: { custom_url: 'https://developer.invalid/v1' } },
        { extension_settings: { nora_ui: { modelProfiles: [{ id: 'developer' }] } } },
        { extension_settings: { nora_ui: { hermesModel: { model: 'developer-model' } } } },
        { extension_settings: { nora_ui: { activeModel: 'developer' } } },
        { extension_settings: { apiKey: 'ordinary-fixture-credential' } },
        { nai_settings: { model_novel: 'developer-model' } },
    ]) assert.throws(() => assertSafeReleaseContent(file, Buffer.from(JSON.stringify(data))), /Model configuration/);
    assert.doesNotThrow(() => assertSafeReleaseContent(file, Buffer.from(JSON.stringify({
        main_api: 'openai', oai_settings: { chat_completion_source: 'custom', custom_model: '', custom_url: '' },
        extension_settings: { nora_ui: { modelProfiles: [], activeModel: '' } },
    }))));
});

test('shipped defaults have no selected model, endpoint, credential or saved profile', () => {
    const file = 'app/engine/sillytavern/default/content/settings.json';
    const bytes = fs.readFileSync(new URL('../default/content/settings.json', import.meta.url));
    const data = JSON.parse(bytes);
    assert.equal(data.api_server, '');
    assert.equal(data.main_api, 'openai');
    assert.equal(data.oai_settings.chat_completion_source, 'custom');
    assert.equal(data.oai_settings.custom_model, '');
    assert.equal(data.oai_settings.custom_url, '');
    assert.deepEqual(data.extension_settings.nora_ui.modelProfiles, []);
    assert.equal(data.extension_settings.nora_ui.activeModel, '');
    assert.equal(data.extension_settings.nora_ui.hermesModel, undefined);
    assert.doesNotThrow(() => assertSafeReleaseContent(file, bytes));
});

test('source export excludes ignored private files and stable mode rejects uncommitted changes', (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tavern-package-fixture-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const git = args => execFileSync('git', args, { cwd: root, stdio: 'pipe' });
    git(['init', '-q']);
    fs.mkdirSync(path.join(root, 'app'));
    fs.writeFileSync(path.join(root, '.gitignore'), '.env\n*.log\ndata/\n');
    fs.writeFileSync(path.join(root, 'app/main.js'), 'export const ready = true;\n');
    git(['add', '.']);
    git(['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgSign=false', 'commit', '-qm', 'fixture']);
    fs.writeFileSync(path.join(root, 'app/.env'), 'FAKE_PRIVATE=fixture');
    fs.writeFileSync(path.join(root, 'app/audit-runtime.log'), 'FAKE_PRIVATE');
    const snapshot = createReleaseSource(root);
    t.after(() => fs.rmSync(snapshot.stage, { recursive: true, force: true }));
    assert.equal(fs.existsSync(path.join(snapshot.stage, 'app/.env')), false);
    assert.equal(fs.existsSync(path.join(snapshot.stage, 'app/audit-runtime.log')), false);
    assert.equal(snapshot.identity.dirty, false);
    fs.appendFileSync(path.join(root, 'app/main.js'), '// changed\n');
    assert.throws(() => createReleaseSource(root), /clean committed tree/);
    fs.writeFileSync(path.join(root, 'model_configs.json'), '{"configs":[]}');
    assert.throws(() => createReleaseSource(root, { candidate: true }), /forbidden/,
        'private files at repository root must not enter GitHub source exports either');
});

test('delivery allowlist rejects obsolete CLI names and keeps developer-only files out of runtime archives', t => {
    const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'tavern-delivery-fixture-'));
    t.after(() => fs.rmSync(stage, { recursive: true, force: true }));
    const retained = [
        'app/engine/sillytavern/src/nora-story-statistics.js',
        'app/engine/sillytavern/public/webfonts/fa-solid-900.woff2',
        'app/engine/sillytavern/public/webfonts/fa-brands-400.woff2',
        'app/engine/sillytavern/public/locales/lang.json',
        'app/engine/sillytavern/public/locales/en.json',
        'app/engine/sillytavern/public/locales/zh-cn.json',
        'app/engine/sillytavern/public/locales/zh-tw.json',
        'app/engine/sillytavern/public/lib/jquery-3.5.1.min.js',
        'ops/scripts/runtime.sh', 'ops/scripts/bringup-native.sh', 'ops/scripts/provision.sh',
        'ops/scripts/profile_memory.py', 'ops/scripts/install-hermes-skills.py',
        'ops/scripts/analyze-boot-metrics.mjs', 'ops/scripts/analyze-runtime-phases.mjs',
        'ops/scripts/nora-tavern-update-check.sh', 'ops/scripts/nora-tavern-card-send.py',
        'ops/skills/INSTALL.md', 'ops/skills/agents-tavern.md',
        'ops/skills/creative/tavern/SKILL.md', 'ops/skills/creative/tavern/references/story-profile.md',
        'ops/skills/creative/tavern-ops/SKILL.md', 'ops/skills/system/tavern-updater/references/release-compatibility.md',
        'ops/skills/system/tavern-updater/scripts/update.py', 'ops/updater/update.py',
        'ops/skills/creative/nora-cardforge/src/cli/main.js', 'ops/skills/creative/nora-cardforge/SKILL.md',
        'nora-mcp/package.json', 'nora-mcp/npm-shrinkwrap.json', 'nora-mcp/README.md',
    ];
    const excluded = [
        'app/engine/sillytavern/default/content/backgrounds/sample.png',
        'app/engine/sillytavern/default/content/default_Seraphina.png',
        'app/engine/sillytavern/default/content/Seraphina/joy.png',
        'app/engine/sillytavern/default/content/Eldoria.json',
        'app/engine/sillytavern/public/webfonts/NotoSans/stylesheet.css',
        'app/engine/sillytavern/public/webfonts/NotoSans/NotoSans-Regular.woff2',
        'app/engine/sillytavern/public/webfonts/NotoSansMono/noto-sans-mono-v30-regular.woff2',
        'app/engine/sillytavern/src/tokenizers/llama3.json',
        'app/engine/sillytavern/src/tokenizers/gemma.model',
        'app/engine/sillytavern/src/tokenizers/claude.json',
        'app/engine/sillytavern/public/locales/ru-ru.json',
        'app/engine/sillytavern/public/locales/fr-fr.json',
        'app/engine/sillytavern/public/lib/pdf.min.mjs',
        'app/engine/sillytavern/public/lib/pdf.worker.min.mjs',
        'app/engine/sillytavern/public/lib/epub.min.js',
        'app/engine/sillytavern/public/lib/jszip.min.js',
        'ops/scripts/tavern_cli.py', 'ops/scripts/native_tavern.py', 'ops/scripts/package-release.mjs',
        'ops/scripts/verify-product-workflows.mjs', 'ops/scripts/migrate-nora-worlds-v2.mjs',
        'ops/scripts/index-project.mjs', 'ops/tests/test-install.py', 'ops/specialists/retired/SKILL.md',
        'ops/skills/creative/retired/SKILL.md', 'ops/skills/creative/tavern/scripts/retired.py',
        'app/engine/sillytavern/tests/nora-world-theme.test.mjs',
        'nora-mcp/src/server.ts', 'nora-mcp/tests/discovery.test.mjs',
        'ops/skills/creative/nora-cardforge/tests/smoke.js', 'ops/skills/creative/nora-cardforge/agents/openai.yaml',
    ];
    const generated = ['app/engine/sillytavern/public/dist/nora/entry.js', 'app/engine/sillytavern/dist/_webpack/output/vendor.js', 'nora-mcp/dist/server.js'];
    for (const file of [...retained, ...excluded, ...generated]) {
        fs.mkdirSync(path.dirname(path.join(stage, file)), { recursive: true });
        fs.writeFileSync(path.join(stage, file), '// fixture');
    }
    const delivery = collectRuntimeFiles(stage, [...retained, ...excluded]);
    assert.deepEqual(delivery, [...retained, ...generated].sort());
    for (const file of excluded) assert.ok(fs.existsSync(path.join(stage, file)), `${file} remains available to source/build tests`);
});

test('runtime artifacts have stable, disjoint incremental module ownership', () => {
    const fixtures = {
        'app/engine/sillytavern/public/dist/nora/entry.js': 'nora-web',
        'app/engine/sillytavern/src/nora-world-core/index.js': 'nora-runtime',
        'app/engine/sillytavern/src/server-main.js': 'tavern-engine',
        'app/native-extensions/nora-mvu/index.js': 'extension-nora-mvu',
        'app/story_profile_runtime/core/story_profile.py': 'story-profile',
        'app/native_lifecycle.py': 'nora-runtime',
        'nora-mcp/dist/server.js': 'nora-mcp',
        'ops/updater/update.py': 'updater',
        'ops/skills/creative/tavern/SKILL.md': 'skills',
        'ops/scripts/runtime.sh': 'operations',
    };
    for (const [file, module] of Object.entries(fixtures)) assert.equal(releaseModuleFor(file), module);
    const grouped = groupRuntimeModules(Object.keys(fixtures));
    assert.deepEqual([...grouped.values()].flat().sort(), Object.keys(fixtures).sort());
});

test('installed product exposes only English and Chinese locales and no bundled document converters', () => {
    const languages = JSON.parse(fs.readFileSync(new URL('../public/locales/lang.json', import.meta.url)));
    assert.deepEqual(languages.map(item => item.lang), ['zh-cn', 'zh-tw']);
    const chats = fs.readFileSync(new URL('../public/scripts/chats.js', import.meta.url), 'utf8');
    const utils = fs.readFileSync(new URL('../public/scripts/utils.js', import.meta.url), 'utf8');
    assert.doesNotMatch(chats, /application\/(?:pdf|epub\+zip)/);
    assert.doesNotMatch(utils, /pdf\.min\.mjs|pdf\.worker\.min\.mjs|epub\.min\.js|jszip\.min\.js/);
});

test('default content index cannot reference assets excluded from the installed product', t => {
    const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'tavern-content-index-fixture-'));
    t.after(() => fs.rmSync(stage, { recursive: true, force: true }));
    for (const dir of ['app/engine/sillytavern/public/dist/nora', 'app/engine/sillytavern/dist/_webpack/output', 'nora-mcp/dist']) {
        fs.mkdirSync(path.join(stage, dir), { recursive: true });
    }
    const indexPath = 'app/engine/sillytavern/default/content/index.json';
    const background = 'app/engine/sillytavern/default/content/backgrounds/sample.png';
    fs.mkdirSync(path.dirname(path.join(stage, background)), { recursive: true });
    fs.writeFileSync(path.join(stage, background), 'fixture');
    fs.writeFileSync(path.join(stage, indexPath), JSON.stringify([{ filename: 'backgrounds/sample.png', type: 'background' }]));
    assert.throws(() => collectRuntimeFiles(stage, [indexPath, background]), /index references an omitted release asset/);
    fs.writeFileSync(path.join(stage, indexPath), '[]');
    assert.deepEqual(collectRuntimeFiles(stage, [indexPath, background]), [indexPath]);
});

test('new installations have no sample character, background or dangling default tags', () => {
    const index = JSON.parse(fs.readFileSync(new URL('../default/content/index.json', import.meta.url)));
    assert.ok(index.every(item => !['background', 'character', 'sprites'].includes(item.type)));
    assert.ok(index.every(item => item.filename !== 'Eldoria.json'));
    const settings = JSON.parse(fs.readFileSync(new URL('../default/content/settings.json', import.meta.url)));
    assert.deepEqual(settings.tags, []);
    assert.deepEqual(settings.tag_map, {});
    const backgrounds = fs.readFileSync(new URL('../public/scripts/backgrounds.js', import.meta.url), 'utf8');
    const declaration = backgrounds.match(/export let background_settings = (\{[\s\S]*?\n\});/)[1];
    const defaults = new Function('BG_SORT_OPTIONS', `return (${declaration});`)({ AZ: 'az' });
    assert.equal(defaults.name, '');
    assert.equal(defaults.url, 'none');
    const indexHtml = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
    assert.doesNotMatch(indexHtml, /webfonts\/NotoSans/);
    assert.match(indexHtml, /css\/solid\.min\.css/);
});
