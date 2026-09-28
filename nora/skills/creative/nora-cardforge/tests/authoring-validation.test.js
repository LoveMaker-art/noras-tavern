const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { parseLorebook, serializeLorebook } = require('../src/card-md/card-md');
const { validateStatusbarHtml } = require('../src/statusbar/statusbar');
const { runWritingScore, runQualityGate } = require('../src/quality/quality-gate');
const { compileWorld } = require('../src/project/world-authoring');
const { normalizeCard } = require('../src/core/card-model');
const { initProject, buildProject } = require('../src/project/project-engine');
const { runDiagnostics } = require('../src/diagnostics/static-checks');

const python = process.env.NORA_PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
const scorer = path.resolve(__dirname, '../scripts/score_card.py');
function temporary(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cardforge-validation-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

test('lore typos and invalid values fail with the entry and directive, not silent activation changes', () => {
  for (const directive of ['key: 车站', 'keys:', 'secondary:', 'constant: false', 'regex: false',
    'role: typo', 'logic: typo', 'position: after_typo', 'recursion: typo', 'group:',
    'cooldown: -5', 'sticky: -1', 'depth: -1', 'weight: -1', 'prob: 101',
    'order: 3oops', 'order: 1.5', 'order: 9007199254740992']) {
    assert.throws(() => parseLorebook(`### 车站 | ${directive}\n车站已经关闭。`), error => {
      assert.match(error.message, /车站/);
      assert.ok(error.message.includes(directive));
      return true;
    }, directive);
  }
});

test('valid lore and default constant entries preserve round-trip behavior', () => {
  const text = '### 车站 | keys: 车站, 地图 | secondary: 下雨 | logic: and_all | role: assistant | position: after_char | order: -1 | depth: 0 | sticky: 0 | cooldown: 2 | weight: 0 | group: roads | prob: 100 | recursion: exclude | regex\n车站。\n### 天气\n雨天。';
  const entries = parseLorebook(text);
  assert.equal(entries[0].constant, false);
  assert.equal(entries[1].constant, true);
  assert.deepEqual(parseLorebook(serializeLorebook(entries)), entries);
});

test('diagnostics preserve valid lore choices without prescribing order 100 or disabled recursion', () => {
  const card = normalizeCard({ name: '雨港', description: '雨夜车站的旅行故事。'.repeat(10),
    personality: '谨慎而直率，尊重旅人的选择。', first_mes: '车站外的雨停了，向导递来一张沿途地图，等候旅人决定下一步。'.repeat(2),
    character_book: { entries: parseLorebook('### 规则 | constant | order: 110\n旅行需要地图。\n### 车站 | keys: 车站 | order: 250\n车站已关闭。') } });
  const before = JSON.stringify(card);
  const report = runDiagnostics(card);
  assert.equal(report.passed, true);
  assert.equal(report.summary.warnings, 0, JSON.stringify(report.issues));
  assert.equal(JSON.stringify(card), before, 'diagnostics do not rewrite activation choices');
  const recursion = report.checks.find(check => check.key === 'recursion_settings');
  assert.deepEqual(recursion.stats, { enabledEntries: 2, eligibleForRecursiveActivation: 1, mayTriggerOtherEntries: 2 });
  card.data.character_book.entries[1].keys = [];
  assert.equal(runDiagnostics(card).checks.find(check => check.key === 'worldbook_structure').passed, false);
  card.data.extensions.regex_scripts = [{ scriptName: 'broken', findRegex: '/(/', placement: [2] }];
  assert.equal(runDiagnostics(card).checks.find(check => check.key === 'regex_scripts').passed, false);
});

test('inline script and event-handler syntax is checked without execution', () => {
  for (const script of ['<script>function broken( {</script>', '<script type=module>export const = 1;</script>',
    '<script>return;</script>', '<script>await Promise.resolve();</script>',
    '<button onclick="if (">Go</button>', '<script>function broken( {']) {
    const report = validateStatusbarHtml({}, `<html><body>${script}</body></html>`);
    assert.equal(report.passed, false, script);
    assert.ok(report.issues.some(i => i.severity === 'error' && /脚本|script|syntax/i.test(i.title)));
  }
  const valid = `<html><body>
    <!-- <script>broken( {</script> -->
    <textarea><script>not JavaScript</script></textarea>
    <script type="application/json">{"notJS":true}</script>
    <script data-label=">">const 姓名 = '完整名字'; throw new Error('must not execute');</script>
    <script type=module>import { x } from 'not-installed'; await Promise.resolve(x);</script>
    <button onclick="return this.textContent &amp;&amp; event.type;">Go</button>
  </body></html>`;
  const report = validateStatusbarHtml({}, valid);
  assert.equal(report.passed, true, JSON.stringify(report));
  assert.equal(report.verification.scriptsExecuted, false);
  assert.equal(report.verification.runtime, 'not-verified');
  assert.equal(report.verification.scriptSyntax.checked, 3);
});

function worldCard() {
  return compileWorld(normalizeCard({ name: '车站', description: '探索铁路沿线的旅行故事。'.repeat(12),
    first_mes: '雨停了，车站的向导在门口等待。', character_book: { entries: [
      { id: 0, comment: '车站', content: '火车停运，旅客需要找到其他道路。', keys: ['车站'] },
    ] } }), { persona: { name: '', description: '' }, characters: [
    { id: 'guide', name: '向导', description: '车站工作人员，熟悉附近的小路。', personality: '谨慎直率。' },
  ] });
}

test('writing score consumes the compiled World cast, not forbidden whole-card fields', t => {
  const markdown = path.join(temporary(t), 'card.md');
  fs.writeFileSync(markdown, '---\nname: 车站\n---\n## Description\n旅行概要\n');
  const card = worldCard();
  const score = runWritingScore(markdown, card);
  assert.equal(score.available, true, JSON.stringify(score));
  assert.equal(score.detail.required['角色定义'], true);
  assert.equal(score.detail.required['世界设定'], true);
  assert.equal(Object.hasOwn(score.detail.required, 'personality>=100'), false);
  assert.equal(Object.hasOwn(score.detail.required, 'scenario>=60'), false);
  const changed = structuredClone(card);
  changed.data.personality = '旧字段'.repeat(100);
  changed.data.scenario = '旧字段'.repeat(100);
  assert.equal(runWritingScore(markdown, changed).available, false, 'forbidden fields must not earn points');
  const empty = structuredClone(card);
  empty.data.extensions.nora_world.story_context.characters = [];
  assert.equal(runWritingScore(markdown, empty).detail.required['角色定义'], null, 'cast-free worlds are valid');
});

test('scorer CLI accepts compiled JSON and does not silently score a World project as legacy Markdown', t => {
  const root = temporary(t), file = path.join(root, 'card.json');
  fs.writeFileSync(file, JSON.stringify(worldCard()));
  const result = spawnSync(python, [scorer, '--compiled-card', file, '--json'], { encoding: 'utf8' });
  assert.ok([0, 1].includes(result.status), result.stderr);
  assert.equal(JSON.parse(result.stdout)[0].detail.required['角色定义'], true);
  fs.writeFileSync(path.join(root, 'card.project.json'), JSON.stringify({ world: { characters: [] } }));
  fs.writeFileSync(path.join(root, 'card.md'), '## Description\n旅行故事');
  const wrong = spawnSync(python, [scorer, path.join(root, 'card.md'), '--json'], { encoding: 'utf8' });
  assert.equal(wrong.status, 2);
  assert.match(wrong.stderr, /build.*score-writing/);
});

test('legacy Markdown scoring remains available and unchanged through the build gate', t => {
  const markdown = path.join(temporary(t), 'card.md');
  fs.writeFileSync(markdown, '---\nname: 向导\n---\n## Personality\n' + '沉着谨慎。'.repeat(30) + '\n## Scenario\n' + '车站停运。'.repeat(20));
  const direct = runWritingScore(markdown);
  assert.equal(direct.available, true);
  assert.equal(direct.detail.required['personality>=100'], true);
  const quality = runQualityGate({ card: normalizeCard({ name: '向导' }), cardMdPath: markdown, scoreWriting: true });
  assert.deepEqual(quality.writing, direct);
});

test('script checker unavailability is a reported failure rather than a false pass', () => {
  const before = process.env.NORA_PYTHON;
  process.env.NORA_PYTHON = path.join(os.tmpdir(), 'missing-cardforge-python-executable');
  try {
    const report = validateStatusbarHtml({}, '<html><script>const x = 1;</script></html>');
    assert.equal(report.passed, false);
    assert.equal(report.verification.scriptSyntax.status, 'unavailable');
  } finally {
    if (before === undefined) delete process.env.NORA_PYTHON;
    else process.env.NORA_PYTHON = before;
  }
});

test('build scoring reads configured cast and failed authoring invalidates previous manifest', t => {
  const root = temporary(t), project = path.join(root, 'project');
  initProject(project, { name: '旅行世界', slug: 'journey' });
  const md = '---\nname: 旅行世界\n---\n## First Message\n雨停了，向导在门口等待，你准备前往何处？\n## Lorebook\n### 车站 | keys: 车站\n停运的车站。\n';
  fs.writeFileSync(path.join(project, 'card.md'), md);
  const configPath = path.join(project, 'card.project.json');
  const config = JSON.parse(fs.readFileSync(configPath));
  config.world.characters = [{ id: 'guide', name: '向导', description: '熟悉路线。' }];
  fs.writeFileSync(configPath, JSON.stringify(config));
  const built = buildProject(project, { scoreWriting: true });
  assert.equal(built.quality.writing.detail.required['角色定义'], true);
  fs.writeFileSync(path.join(project, 'card.md'), md.replace('keys:', 'key:'));
  assert.throws(() => buildProject(project), /key:/);
  const manifest = JSON.parse(fs.readFileSync(path.join(project, 'reports/build-manifest.json')));
  assert.equal(manifest.quality.passed, false);
  fs.writeFileSync(path.join(project, 'card.md'), md);
  fs.writeFileSync(path.join(project, 'features/statusbar.html'), '<html><body><script>function broken( {</script></body></html>');
  assert.throws(() => buildProject(project), error => {
    assert.equal(error.code, 'QUALITY_GATE_FAILED');
    assert.ok(error.report.hardFailures.includes('statusbar'));
    return true;
  });
  assert.equal(JSON.parse(fs.readFileSync(path.join(project, 'reports/build-manifest.json'))).quality.passed, false);
});
