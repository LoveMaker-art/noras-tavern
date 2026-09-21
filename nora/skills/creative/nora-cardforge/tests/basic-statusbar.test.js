const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { createBasicStatusbar } = require('../src/statusbar/basic-template');
const { initProject, buildProject } = require('../src/project/project-engine');
const { prepareImport } = require('../src/install/prepare-import');

const field = (name, type, value, rest = {}) => ({ group: '玩家', field: name, type, default: value,
  description: '仅按本轮明确事件更新。', ...rest });
const spec = { format: 'nora-mvu-fields/v1', variables: [
  field('姓名', 'string', '完整的测试姓名'),
  field('能量', 'number', 80, { min: 0, max: 100 }),
  field('持有通行证', 'boolean', false),
  field('背包', 'array', [{ 名称: '地图', 数量: 1 }], { items: { type: 'object', properties: {
    名称: { type: 'string' }, 数量: { type: 'number', min: 1, integer: true },
  } } }),
  field('档案', 'record', {}, { values: { type: 'string' } }),
  { ...field('阶段', 'enum', '陌生', { enumValues: ['陌生', '熟悉'] }), group: '关系' },
  { ...field('地点.名称', 'string', '车站'), group: '世界' },
] };
const cli = path.resolve(__dirname, '../scripts/nora-cardforge.js');
function temporary(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cardforge-basic-statusbar-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}
function run(...args) {
  return spawnSync(process.execPath, [cli, 'statusbar-template', ...args], { encoding: 'utf8' });
}

test('basic template uses declared paths without copying initial values, instructions or scripts', () => {
  const before = JSON.stringify(spec);
  const { html, paths, report } = createBasicStatusbar(spec, { title: '旅行 <状态> & "清单"' });
  assert.equal(JSON.stringify(spec), before);
  assert.equal(report.passed, true);
  assert.equal(report.verification.runtime, 'not-verified');
  assert.equal(report.verification.scriptSyntax.checked, 0);
  assert.deepEqual(paths, spec.variables.map(v => [v.group, ...v.field.split('.')]));
  assert.deepEqual(report.stats.usedPaths, paths);
  assert.match(html, /旅行 &lt;状态&gt; &amp; &quot;清单&quot;/);
  assert.doesNotMatch(html, /<script|完整的测试姓名|仅按本轮明确事件更新/);
  assert.equal((html.match(/尚未初始化/g) || []).length, spec.variables.length);
  assert.throws(() => createBasicStatusbar({ variables: [] }), /format/);
  assert.throws(() => createBasicStatusbar(spec, { title: '' }), /title/);
});

test('template CLI creates one new source file, preserves inputs and refuses overwrites', t => {
  const root = temporary(t), vars = path.join(root, 'mvu.json'), output = path.join(root, 'statusbar.html');
  fs.writeFileSync(vars, JSON.stringify(spec));
  const source = fs.readFileSync(vars);
  const created = run('--vars', vars, '--output', output, '--title', '旅行状态');
  assert.equal(created.status, 0, created.stderr);
  const report = JSON.parse(created.stdout), html = fs.readFileSync(output);
  assert.equal(report.fieldCount, 7);
  assert.equal(report.sha256, crypto.createHash('sha256').update(html).digest('hex'));
  assert.deepEqual(fs.readFileSync(vars), source);
  const again = run('--vars', vars, '--output', output);
  assert.notEqual(again.status, 0);
  assert.deepEqual(fs.readFileSync(output), html);
  assert.notEqual(run('--vars', vars, '--output', vars).status, 0);
  assert.deepEqual(fs.readFileSync(vars), source);
  assert.notEqual(run('--vars', vars, '--output', path.join(root, 'unused.html'), '--force').status, 0);
  assert.equal(fs.existsSync(path.join(root, 'unused.html')), false);
  fs.writeFileSync(vars, JSON.stringify({ ...spec, variables: [{ ...spec.variables[0], field: 'unknown..path' }] }));
  assert.notEqual(run('--vars', vars, '--output', path.join(root, 'invalid.html')).status, 0);
  assert.equal(fs.existsSync(path.join(root, 'invalid.html')), false);
});

function buildFixture(t) {
  const root = temporary(t), project = path.join(root, 'project');
  initProject(project, { name: '车站旅行', slug: 'station' });
  fs.writeFileSync(path.join(project, 'card.md'), '---\nname: 车站旅行\n---\n## First Message\n雨停了，车站门口的路牌指向两条不同的道路，你准备去哪里？');
  fs.writeFileSync(path.join(project, 'features/mvu.json'), JSON.stringify(spec));
  const generated = createBasicStatusbar(spec);
  fs.writeFileSync(path.join(project, 'features/statusbar.html'), generated.html);
  const built = buildProject(project);
  const artifact = path.join(project, built.manifest.artifacts.v2Json);
  const card = JSON.parse(fs.readFileSync(artifact));
  const markup = card.data.extensions.regex_scripts.find(s => s.scriptName === '状态栏美化').replaceString;
  const scripts = [...markup.matchAll(/<script type="module">([\s\S]*?)<\/script>/g)];
  assert.equal(scripts.length, 1, 'reuse the single compiler-owned reader');
  assert.ok(markup.includes(generated.html), 'exercise the exact template shipped in the card');
  return { root, project, artifact, card, paths: generated.paths, code: scripts[0][1] };
}

async function harness(fixture, nora) {
  const events = new Map();
  let ready, snapshot;
  const nodes = fixture.paths.map(parts => ({ getAttribute: () => JSON.stringify(parts), textContent: '尚未初始化' }));
  const Mvu = { events: { VARIABLE_INITIALIZED: 'initialized', ...(nora ? { TRANSACTION_COMMITTED: 'committed' } : {}) },
    getMvuData: options => {
      assert.deepEqual(options, { type: 'message', message_id: 17 });
      return { stat_data: snapshot };
    } };
  // Execute only the compiler-owned reader generated above, with fake host/DOM.
  // No browser, imported card scripts, provider requests or persistence are used.
  new Function('Mvu', 'tavern_events', 'getCurrentMessageId', 'waitGlobalInitialized', 'eventOn', 'document', '$', 'errorCatched', fixture.code)(
    Mvu, { CHARACTER_MESSAGE_RENDERED: 'rendered' }, () => 17, async () => {},
    (name, fn) => events.set(name, fn), { querySelectorAll: () => nodes }, fn => { ready = fn(); }, fn => fn,
  );
  await ready;
  return { nodes, events, set: data => { snapshot = data; }, text: () => nodes.map(node => node.textContent) };
}

for (const nora of [true, false]) test(`built basic template renders complete committed values (${nora ? 'Nora' : 'upstream events'})`, async t => {
  const fixture = buildFixture(t), runtime = await harness(fixture, nora);
  assert.deepEqual(runtime.text(), Array(7).fill('尚未初始化'));
  const initial = structuredClone(fixture.card.data.extensions.cfMvuFieldContract.initial);
  runtime.set(initial);
  runtime.events.get('initialized')();
  assert.deepEqual(runtime.text(), ['完整的测试姓名', '80', 'false', '[{"名称":"地图","数量":1}]', '{}', '陌生', '车站']);
  const updated = { 玩家: { 姓名: '<b>完整名字</b>\n第二行', 能量: 0, 持有通行证: true, 背包: [], 档案: { guide: '已认识的向导' } }, 关系: { 阶段: '熟悉' }, 世界: { 地点: { 名称: '' } } };
  runtime.set(updated);
  assert.equal(runtime.text()[1], '80', 'do not change display before the host completion event');
  if (nora) runtime.events.get('committed')();
  else {
    runtime.events.get('rendered')(18);
    assert.equal(runtime.text()[1], '80', 'ignore another message');
    runtime.events.get('rendered')(17);
  }
  assert.deepEqual(runtime.text(), ['<b>完整名字</b>\n第二行', '0', 'true', '[]', '{"guide":"已认识的向导"}', '熟悉', '']);
  runtime.set({});
  runtime.events.get('initialized')();
  assert.deepEqual(runtime.text(), Array(7).fill('尚未初始化'), 'do not substitute initial defaults for missing live state');
  const uploads = path.join(fixture.root, 'uploads'); fs.mkdirSync(uploads);
  const prepared = prepareImport(fixture.project, { uploadRoot: uploads, idempotencyKey: `basic-template:${nora}` });
  assert.deepEqual(fs.readFileSync(prepared.stagedPath), fs.readFileSync(fixture.artifact));
  assert.equal(prepared.runtimeVerified, false);
});
