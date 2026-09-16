const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const { spawnSync } = require('child_process');

const root = path.resolve(__dirname, '..');
const cli = path.join(root, 'scripts/nora-cardforge.js');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nora-cardforge-smoke-'));
process.on('exit', () => fs.rmSync(tmp, { recursive: true, force: true }));

function run(args) {
  const result = spawnSync(process.execPath, [cli, ...args], {
    cwd: root,
    encoding: 'utf8'
  });
  if (result.status !== 0) {
    throw new Error(`Command failed: ${args.join(' ')}\nstdout=${result.stdout}\nstderr=${result.stderr}`);
  }
  return result.stdout ? JSON.parse(result.stdout) : null;
}

const input = path.join(root, 'fixtures/empty-v2.json');
const vars = path.join(root, 'fixtures/mvu-vars.json');
const html = path.join(root, 'fixtures/statusbar.html');
const originalBytes = fs.readFileSync(input);

const inspected = run(['inspect', '--input', input]);
assert.equal(inspected.ok, true);
assert.equal(inspected.card.name, '测试角色');

const diagnosed = run(['diagnose', '--input', input]);
assert.equal(diagnosed.ok, true);
assert.equal(diagnosed.report.summary.errors, 0);

assert.deepEqual(fs.readFileSync(input), originalBytes);
// Removed commands must fail without creating an output or touching the input.
for (const command of ['apply', 'mvu-plan', 'statusbar-plan']) {
  const output = path.join(tmp, `${command}.json`);
  const rejected = spawnSync(process.execPath, [cli, command, '--input', input,
    '--vars', vars, '--html', html, '--patch', vars, '--output', output], { encoding: 'utf8' });
  assert.equal(rejected.status, 2);
  assert.equal(JSON.parse(rejected.stderr).error, `Unknown command: ${command}`);
  assert.equal(fs.existsSync(output), false);
  assert.deepEqual(fs.readFileSync(input), originalBytes);
}

const project = path.join(tmp, 'project');
run(['init', '--project', project, '--name', '诺拉测试', '--slug', 'nora-test']);
const cardMd = `---
name: "诺拉测试"
system_prompt: "始终以诺拉测试的身份回应；尊重{{user}}的行动权，不替{{user}}决定或行动。"
tags: ["女性向", "都市", "悬疑"]
creator: "Nora"
character_version: "1.0"
---
## Description
诺拉测试是旧书修复师，二十九岁，熟悉纸张、墨水和城市旧档案。她说话直接，观察细致，但不会把猜测伪装成事实。

## First Message
门铃在雨声里轻响了一下。诺拉从修复台后抬起头，把压在信纸上的玻璃镇纸挪到一旁。\n\n“先别告诉我是谁让你来的。”她看向你手里的信封，“让我看看纸和墨。它们通常比人诚实。”

## Alternate Greeting 1
午后的店里没有客人。诺拉把一只纸袋推到你面前：“你上次问的东西找到了，但答案可能不是你期待的。”

## Example Dialogue
<START>\n{{user}}: 你已经知道寄信人是谁了吗？\n{{char}}: “有一个猜测。”她没有立刻看你，“但证据还不够，我不会拿猜测吓你。”\n{{user}}: 那先告诉我你确认的部分。\n{{char}}: “纸是十年前停产的批次，墨水却很新。有人在故意制造时间错觉。”

## Lorebook
### 开局情境 | constant | order: 110
雨夜的旧书店里，{{user}}带着一封没有署名的信来找她。

### 旧书店 | keys: 旧书店, 修复台 | order: 120
城南旧书店兼做纸本文献修复，前店接待客人，后室保存委托档案。

### 叙事规则 | constant | order: 900 | recursion: exclude
线索必须来自已出现的物件、证词或可观察行为；角色可以推断错误，但应区分事实与猜测。

## Creator Notes
一张用于验证 Nora CardForge 制卡、世界书、备用开场和双格式导出的原创测试卡。
`;
fs.writeFileSync(path.join(project, 'card.md'), cardMd, 'utf8');
const worldConfigPath = path.join(project, 'card.project.json');
const worldConfig = JSON.parse(fs.readFileSync(worldConfigPath));
worldConfig.world.characters = [{ id: 'restorer', name: '诺拉测试', description: '二十九岁的旧书修复师，熟悉纸张和城市档案。', personality: '克制好奇；先确认事实，再表达判断。', activation: { mode: 'constant' } }];
fs.writeFileSync(worldConfigPath, JSON.stringify(worldConfig));
const onePixelPng = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
fs.writeFileSync(path.join(project, 'assets/cover.png'), onePixelPng);
fs.copyFileSync(vars, path.join(project, 'features/mvu.json'));
fs.copyFileSync(html, path.join(project, 'features/statusbar.html'));
const built = run(['build', '--project', project]);
assert.equal(built.ok, true);
assert.equal(built.manifest.quality.passed, true);
assert.ok(built.manifest.artifacts.v2Json);
assert.ok(built.manifest.artifacts.v3Png);
const authoredCard = JSON.parse(fs.readFileSync(path.join(project, built.manifest.artifacts.v2Json), 'utf8'));
assert.ok(authoredCard.data.character_book.entries.some(entry => entry.enabled && entry.comment.includes('[nora_mvu/1]')));
assert.ok(!authoredCard.data.character_book.entries.some(entry => entry.comment.includes('输出格式强调')));
const authoredPath = path.join(project, built.manifest.artifacts.v2Json);
assert.equal(run(['inspect', '--input', authoredPath]).card.mvu.hasVarGroups, true);
assert.equal(run(['inspect', '--input', authoredPath]).card.statusbar.present, true);
assert.equal(run(['statusbar-validate', '--input', authoredPath, '--html', html]).ok, true);

const builtPng = path.join(project, built.manifest.artifacts.v3Png);
const pngInspect = run(['inspect', '--input', builtPng]);
assert.equal(pngInspect.source.chunkKeyword, 'ccv3');
assert.deepEqual(pngInspect.source.availableKeywords.sort(), ['ccv3', 'chara']);
assert.equal(pngInspect.card.name, '诺拉测试');

const ingestedProject = path.join(tmp, 'ingested-project');
const ingested = run(['ingest', '--input', builtPng, '--project', ingestedProject, '--slug', 'roundtrip']);
assert.equal(ingested.ok, true);
const rebuilt = run(['build', '--project', ingestedProject]);
assert.equal(rebuilt.ok, true);
assert.equal(rebuilt.manifest.card.name, '诺拉测试');

const uploads = path.join(tmp, 'uploads');
fs.mkdirSync(uploads);
const prepareArgs = ['prepare-import', '--project', project, '--upload-root', uploads, '--idempotency-key', 'smoke:new-world'];
const preview = run([...prepareArgs, '--dry-run']);
assert.equal(preview.stage, 'preview');
assert.equal(preview.mcpCall.ready, false);
assert.deepEqual(fs.readdirSync(uploads), []);
const prepared = run(prepareArgs);
assert.equal(prepared.stage, 'prepared');
assert.equal(prepared.worldChanged, false);
assert.equal(prepared.mcpCall.tool, 'nora.world.import');
assert.equal(prepared.mcpCall.arguments.confirm, undefined);
assert.deepEqual(fs.readFileSync(prepared.stagedPath), fs.readFileSync(builtPng));
assert.equal(run(prepareArgs).reused, true);
const retired = spawnSync(process.execPath, [cli, 'install', '--project', project, '--confirm'], { encoding: 'utf8' });
assert.notEqual(retired.status, 0);
assert.equal(JSON.parse(retired.stderr).code, 'INSTALL_MOVED_TO_MCP');

const unknownSource = path.join(tmp, 'unknown-source.json');
const unknownRaw = JSON.parse(fs.readFileSync(input, 'utf8'));
unknownRaw.vendor_root = { preserved: true };
unknownRaw.data.extensions.vendor_extension = { nested: ['kept'] };
fs.writeFileSync(unknownSource, JSON.stringify(unknownRaw), 'utf8');
const unknownProject = path.join(tmp, 'unknown-project');
run(['ingest', '--input', unknownSource, '--project', unknownProject, '--slug', 'unknown-card']);
const unknownBuild = run(['build', '--project', unknownProject]);
const unknownOutput = JSON.parse(fs.readFileSync(path.join(unknownProject, unknownBuild.manifest.artifacts.v2Json), 'utf8'));
assert.deepEqual(unknownOutput.vendor_root, { preserved: true });
assert.deepEqual(unknownOutput.data.extensions.vendor_extension, { nested: ['kept'] });

const skill = fs.readFileSync(path.join(root, 'SKILL.md'), 'utf8');
assert.ok(skill.startsWith('---\n'));
const description = skill.match(/^description:\s*(.+)$/m)?.[1]?.replace(/^['"]|['"]$/g, '');
assert.ok(description);
assert.ok(description.length <= 60, `Hermes description is ${description.length} chars`);
assert.ok(description.endsWith('.'));
for (const heading of ['## When to Use', '## Prerequisites', '## How to Run', '## Quick Reference', '## Procedure', '## Pitfalls', '## Verification']) {
  assert.ok(skill.includes(heading), `Missing Hermes section: ${heading}`);
}
assert.ok(!skill.includes('/Users/'));
assert.ok(!skill.includes('/home/'));

console.log(JSON.stringify({ ok: true, temporaryArtifactsRemovedOnExit: true }, null, 2));
