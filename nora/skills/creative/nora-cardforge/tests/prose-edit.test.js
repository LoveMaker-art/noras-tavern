const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const { editProse } = require('../src/core/prose-edit');
const { writePngCardData, extractChunks, encodeChunks, decodeCardTextChunk,
  decodeCardPayload } = require('../src/core/card-io');

const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const edit = { path: ['first_mes'], before: '雨落下来。', after: '细雨轻敲窗沿。' };
const raw = () => ({ spec: 'chara_card_v2', spec_version: '2.0', vendor: { keep: true }, data: {
  name: '旅店', first_mes: '{{user}}，雨落下来。<Status/>',
  alternate_greetings: ['雨落下来。'],
  character_book: { entries: [{ id: 12, keys: ['雨'], enabled: false,
    content: '雨落下来。魔力消耗大于20时增加污染。\n_.set("污染", 1);' }] },
  extensions: { tavern_helper: [['scripts', [{ content: 'z.object({能量:z.number()})', enabled: true }]]],
    regex_scripts: [{ findRegex: '<Status/>', replaceString: '<b>状态</b>', disabled: false }],
    custom: { opaque: [3, 'unchanged'] } }
} });

function setup(t, payload = raw(), ext = '.json') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cardforge-prose-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const input = path.join(dir, 'source' + ext);
  const output = path.join(dir, 'candidate' + ext);
  const bytes = Buffer.isBuffer(payload) ? payload : Buffer.from(JSON.stringify(payload));
  fs.writeFileSync(input, bytes);
  const plan = edits => ({ format: 'nora-card-prose/1', sourceSha256: sha(bytes), edits });
  return { dir, input, output, bytes, plan };
}

test('V2 prose edits preserve all unselected data without normalization or execution', t => {
  const s = setup(t);
  const edits = [edit, { ...edit, path: ['character_book', 'entries', 0, 'content'] }];
  const preview = editProse(s.input, s.plan(edits), s.output, { dryRun: true });
  assert.equal(fs.existsSync(s.output), false);
  const result = editProse(s.input, s.plan(edits), s.output);
  assert.equal(result.outputSha256, preview.outputSha256);
  assert.equal(result.verification.runtime, 'not-tested');
  const expected = raw();
  expected.data.first_mes = '{{user}}，细雨轻敲窗沿。<Status/>';
  expected.data.character_book.entries[0].content = '细雨轻敲窗沿。魔力消耗大于20时增加污染。\n_.set("污染", 1);';
  assert.deepEqual(JSON.parse(fs.readFileSync(s.output)), expected);
  assert.deepEqual(fs.readFileSync(s.input), s.bytes);
  assert.equal(Object.hasOwn(expected.data, 'description'), false);
});

test('V1 without MVU and V3 unknown properties keep their original structure', t => {
  for (const payload of [{ name: 'V1', first_mes: '雨落下来。', vendor: 42 },
    { ...raw(), spec: 'chara_card_v3', spec_version: '3.0' }]) {
    const s = setup(t, payload);
    editProse(s.input, s.plan([edit]), s.output);
    const expected = structuredClone(payload);
    const data = expected.data || expected;
    data.first_mes = data.first_mes.replace(edit.before, edit.after);
    assert.deepEqual(JSON.parse(fs.readFileSync(s.output)), expected);
  }
});

test('stale hashes, unsafe paths, ambiguous/overlapping edits and existing outputs fail closed', t => {
  const s = setup(t);
  const plans = [
    { ...s.plan([edit]), sourceSha256: '0'.repeat(64) },
    s.plan([{ ...edit, path: ['extensions', 'regex_scripts', 0, 'replaceString'] }]),
    s.plan([{ ...edit, path: ['__proto__', 'polluted'] }]),
    s.plan([{ ...edit, path: ['name'] }]),
    s.plan([{ ...edit, path: ['description'] }]),
    s.plan([{ ...edit, before: 'not present' }]),
    s.plan([edit, edit]),
    s.plan([{ ...edit, after: '' }]),
    s.plan([{ ...edit, arbitrary: true }])
  ];
  for (const plan of plans) {
    assert.throws(() => editProse(s.input, plan, s.output));
    assert.equal(fs.existsSync(s.output), false);
  }
  assert.throws(() => editProse(s.input, s.plan([edit]), s.input));
  fs.writeFileSync(s.output, 'keep');
  assert.throws(() => editProse(s.input, s.plan([edit]), s.output));
  assert.equal(fs.readFileSync(s.output, 'utf8'), 'keep');
  assert.deepEqual(fs.readFileSync(s.input), s.bytes);
  const duplicate = setup(t, { first_mes: '雨落下来。雨落下来。' });
  assert.throws(() => editProse(duplicate.input, duplicate.plan([edit]), duplicate.output), /exactly once/);
});

test('code bodies, template macros and introduced markup cannot be edited as prose', t => {
  for (const text of ['<script>雨落下来。</script>', '<style>雨落下来。</style>',
    '```js\n雨落下来。\n```', '`雨落下来。`', '{{雨落下来。}}', '<% 雨落下来。 %>',
    '<span title="雨落下来。">text</span>']) {
    const s = setup(t, { first_mes: text });
    assert.throws(() => editProse(s.input, s.plan([edit]), s.output), /recognizable code/);
    assert.equal(fs.existsSync(s.output), false);
  }
  const s = setup(t);
  for (const after of ['{{user}}', '<script>alert(1)</script>', '_.set("x",1)', '[nora_mvu/1]']) {
    assert.throws(() => editProse(s.input, s.plan([{ ...edit, after }]), s.output), /recognizable code/);
  }
});

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
function payloads(buffer) {
  return extractChunks(buffer).map(decodeCardTextChunk).filter(x => x && ['chara', 'ccv3'].includes(x.keyword))
    .map(x => [x.keyword, JSON.parse(decodeCardPayload(x.value))]);
}

test('PNG edits both metadata variants while preserving their independent data and cover', t => {
  const v2 = raw();
  const v3 = { ...raw(), spec: 'chara_card_v3', spec_version: '3.0', v3_only: { opaque: 'keep' } };
  const original = Buffer.concat([writePngCardData(png, v2, v3), Buffer.from('trailing')]);
  const s = setup(t, original, '.png');
  const result = editProse(s.input, s.plan([edit]), s.output);
  assert.deepEqual(result.payloads, ['chara', 'ccv3']);
  const actual = fs.readFileSync(s.output);
  for (const [keyword, value] of payloads(actual)) {
    const expected = structuredClone(keyword === 'ccv3' ? v3 : v2);
    expected.data.first_mes = expected.data.first_mes.replace(edit.before, edit.after);
    assert.deepEqual(value, expected);
  }
  const nonCard = bytes => extractChunks(bytes).filter(c => !['chara', 'ccv3'].includes(decodeCardTextChunk(c)?.keyword));
  assert.deepEqual(nonCard(actual), nonCard(original));
  assert.equal(actual.subarray(-8).toString(), 'trailing');
  assert.deepEqual(fs.readFileSync(s.input), original);
});

test('conflicting and duplicate PNG payloads reject the entire edit', t => {
  const different = raw(); different.data.first_mes = '不同的开场';
  const s = setup(t, writePngCardData(png, raw(), different), '.png');
  assert.throws(() => editProse(s.input, s.plan([edit]), s.output), /exactly once/);
  assert.equal(fs.existsSync(s.output), false);
  const chunks = extractChunks(writePngCardData(png, raw()));
  chunks.splice(-1, 0, chunks.find(c => decodeCardTextChunk(c)?.keyword === 'chara'));
  const duplicate = setup(t, encodeChunks(chunks), '.png');
  assert.throws(() => editProse(duplicate.input, duplicate.plan([edit]), duplicate.output), /Duplicate/);
  assert.equal(fs.existsSync(duplicate.output), false);
});

test('CLI inspects source hash, previews without writes and exports a candidate', t => {
  const s = setup(t);
  const cli = path.resolve(__dirname, '../scripts/nora-cardforge.js');
  const run = args => spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8' });
  assert.equal(JSON.parse(run(['inspect', '--input', s.input]).stdout).source.sha256, sha(s.bytes));
  const planPath = path.join(s.dir, 'prose.json');
  fs.writeFileSync(planPath, JSON.stringify(s.plan([edit])));
  const args = ['prose-edit', '--input', s.input, '--edits', planPath, '--output', s.output];
  assert.equal(JSON.parse(run([...args, '--dry-run']).stdout).stage, 'preview');
  assert.equal(fs.existsSync(s.output), false);
  const result = run(args);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).stage, 'prose-candidate');
  assert.equal(run(args).status, 2);
});
