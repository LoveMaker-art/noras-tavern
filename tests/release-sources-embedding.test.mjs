import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';
import {test} from 'node:test';
import {embedReleaseSources, RELEASE_SOURCE_ENTRY_PATHS} from '../tooling/release/embed-release-sources.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const defaultSources = JSON.parse(fs.readFileSync(path.join(root,'launcher/desktop/release-sources.json'),'utf8'));
function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'nora-source-embedding-'));
  t.after(() => fs.rmSync(directory, {recursive: true, force: true}));
  const files = [...RELEASE_SOURCE_ENTRY_PATHS.map(paths => paths[0]),
    'launcher/desktop/release-sources.json', 'launcher/desktop/release-sources.js',
    'launcher/desktop/launcher-errors.js', 'launcher/desktop/launcher-error-catalog.json',
    'launcher/desktop/telemetry-contract.json'];
  for (const relative of files) {
    if (!fs.existsSync(path.join(root, relative))) continue;
    fs.mkdirSync(path.dirname(path.join(directory, relative)), {recursive: true});
    fs.copyFileSync(path.join(root, relative), path.join(directory, relative));
  }
  fs.writeFileSync(path.join(directory, 'launcher/desktop/release-sources.json'), JSON.stringify(defaultSources));
  return directory;
}

test('default sources are already embedded and source export has zero derived delta', t => {
  const directory = fixture(t), report = embedReleaseSources(directory, {check: true});
  assert.equal(report.schema, 'nora-embedded-release-sources/1');
  assert.match(report.configurationSha256, /^[a-f0-9]{64}$/);
  assert.equal(report.files.length, 6);
  assert.ok(report.files.every(file => !file.changed && file.beforeSha256 === file.afterSha256));
});

test('all standalone entries seal the same changed configuration and regeneration is idempotent', t => {
  const directory = fixture(t);
  const configuration = {schema: 1, primary: 'jihulab', mirrors: [{id: 'jihulab', provider: 'jihulab',
    baseUrl: 'https://jihulab.com/api/v4/projects/123/packages/generic/nora-tavern/',
    channelBaseUrl: 'https://jihulab.com/fixture/nora/-/raw/release-channels/'}]};
  fs.writeFileSync(path.join(directory, 'launcher/desktop/release-sources.json'), JSON.stringify(configuration));
  assert.throws(() => embedReleaseSources(directory, {check: true}), /stale/);
  const generated = embedReleaseSources(directory);
  assert.ok(generated.files.every(file => file.changed && file.beforeSha256 !== file.afterSha256));
  for (const [relative] of RELEASE_SOURCE_ENTRY_PATHS) {
    assert.ok(fs.readFileSync(path.join(directory, relative), 'utf8').includes(JSON.stringify(configuration)));
  }
  assert.ok(embedReleaseSources(directory, {check: true}).files.every(file => !file.changed));
});

test('invalid provider roots and missing source blocks fail before rewriting any entry', t => {
  const directory = fixture(t), entry = RELEASE_SOURCE_ENTRY_PATHS[0][0];
  const original = fs.readFileSync(path.join(directory, entry));
  const file = path.join(directory, 'launcher/desktop/release-sources.json');
  const config = JSON.parse(fs.readFileSync(file));
  fs.writeFileSync(file, JSON.stringify({...config, mirrors: [{id: 'jihulab', provider: 'jihulab',
    baseUrl: 'https://evil.example/api/v4/projects/123/packages/generic/nora/',
    channelBaseUrl: 'https://jihulab.com/fixture/nora/-/raw/release-channels/'}]}));
  assert.throws(() => embedReleaseSources(directory), /来源配置/);
  assert.deepEqual(fs.readFileSync(path.join(directory, entry)), original);
  fs.writeFileSync(file, JSON.stringify(config));
  fs.writeFileSync(path.join(directory, RELEASE_SOURCE_ENTRY_PATHS[5][0]), '# no sealed sources');
  assert.throws(() => embedReleaseSources(directory), /marker/);
  assert.deepEqual(fs.readFileSync(path.join(directory, entry)), original);
});

test('embedding rejects ports unsupported by standalone entries while JS fixtures retain their contract', t => {
  const directory = fixture(t), entry = RELEASE_SOURCE_ENTRY_PATHS[0][0];
  const original = fs.readFileSync(path.join(directory, entry));
  const configuration = {schema: 1, primary: 'domestic', mirrors: [{id: 'domestic',
    baseUrl: 'https://127.0.0.1:8443/nora/'}]};
  fs.writeFileSync(path.join(directory, 'launcher/desktop/release-sources.json'), JSON.stringify(configuration));
  assert.doesNotThrow(() => createRequire(import.meta.url)(path.join(directory, 'launcher/desktop/release-sources.js'))
    .validateSources(configuration), 'The JS local TLS fixture contract stays intact');
  assert.throws(() => embedReleaseSources(directory), /standalone.*443/i);
  assert.deepEqual(fs.readFileSync(path.join(directory, entry)), original);
});
