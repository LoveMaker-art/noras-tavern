import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
    buildStoryProfileCard,
    loadStoryProfileReflectionContext,
} from '../src/nora-story-profile.js';
import { createStoryStatistics } from '../src/nora-story-statistics.js';
import {
    buildCuratorReviewLink,
    storyProfileHref,
} from '../../../native-extensions/nora-ui/story-profile-controller.js';

const testsRoot = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.resolve(testsRoot, '../../..');
const projectRoot = path.resolve(appRoot, '..');
const storyProfileRuntimeRoot = path.join(appRoot, 'story_profile_runtime');
const storyProfileCoreRoot = path.join(storyProfileRuntimeRoot, 'core');
const panelSource = fs.readFileSync(path.join(appRoot, 'native-extensions/nora-ui/panel-controller.js'), 'utf8');
const endpointSource = fs.readFileSync(path.join(appRoot, 'engine/sillytavern/src/endpoints/nora-story-profile.js'), 'utf8');
const noraUiSource = fs.readFileSync(path.join(appRoot, 'native-extensions/nora-ui/index.js'), 'utf8');
const profileMemorySource = fs.readFileSync(path.join(projectRoot, 'ops/scripts/profile_memory.py'), 'utf8');

test('archive metrics are derived from Nora worlds and chats using the original rules', () => {
    const value = buildStoryProfileCard({
        now: () => new Date('2026-08-28T00:00:00Z'),
        identity: { persona_name: '若棠' },
        profile: {
            revision: 4,
            preferences: [{ text: '喜欢慢热推进', status: 'confirmed' }],
            recent_timeline: [{ date: '2026-08-27', reason: '复盘「雾都」', change: '喜欢慢热推进' }],
            stats: { event_count: 1 },
        },
        eras: [],
        worlds: [
            { world_id: 'mist', name: '雾都', created_at: '2026-08-18T00:00:00Z', runtime_card: { binding: { avatar: 'mist.png' } } },
            { world_id: 'lake', name: '湖畔', created_at: '2026-08-26T00:00:00Z', runtime_card: { binding: { avatar: 'lake.png' } } },
        ],
        chatsByWorld: {
            mist: [
                { name: '侦探', is_user: false, mes: '开场白' },
                { name: '我', is_user: true, mes: '继续' },
                { name: '侦探', is_user: false, mes: '生成回复一' },
            ],
            lake: [
                { name: '旅人', is_user: false, mes: '另一段开场' },
                { name: '我', is_user: true, mes: '靠近一些' },
                { name: '旅人', is_user: false, mes: '生成回复二' },
            ],
        },
        characters: [
            { avatar: 'mist.png', name: '侦探', tags: ['悬疑', ', , , ', ''] },
            { avatar: 'lake.png', name: '旅人', tags: ['治愈', '   '] },
        ],
    });
    assert.deepEqual(value.career, { debut_days: 10, productions: 2, turns: 2, words: 10, roles: 2 });
    assert.equal(value.intimacy.score, 10);
    assert.equal(value.intimacy.level, '初见');
    assert.deepEqual(value.knows, ['喜欢慢热推进']);
    assert.deepEqual(value.timeline.map(item => item.change), ['喜欢慢热推进']);
    assert.deepEqual(value.specialties, ['悬疑', '治愈']);
});

test('curator review preserves the original Hermes handoff instead of a local edit form', () => {
    const href = buildCuratorReviewLink({
        agentUserId: 'usr_example',
        worldName: '雾都',
    });
    const url = new URL(href);
    assert.equal(url.protocol, 'clawchat:');
    assert.equal(url.host, 'u');
    assert.equal(url.pathname, '/usr_example');
    assert.equal(url.searchParams.get('chat'), '1');
    assert.equal(url.searchParams.get('draft'), '整理「雾都」这场故事');
    assert.doesNotMatch(panelSource, /nora-reflection-form|name="preferences"|name="change"/);
});

test('archive projection does not resurrect legacy World identity or avatar fields', () => {
    const card = buildStoryProfileCard({
        worlds: [{ id: 'retired', runtime: { character_avatar: 'retired.png' } }],
        chatsByWorld: { retired: [{ is_user: true, mes: 'legacy data must not be selected' }] },
    });
    assert.equal(card.career.turns, 0);
    assert.equal(card.career.roles, 0);
});

test('archive chat reads only the World v2 default Session binding', async (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nora-profile-session-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const directories = { root, chats: root };
    fs.mkdirSync(path.join(root, 'card'));
    for (const name of ['default', 'other', 'legacy']) {
        fs.writeFileSync(path.join(root, 'card', `${name}.jsonl`), JSON.stringify({ is_user: true, mes: name }));
    }
    const world = {
        world_id: 'world', runtime_card: { binding: { avatar: 'card.png' } },
        runtime: { character_avatar: 'card.png', chat_id: 'legacy' },
        sessions: { default_session_id: 'session:default', items: [
            { session_id: 'session:other', binding: { chat_id: 'other' } },
            { session_id: 'session:default', binding: { chat_id: 'default' } },
        ] },
    };
    const reader = createStoryStatistics(directories);
    assert.equal((await reader.read(world, { includeMessages: true })).messages[0].mes, 'default');
    assert.deepEqual((await reader.read({ ...world, sessions: undefined }, { includeMessages: true })).messages, []);
    assert.deepEqual((await reader.read({ ...world, runtime_card: undefined }, { includeMessages: true })).messages, []);
});

test('story profile restores the original actor surface through Nora adapters', () => {
    assert.equal(storyProfileHref('https://example.test/'), '/actor?from=console&return=https%3A%2F%2Fexample.test%2F');
    const upstreamFiles = {
        // Approved branding-only change: title, metadata and icon dimensions use Story Profile assets.
        'actor.html': '98216e81b8e289e1cadb8aaffd7fb2438c5f60a745f0af4c4a9f7e33136ea36f',
        'actor.js': '6cdf3ab69ea04e300d8029c8cd8c03ee83c1d5b953bac20a11d86073149ef359',
        'security.js': '90f0cc4dc6e2b94b6f70a53e1f8e7704999c885bd9a88577e5aa587148a47965',
    };
    for (const [file, digest] of Object.entries(upstreamFiles)) {
        assert.equal(fs.existsSync(path.join(appRoot, 'engine/sillytavern/public', file)), true, `${file} must exist`);
        let content = fs.readFileSync(path.join(appRoot, 'engine/sillytavern/public', file), 'utf8');
        // Markup and handlers remain byte-identical to the pre-cleanup UI;
        // resource pruning has its own selector and translation parity tests.
        if (file === 'actor.js') content = content.replaceAll('await globalThis.noraProfileRequest(', 'await fetch(');
        if (file === 'actor.html') content = content.replace('<script src="nora-profile-request.js"></script>\n  ', '')
            .replace(/(console\.css|i18n\.js)\?v=[a-f0-9]{16}/g, '$1');
        assert.equal(crypto.createHash('sha256').update(content).digest('hex'), digest, `${file} must preserve the pre-cleanup UI`);
    }
    const html = fs.readFileSync(path.join(appRoot, 'engine/sillytavern/public/actor.html'), 'utf8');
    const script = fs.readFileSync(path.join(appRoot, 'engine/sillytavern/public/actor.js'), 'utf8');
    assert.match(html, /id="acRoot" class="acCard"/);
    assert.match(html, /id="personalityEditor"/);
    assert.match(script, /\/api\/actor_card/);
    assert.match(script, /\/api\/identity/);
    assert.match(script, /\/api\/personality/);
    assert.match(script, /debut_days/);
    assert.match(script, /productions/);
    assert.match(script, /turns/);
    assert.match(script, /words/);
    assert.match(script, /roles/);
    assert.match(script, /timeline/);
    assert.match(script, /intimacy/);
    assert.match(script, /knows/);
    assert.doesNotMatch(html + script, /ON STAGE|roles-section|specialties-list|retry-button/);
});

test('the in-repository Story Profile source produces a validated built-in Nora snapshot', () => {
    const result = spawnSync('node', [
        path.join(appRoot, 'engine/sillytavern/build/sync-story-profile-runtime.mjs'),
        '--check',
    ], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /story-profile-runtime=PASS files=13/);
    assert.equal(fs.existsSync(path.join(storyProfileRuntimeRoot, 'manifest.json')), true);
    assert.equal(fs.existsSync(path.join(storyProfileRuntimeRoot, 'core/story_profile.py')), true);
    const manifest = JSON.parse(fs.readFileSync(path.join(storyProfileRuntimeRoot, 'manifest.json'), 'utf8'));
    assert.equal(manifest.source, 'repository-project');
    assert.match(manifest.sourceRevision, /^sha256:[a-f0-9]{64}$/);
    assert.equal(manifest.files['story_profile_runtime/core/story_profile.py'].source, 'story-profile/core/story_profile.py');
    assert.match(endpointSource, /story_profile_runtime\/adapters\/nora\/preference-checkpoint\.js/);
    assert.doesNotMatch(endpointSource, /\.\.\/story-profile/);
});

test('personality adapter delegates to the original Python backend', () => {
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'nora-story-personality-'));
    const soul = path.join(temporary, 'SOUL.md');
    fs.writeFileSync(soul, '原人格\n', 'utf8');
    const adapter = path.join(storyProfileRuntimeRoot, 'adapters/nora/cli.py');
    const environment = { ...process.env, TAVERN_PERSONALITY_FILE: soul };
    const read = spawnSync('python3', [adapter, 'personality-read'], { encoding: 'utf8', env: environment });
    assert.equal(read.status, 0, read.stderr);
    const current = JSON.parse(read.stdout);
    assert.equal(current.supported, true);
    assert.equal(current.content, '原人格\n');
    const write = spawnSync('python3', [adapter, 'personality-write'], {
        encoding: 'utf8',
        env: environment,
        input: JSON.stringify({ content: '新人格', revision: current.revision }),
    });
    assert.equal(write.status, 0, write.stderr);
    assert.equal(JSON.parse(write.stdout).content, '新人格\n');
    assert.equal(fs.readFileSync(soul, 'utf8'), '新人格\n');
});

test('canonical Python profile keeps durable preferences, timeline, and Hermes projections', () => {
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'nora-story-profile-'));
    const seedPath = path.join(appRoot, 'actor_self.md');
    const code = `
import json, pathlib, sys
sys.path.insert(0, ${JSON.stringify(storyProfileCoreRoot)})
import story_profile
root = pathlib.Path(${JSON.stringify(temporary)})
seed = pathlib.Path(${JSON.stringify(seedPath)})
profile = story_profile.ensure_profile(root, seed)
story_profile.record_learning(root, seed, "- 喜欢慢热的关系推进\\n- 喜欢慢热的关系推进", "复盘「雾都」", ts=1700000000)
profile = story_profile.load_profile(root, seed)
preview = story_profile.memory_preview(profile)
print(json.dumps({
  "preferences": story_profile.preference_texts(profile),
  "timeline": story_profile.timeline(profile),
  "preview": preview,
  "audit": story_profile.audit(root, seed),
}, ensure_ascii=False))
`;
    const result = spawnSync('python3', ['-c', code], {
        encoding: 'utf8',
        env: {
            ...process.env,
            TAVERN_HERMES_MEMORIES_DIR: path.join(temporary, 'memories'),
            TAVERN_HERMES_STATE_DB: path.join(temporary, 'missing-state.db'),
        },
    });
    assert.equal(result.status, 0, result.stderr);
    const value = JSON.parse(result.stdout);
    assert.deepEqual(value.preferences, ['喜欢慢热的关系推进']);
    assert.equal(value.timeline.length, 1);
    assert.match(value.preview.user, /用户的故事口味/);
    assert.match(value.preview.memory, /与用户共同记得的故事/);
    assert.equal(value.audit.active_preferences, 1);
});

test('reflection preview is read-only and reflection writes through the canonical profile module', () => {
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'nora-story-reflect-'));
    const code = `
import json, pathlib, sys
sys.path.insert(0, ${JSON.stringify(storyProfileCoreRoot)})
import story_profile, reflection
state = pathlib.Path(${JSON.stringify(temporary)})
seed = pathlib.Path(${JSON.stringify(path.join(appRoot, 'actor_self.md'))})
context = {
    "world_id": "mist", "world_name": "雾都", "card": {"name": "侦探"},
    "story": [
        {"role": "assistant", "text": "开场"},
        {"role": "user", "text": "我想慢一点了解他"},
        {"role": "assistant", "text": "好的"},
        {"role": "user", "text": "继续这种克制的推进"},
    ],
}
class Model:
    def __init__(self):
        self.calls = 0
    def complete(self, messages):
        self.calls += 1
        if self.calls == 1:
            return "- 喜欢慢热且克制的关系推进"
        return json.dumps({
            "character_styles": [],
            "relationship_dynamics": ["慢热且克制的关系推进"],
            "story_themes": [],
            "pacing": ["慢节奏推进"],
            "narrative_style": [],
            "interaction_preferences": [],
            "response_adaptations": ["讨论关系推进时先保留克制与留白"],
            "boundaries": [],
        }, ensure_ascii=False)
preview_model = Model()
preview = reflection.reflect_context(story_profile, preview_model, state, seed, context, write=False)
preview_files = sorted(path.name for path in pathlib.Path(${JSON.stringify(temporary)}).glob("*"))
write_model = Model()
written = reflection.reflect_context(story_profile, write_model, state, seed, context, write=True)
profile = story_profile.load_profile(state, seed)
print(json.dumps({
    "preview":preview,
    "preview_files":preview_files,
    "preview_model_calls":preview_model.calls,
    "written":written,
    "write_model_calls":write_model.calls,
    "taste_profile":profile.get("taste_profile"),
    "taste_profile_stale":profile.get("taste_profile_stale"),
}, ensure_ascii=False))
`;
    const result = spawnSync('python3', ['-c', code], {
        encoding: 'utf8',
        env: {
            ...process.env,
            TAVERN_HERMES_MEMORIES_DIR: path.join(temporary, 'memories'),
            TAVERN_HERMES_STATE_DB: path.join(temporary, 'missing-state.db'),
        },
    });
    assert.equal(result.status, 0, result.stderr);
    const value = JSON.parse(result.stdout);
    assert.deepEqual(value.preview_files, []);
    assert.equal(value.preview.written, false);
    assert.equal(value.preview_model_calls, 1);
    assert.equal(value.written.written, true);
    assert.equal(value.write_model_calls, 2);
    assert.deepEqual(value.taste_profile.pacing, ['慢节奏推进']);
    assert.equal(value.taste_profile_stale, false);
    assert.equal(fs.existsSync(path.join(temporary, 'story_profile.json')), true);
});

test('reflection context is loaded from the canonical Nora World and native chat binding', async () => {
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'nora-story-context-'));
    const directories = {
        root: temporary,
        chats: path.join(temporary, 'chats'),
    };
    const world = {
        world_id: 'mist',
        name: '雾都',
        runtime_card: { binding: { avatar: 'mist.png' } },
        sessions: {
            default_session_id: 'session:mist',
            items: [{ session_id: 'session:mist', binding: { avatar: 'mist.png', chat_id: 'main' } }],
        },
    };
    const chatDirectory = path.join(directories.chats, 'mist');
    fs.mkdirSync(chatDirectory, { recursive: true });
    fs.writeFileSync(path.join(chatDirectory, 'main.jsonl'), [
        { is_user: false, mes: '开场', name: '侦探' },
        { is_user: true, mes: '慢一点', name: '我' },
        { is_user: false, mes: '好的', name: '侦探' },
    ].map(item => JSON.stringify(item)).join('\n'), 'utf8');

    const context = await loadStoryProfileReflectionContext({
        directories,
        worldId: 'mist',
        getCharacterFn: async () => ({ name: '侦探' }),
        getWorldFn: async () => world,
    });

    assert.equal(context.world_id, 'mist');
    assert.equal(context.world_name, '雾都');
    assert.deepEqual(context.card, { name: '侦探' });
    assert.deepEqual(context.story.map(item => item.role), ['char', 'user', 'char']);
    assert.equal(context.story[1].text, '慢一点');
});

test('a failed taste aggregation is repaired even when the retry finds no new preference', () => {
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'nora-story-taste-retry-'));
    const code = `
import json, pathlib, sys
sys.path.insert(0, ${JSON.stringify(storyProfileCoreRoot)})
import story_profile, reflection as story_profile_reflection
root = pathlib.Path(${JSON.stringify(temporary)})
seed = pathlib.Path(${JSON.stringify(path.join(appRoot, 'actor_self.md'))})
context = {
    "world_id":"mist", "world_name":"雾都", "card":{"name":"侦探"},
    "story":[
        {"role":"user","text":"慢一点"}, {"role":"char","text":"好"},
        {"role":"user","text":"保持克制"}, {"role":"char","text":"好"},
    ],
}
class FirstModel:
    def __init__(self): self.calls = 0
    def complete(self, messages):
        self.calls += 1
        return "- 喜欢慢热且克制的推进" if self.calls == 1 else "not json"
class RetryModel:
    def __init__(self): self.calls = 0
    def complete(self, messages):
        self.calls += 1
        if self.calls == 1: return "NONE"
        return json.dumps({key: (["慢节奏"] if key == "pacing" else []) for key in story_profile.TASTE_PROFILE_FIELDS}, ensure_ascii=False)
try:
    story_profile_reflection.reflect_context(story_profile, FirstModel(), root, seed, context, write=True)
except story_profile_reflection.StoryProfileReflectionError:
    pass
before = story_profile.load_profile(root, seed)
retry = RetryModel()
story_profile_reflection.reflect_context(story_profile, retry, root, seed, context, write=True)
after = story_profile.load_profile(root, seed)
print(json.dumps({
    "before_stale":before.get("taste_profile_stale"),
    "retry_calls":retry.calls,
    "after_stale":after.get("taste_profile_stale"),
    "pacing":after.get("taste_profile", {}).get("pacing"),
}, ensure_ascii=False))
`;
    const result = spawnSync('python3', ['-c', code], {
        encoding: 'utf8',
        env: {
            ...process.env,
            TAVERN_HERMES_MEMORIES_DIR: path.join(temporary, 'memories'),
            TAVERN_HERMES_STATE_DB: path.join(temporary, 'missing-state.db'),
        },
    });
    assert.equal(result.status, 0, result.stderr);
    const value = JSON.parse(result.stdout);
    assert.equal(value.before_stale, true);
    assert.equal(value.retry_calls, 2);
    assert.equal(value.after_stale, false);
    assert.deepEqual(value.pacing, ['慢节奏']);
});

test('Nora send lifecycle and Story Profile maintenance use the new checkpoint surface', () => {
    assert.match(endpointSource, /router\.post\('\/checkpoint'/);
    assert.match(endpointSource, /runAdapter\('reflect'/);
    assert.match(endpointSource, /router\.post\('\/refresh'/);
    assert.match(noraUiSource, /onGenerationCompleted: notifyStoryProfileCheckpoint/);
    assert.match(noraUiSource, /\/api\/nora-story-profile\/checkpoint/);
    assert.doesNotMatch(profileMemorySource, /\/api\/event/);
    assert.doesNotMatch(profileMemorySource, /HermesModelClient|refresh_taste_profile/);
});
