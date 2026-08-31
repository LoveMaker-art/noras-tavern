import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const engineRoot = path.resolve(import.meta.dirname, '..');
const appRoot = path.resolve(engineRoot, '../..');
const projectRoot = path.resolve(appRoot, '..');
const read = filePath => fs.readFileSync(filePath, 'utf8');

test('only World Core v2 owns World writes after legacy migration', () => {
    for (const relativePath of [
        'src/nora-world-registry.js',
        'src/nora-import-registry.js',
        'src/endpoints/nora-imports.js',
        'src/migrate-nora-world-registry.js',
        'public/scripts/nora-worlds/world-registry-client.js',
    ]) {
        assert.equal(fs.existsSync(path.join(engineRoot, relativePath)), false, `${relativePath} must be retired`);
    }

    const startup = read(path.join(engineRoot, 'src/server-startup.js'));
    for (const retiredPath of [
        'src/endpoints/nora-worlds.js',
        'src/nora-world-core/legacy-world-reader.js',
        'public/scripts/nora-worlds/world-runtime.js',
        'public/scripts/nora-worlds/legacy-world-reader-client.js',
    ]) assert.equal(fs.existsSync(path.join(engineRoot, retiredPath)), false, `${retiredPath} must stay offline`);
    const creationController = read(path.join(appRoot, 'native-extensions/nora-ui/world-creation-controller.js'));
    const worldClient = read(path.join(engineRoot, 'public/scripts/nora-worlds/world-core-client.js'));

    assert.doesNotMatch(startup, /noraImports|\/api\/nora-imports/);
    assert.doesNotMatch(creationController, /runtime\.importCharacter|worldRuntime\.create\(|openWorldLibrarySheet/);
    assert.match(creationController, /worldRuntime\.importCard/);
    assert.match(creationController, /worldRuntime\.createBlank/);
    assert.match(worldClient, /\/api\/nora-worlds-v2/);
    assert.match(worldClient, /\/imports/);
    assert.doesNotMatch(worldClient, /\/api\/nora-imports/);
});

test('World lists never reconstruct product identity from recent chats', () => {
    const uiStore = read(path.join(appRoot, 'native-extensions/nora-ui/ui-store.js'));
    const worldController = read(path.join(appRoot, 'native-extensions/nora-ui/world-controller.js'));
    const v2Runtime = read(path.join(engineRoot, 'public/scripts/nora-worlds/world-core-runtime.js'));

    assert.doesNotMatch(uiStore, /recentWorlds|replaceRecentWorlds/);
    assert.doesNotMatch(worldController, /recentWorlds|listRecentWorlds|__NORA_CHATS_PROMISE__/);
    assert.match(v2Runtime, /manifests = await client\.list\(\)/);
});

test('Story Profile and migration tooling consume authoritative v2 Worlds with an auditable read-only fallback', () => {
    const storyProfile = read(path.join(engineRoot, 'src/nora-story-profile.js'));
    const migration = read(path.join(engineRoot, 'src/nora-world-core/legacy-migration.js'));
    const migrationCli = read(path.join(projectRoot, 'ops/scripts/migrate-nora-worlds-v2.mjs'));

    assert.match(storyProfile, /resolveNoraWorldCore/);
    assert.doesNotMatch(storyProfile, /NoraWorldRegistry|nora-world-registry/);
    for (const category of [
        'duplicate_binding',
        'same_source_multiple_worlds',
        'orphan_card',
        'orphan_chat',
        'missing_runtime_card',
        'missing_chat',
        'missing_worldbook',
        'empty_chat',
        'corrupt_record',
    ]) assert.match(migration, new RegExp(category));
    assert.match(migration, /NORA_WORLD_NEEDS_REPAIR/);
    assert.match(migrationCli, /--apply requires --backup-root/);
    assert.match(migrationCli, /never deletes legacy data/i);
});
