const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { compileWorld } = require('../src/project/world-authoring');
const { normalizeCard } = require('../src/core/card-model');
const { initProject, buildProject } = require('../src/project/project-engine');
const { prepareImport, verifyImport } = require('../src/install/prepare-import');
const world = {
  persona: { name: '旅人', description: '受委托送信的成年旅人。' },
  characters: [
    { id: 'guide', name: '向导', description: '{{char}}负责指路。', personality: '沉着', activation: { mode: 'constant' } },
    { id: 'merchant', name: '商人', description: '出售地图。', activation: { mode: 'triggered', keys: ['商店'], secondaryKeys: ['地图'], selectiveLogic: 0, sticky: 2 } },
  ],
};
test('one definition emits World cast with reader summary and no duplicate lore biographies', () => {
  const input = normalizeCard({ name: '驿站', description: '用户可在这里了解旅行玩法。', character_book: { entries: [{ id: 8, comment: '地方', content: '驿站设定', keys: ['驿站'] }] } });
  const before = JSON.stringify(input);
  const card = compileWorld(input, world);
  assert.equal(JSON.stringify(input), before);
  assert.equal(compileWorld(input, undefined), input);
  const story = card.data.extensions.nora_world.story_context;
  assert.equal(card.data.extensions.nora_world.format, 'nora-world-card/2');
  assert.equal(story.card_format, 'nora-world-card/2');
  assert.equal(card.data.description, input.data.description);
  assert.equal(story.characters[0].profile.identity.description, '{{char}}负责指路。');
  assert.equal(story.characters[1].activation.mode, 'triggered');
  assert.deepEqual(story.player.profile.identity, world.persona);
  const entries = card.data.character_book.entries;
  assert.equal(entries[0].content, '驿站设定');
  assert.deepEqual(entries, input.data.character_book.entries);
  assert.deepEqual(story.characters[1].activation.keys, ['商店']);
  assert.deepEqual(story.characters[1].activation.secondaryKeys, ['地图']);
  assert.equal(story.characters[1].activation.sticky, 2);
  for (const field of ['personality', 'scenario']) {
    const invalid = structuredClone(input); invalid.data[field] = '必须有明确归属的设定';
    assert.throws(() => compileWorld(invalid, world), /New World cards do not author/);
    assert.equal(compileWorld(invalid, undefined), invalid, 'old cards are not rewritten or rejected');
  }
});
test('unknown author fields, duplicate IDs and empty triggered keys fail, instead of silently dropping content', () => {
  const card = normalizeCard({ name: '驿站' });
  for (const change of [
    w => { w.actors = []; }, w => { w.persona.bio = 'not supported'; },
    w => { w.characters[1].id = 'guide'; }, w => { w.characters[0].id = '__user__'; },
    w => { w.characters[1].activation.keys = []; }, w => { w.characters[1].activation.scanDepth = 1001; },
  ]) {
    const candidate = structuredClone(world); change(candidate);
    assert.throws(() => compileWorld(card, candidate));
  }
});
test('new project builds without fake legacy personality, stages persona and detects missing readback cast', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'world-authoring-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const project = path.join(root, 'project'), uploads = path.join(root, 'uploads');
  fs.mkdirSync(uploads);
  initProject(project, { name: '林间驿站', slug: 'forest' });
  assert.doesNotMatch(fs.readFileSync(path.join(project, 'card.md'), 'utf8'), /## Personality|## Scenario|^scenario:/m);
  const configPath = path.join(project, 'card.project.json');
  const config = JSON.parse(fs.readFileSync(configPath)); config.world = world;
  fs.writeFileSync(configPath, JSON.stringify(config));
  fs.writeFileSync(path.join(project, 'card.md'), '---\nname: 林间驿站\n---\n## First Message\n雨停了，向导站在驿站门口整理地图，抬头询问来客准备前往何处。\n');
  const built = buildProject(project);
  assert.equal(built.quality.passed, true);
  assert.equal(built.quality.writing, null); // Scoring is opt-in, not the next build task.
  const prepared = prepareImport(project, { uploadRoot: uploads, idempotencyKey: 'author-test' });
  assert.equal(prepared.mcpCall.arguments.personaName, world.persona.name);
  const exportedStory = JSON.parse(fs.readFileSync(prepared.stagedPath)).data.extensions.nora_world.story_context;
  const inspection = { world: { world_id: 'world:test', name: '林间驿站', lifecycle: { status: 'READY' },
    source: { sha256: prepared.artifactSha256, import_operation_id: prepared.recovery.operationId },
    persona: world.persona, story_context: exportedStory } };
  assert.equal(verifyImport(prepared, inspection).ok, true);
  const missingFormat = structuredClone(inspection); delete missingFormat.world.story_context.card_format;
  assert.deepEqual(verifyImport(prepared, missingFormat).mismatches, ['cardFormat']);
  const missing = structuredClone(inspection); missing.world.story_context.characters = [];
  assert.deepEqual(verifyImport(prepared, missing).mismatches, ['characters']);
  const emptyPersona = structuredClone(inspection); emptyPersona.world.persona = { name: '', description: '' };
  assert.equal(verifyImport(prepared, emptyPersona).ok, false);
  assert.equal(verifyImport(prepared, inspection).runtimeVerified, false);
});
