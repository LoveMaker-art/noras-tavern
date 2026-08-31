const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { prepareImport } = require('../src/install/prepare-import');
const { ingestProject, buildProject } = require('../src/project/project-engine');
const { exportCardV2, exportCardV3 } = require('../src/core/card-model');

test('V2/V3 export removes six legacy narrative aliases, preserves data and vendor metadata', () => {
  const raw = JSON.parse(fs.readFileSync(path.join(__dirname, '../fixtures/empty-v2.json')));
  const fields = ['name', 'description', 'personality', 'scenario', 'first_mes', 'mes_example'];
  for (const field of fields) raw[field] = 'stale V1 value';
  raw.vendor_root = { keep: true };
  for (const exported of [exportCardV2(raw), exportCardV3(raw)]) {
    for (const field of fields) {
      assert.equal(Object.hasOwn(exported, field), false);
      assert.equal(exported.data[field], raw.data[field]);
    }
    assert.deepEqual(exported.vendor_root, raw.vendor_root);
  }
});

function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cardforge-import-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const project = path.join(root, 'project');
  const uploads = path.join(root, 'uploads');
  fs.mkdirSync(uploads);
  ingestProject(path.join(__dirname, '../fixtures/empty-v2.json'), project);
  const built = buildProject(project);
  return { root, project, uploads, built, options: { uploadRoot: uploads, idempotencyKey: 'test:world:one' } };
}

test('JSON handoff preserves exact bytes, reuses asset but not intentional operation identity', t => {
  const f = fixture(t);
  const preview = prepareImport(f.project, { ...f.options, dryRun: true });
  assert.equal(preview.mcpCall.ready, false);
  assert.deepEqual(fs.readdirSync(f.uploads), []);
  const first = prepareImport(f.project, f.options);
  assert.equal(first.stage, 'prepared');
  assert.equal(first.runtimeVerified, false);
  assert.equal(first.worldChanged, false);
  assert.equal(first.mcpCall.arguments.confirm, undefined);
  assert.deepEqual(fs.readFileSync(first.stagedPath), fs.readFileSync(first.artifact));
  const retry = prepareImport(f.project, f.options);
  assert.equal(retry.reused, true);
  assert.deepEqual(retry.mcpCall, first.mcpCall);
  const second = prepareImport(f.project, { ...f.options, idempotencyKey: 'test:world:two' });
  assert.equal(second.stagedPath, first.stagedPath);
  assert.notEqual(second.recovery.operationId, first.recovery.operationId);
  assert.equal(fs.readdirSync(f.uploads).length, 1);
});

test('rejects invalid authorization keys, roots and failed build before staging', t => {
  const f = fixture(t);
  for (const key of [undefined, '', ' key ', true, 'x'.repeat(201)]) {
    assert.throws(() => prepareImport(f.project, { ...f.options, idempotencyKey: key }), { code: 'IMPORT_KEY_REQUIRED' });
  }
  assert.throws(() => prepareImport(f.project, { ...f.options, uploadRoot: 'relative' }), { code: 'IMPORT_ROOT_REQUIRED' });
  const manifestFile = path.join(f.project, 'reports/build-manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestFile));
  manifest.quality.passed = false;
  fs.writeFileSync(manifestFile, JSON.stringify(manifest));
  assert.throws(() => prepareImport(f.project, f.options), { code: 'IMPORT_BUILD_INVALID' });
  assert.deepEqual(fs.readdirSync(f.uploads), []);
});

test('rejects artifact hash drift instead of importing modified generated files', t => {
  const f = fixture(t);
  fs.appendFileSync(path.join(f.project, f.built.manifest.artifacts.v2Json), '\n');
  assert.throws(() => prepareImport(f.project, f.options), { code: 'IMPORT_ARTIFACT_CHANGED' });
  assert.deepEqual(fs.readdirSync(f.uploads), []);
});

test('rejects path traversal and project symlinks', t => {
  const f = fixture(t);
  const manifestFile = path.join(f.project, 'reports/build-manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestFile));
  const artifact = path.join(f.project, manifest.artifacts.v2Json);
  const outside = path.join(f.root, 'outside.json');
  fs.copyFileSync(artifact, outside);
  fs.unlinkSync(artifact);
  fs.symlinkSync(outside, artifact);
  assert.throws(() => prepareImport(f.project, f.options), { code: 'IMPORT_PATH_INVALID' });
  for (const relative of ['../outside.json', outside]) {
    manifest.artifacts.v2Json = relative;
    fs.writeFileSync(manifestFile, JSON.stringify(manifest));
    assert.throws(() => prepareImport(f.project, f.options), { code: 'IMPORT_PATH_INVALID' });
  }
});

test('never overwrites conflicting staged files or symlink targets', t => {
  const f = fixture(t);
  const preview = prepareImport(f.project, { ...f.options, dryRun: true });
  fs.writeFileSync(preview.stagedPath, 'user content');
  assert.throws(() => prepareImport(f.project, f.options), { code: 'IMPORT_STAGING_CONFLICT' });
  assert.equal(fs.readFileSync(preview.stagedPath, 'utf8'), 'user content');
  fs.unlinkSync(preview.stagedPath);
  fs.symlinkSync(preview.artifact, preview.stagedPath);
  assert.throws(() => prepareImport(f.project, f.options), { code: 'IMPORT_STAGING_CONFLICT' });
  assert.equal(fs.lstatSync(preview.stagedPath).isSymbolicLink(), true);
});

test('valid hash alone cannot hide a manifest/card name mismatch', t => {
  const f = fixture(t);
  const manifestFile = path.join(f.project, 'reports/build-manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestFile));
  manifest.card.name = 'another card';
  fs.writeFileSync(manifestFile, JSON.stringify(manifest));
  assert.throws(() => prepareImport(f.project, f.options), { code: 'IMPORT_CARD_MISMATCH' });
  assert.deepEqual(fs.readdirSync(f.uploads), []);
});

test('opaque extensions and scripts survive a build and prepared handoff', t => {
  const f = fixture(t);
  const source = path.join(f.project, 'source/passthrough.json');
  const raw = JSON.parse(fs.readFileSync(source));
  raw.data.extensions.vendor_extension = { arbitrary: [1, { value: 'keep' }] };
  raw.data.extensions.tavern_helper.scripts.push({ type: 'script', id: 'preserved-script', name: 'test', enabled: false, content: '/* never execute during build */' });
  fs.writeFileSync(source, JSON.stringify(raw));
  buildProject(f.project);
  const prepared = prepareImport(f.project, f.options);
  const output = JSON.parse(fs.readFileSync(prepared.stagedPath));
  assert.deepEqual(output.data.extensions.vendor_extension, raw.data.extensions.vendor_extension);
  assert.equal(output.data.extensions.tavern_helper.scripts[0].content, raw.data.extensions.tavern_helper.scripts[0].content);
  assert.equal(crypto.createHash('sha256').update(fs.readFileSync(prepared.stagedPath)).digest('hex'), prepared.artifactSha256);
});
