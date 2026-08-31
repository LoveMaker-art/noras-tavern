import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const engineRoot = path.resolve(import.meta.dirname, '..');

test('legacy World readers are offline while explicit migration remains available', () => {
    for (const retiredPath of [
        'src/endpoints/nora-worlds.js',
        'src/nora-world-core/legacy-world-reader.js',
        'public/scripts/nora-worlds/world-runtime.js',
        'public/scripts/nora-worlds/legacy-world-reader-client.js',
    ]) assert.equal(fs.existsSync(path.join(engineRoot, retiredPath)), false, `${retiredPath} must be absent`);

    const migrationPath = path.join(engineRoot, 'src/nora-world-core/legacy-migration.js');
    assert.equal(fs.existsSync(migrationPath), true, 'offline migration must remain available');
    const migration = fs.readFileSync(migrationPath, 'utf8');
    assert.match(migration, /export async function migrateLegacyWorlds/);
    assert.doesNotMatch(migration, /express\.Router|app\.use\(/, 'migration must not register an online request path');
});
