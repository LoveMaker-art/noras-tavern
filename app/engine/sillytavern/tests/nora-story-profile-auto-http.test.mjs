import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import express from 'express';
import { createNoraWorldCore } from '../src/nora-world-core/index.js';
import { setConfigFilePath } from '../src/util.js';

setConfigFilePath(fileURLToPath(new URL('../default/config.yaml', import.meta.url)));
const { router } = await import('../src/endpoints/nora-story-profile.js');

async function fixture(t) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nora-auto-settings-http-'));
    const stateDirectory = path.join(root, 'profile'), userRoot = path.join(root, 'default-user');
    fs.mkdirSync(userRoot);
    const savedEnvironment = Object.fromEntries(['TAVERN_STATE_DIR', 'TAVERN_PYTHON', 'HERMES_HOME', 'TAVERN_HERMES_MEMORIES_DIR',
        'TAVERN_HERMES_STATE_DB', 'PYTHONPATH', 'PYTHONDONTWRITEBYTECODE', 'NORA_AUTO_TEST_CALLS'].map(key => [key, process.env[key]]));
    process.env.TAVERN_STATE_DIR = stateDirectory;
    const directories = { root: userRoot };
    for (const name of ['chats', 'characters', 'worlds', 'openAI_Settings', 'instruct', 'context', 'sysprompt', 'reasoning']) {
        directories[name] = path.join(userRoot, name); fs.mkdirSync(directories[name]);
    }
    const app = express(); app.use(express.json());
    app.use((request, _response, next) => { request.user = { directories }; next(); });
    app.use('/profile', router);
    const server = http.createServer(app);
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    const base = `http://127.0.0.1:${server.address().port}/profile`;
    t.after(async () => {
        server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
        for (const [key, value] of Object.entries(savedEnvironment)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
        fs.rmSync(root, { recursive: true, force: true });
    });
    const request = (route, value) => fetch(base + route, value === undefined ? {} : {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value),
    });
    return { root, stateDirectory, userRoot, directories, preferenceFile: path.join(userRoot, 'story_profile_preferences.json'), request };
}

test('current and main compatibility APIs read and change the same choice without rewriting legacy data', async t => {
    const f = await fixture(t), legacy = JSON.stringify({ automatic_reflection: { noticeVersion: 1, enabled: false }, retained: ['original'] });
    fs.writeFileSync(f.preferenceFile, legacy);
    let response = await f.request('/settings');
    assert.equal(response.status, 200); assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal((await response.json()).auto_enabled, false);
    response = await f.request('/automatic-preferences');
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { enabled: false, consentRequired: false, model: null });
    response = await f.request('/automatic-preferences', { enabled: true });
    assert.equal(response.status, 200); assert.equal((await response.json()).enabled, true);
    assert.equal((await (await f.request('/settings')).json()).auto_enabled, true);
    response = await f.request('/settings', { auto_enabled: false });
    assert.equal(response.status, 200); assert.equal((await response.json()).auto_enabled, false);
    assert.equal((await (await f.request('/automatic-preferences')).json()).enabled, false);
    assert.equal(fs.readFileSync(f.preferenceFile, 'utf8'), legacy);
    assert.equal((await f.request('/automatic-preferences', { enabled: 'false' })).status, 400);
    fs.writeFileSync(f.preferenceFile, '{changed and corrupt');
    for (const route of ['/settings', '/automatic-preferences']) {
        response = await f.request(route);
        assert.equal(response.status, 503); assert.equal(response.headers.get('cache-control'), 'no-store');
        assert.equal((await response.json()).code, 'STORY_PROFILE_SETTINGS_UNREADABLE');
    }
    assert.equal(fs.readFileSync(f.preferenceFile, 'utf8'), '{changed and corrupt');
});

test('HTTP automatic reflection stops new Python requests after off while manual continuation saves without re-extraction', async t => {
    const f = await fixture(t), callsFile = path.join(f.root, 'fake-model-calls.json');
    fs.writeFileSync(path.join(f.userRoot, 'settings.json'), JSON.stringify({ main_api: 'openai', oai_settings: {
        chat_completion_source: 'custom', custom_url: 'http://127.0.0.1:9/v1', custom_model: 'offline-fixture',
        openai_max_tokens: 4000, openai_max_context: 32000,
    } }));
    fs.writeFileSync(path.join(f.userRoot, 'secrets.json'), '{}');
    const core = createNoraWorldCore({ root: path.join(f.userRoot, 'nora-world-core'), materializer: {
        materialize: async () => ({ runtimeCard: { engine: 'sillytavern', binding: { avatar: 'fixture.png' }, ownership: 'owned' },
            defaultSession: { engine: 'sillytavern', binding: { chat_id: 'fixture-chat' }, openingState: 'empty' },
            knowledge: [], declaredCapabilities: [] }),
    } });
    const { world } = await core.createWorld({ name: '自动偏好测试', persona: { name: '测试玩家', description: '' },
        source: { type: 'manual', sha256: '', original_name: '', format: '' } }, { idempotencyKey: 'auto-preference-http' });
    const messages = [{ chat_metadata: { nora_world: { id: world.world_id }, nora_session: { id: world.sessions.default_session_id } } },
        ...Array.from({ length: 15 }, () => [{ is_user: true, mes: '我喜欢悬疑题材，请记住这个偏好。' }, { is_user: false, mes: '好的。' }]).flat()];
    const chatDirectory = path.join(f.directories.chats, 'fixture'); fs.mkdirSync(chatDirectory);
    fs.writeFileSync(path.join(chatDirectory, 'fixture-chat.jsonl'), messages.map(value => JSON.stringify(value)).join('\n'));

    // Python's real client and CLI run with an isolated transport fake. The fake
    // closes the persisted switch before returning the already-dispatched
    // extraction response; no HTTP request leaves this fixture.
    const hookDirectory = path.join(f.root, 'python-hook'); fs.mkdirSync(hookDirectory);
    fs.writeFileSync(path.join(hookDirectory, 'sitecustomize.py'), `import io,json,os
from pathlib import Path
import urllib.request
def fake_open(self,request,*args,**kwargs):
 data=json.loads(request.data)
 phase='summary' if 'story_tastes' in data['messages'][0]['content'] else 'extract'
 state=Path(os.environ['TAVERN_STATE_DIR'])
 settings=state/'story_profile_preference_settings.json'
 saved=json.loads(settings.read_text(encoding='utf-8')) if settings.exists() else {'auto_enabled':True}
 receipt=Path(os.environ['NORA_AUTO_TEST_CALLS'])
 calls=json.loads(receipt.read_text()) if receipt.exists() else []
 calls.append({'phase':phase,'enabled_at_dispatch':saved['auto_enabled']})
 receipt.write_text(json.dumps(calls))
 if phase=='extract':
  settings.write_text(json.dumps({'auto_enabled':False}),encoding='utf-8')
  output={'preferences':[{'text':'偏爱悬疑题材','evidence_ids':['m0','m2']}]}
 else:output={'story_tastes':['偏爱悬疑题材'],'narrative_habits':[],'co_creation':[],'boundaries':[]}
 document={'choices':[{'message':{'content':json.dumps(output,ensure_ascii=False)},'finish_reason':'stop'}]}
 return io.BytesIO(json.dumps(document).encode('utf-8'))
urllib.request.OpenerDirector.open=fake_open
`);
    Object.assign(process.env, { TAVERN_PYTHON: process.env.NORA_TEST_PYTHON || process.env.TAVERN_PYTHON || 'python3',
        HERMES_HOME: path.join(f.root, 'hermes'), TAVERN_HERMES_MEMORIES_DIR: path.join(f.root, 'memories'),
        TAVERN_HERMES_STATE_DB: path.join(f.root, 'state.db'), PYTHONPATH: hookDirectory,
        PYTHONDONTWRITEBYTECODE: '1', NORA_AUTO_TEST_CALLS: callsFile });
    const admission = await f.request('/checkpoint', { world_id: world.world_id });
    assert.equal(admission.status, 202); assert.equal((await admission.json()).scheduled, true);
    let status;
    for (let attempt = 0; attempt < 200; attempt++) {
        const response = await f.request('/checkpoint/' + encodeURIComponent(world.world_id));
        assert.equal(response.status, 200); status = await response.json();
        if (!status.running) break;
        await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.equal(status.running, false);
    assert.equal(status.status, 'partial', JSON.stringify(status)); assert.equal(status.extraction_complete, true);
    assert.equal(status.last_code, 'STORY_PROFILE_AUTO_REFLECTION_DISABLED');
    assert.deepEqual(JSON.parse(fs.readFileSync(callsFile)), [{ phase: 'extract', enabled_at_dispatch: true }]);
    assert.equal((await (await f.request('/settings')).json()).auto_enabled, false);
    let profile = JSON.parse(fs.readFileSync(path.join(f.stateDirectory, 'story_profile.json')));
    assert.equal(profile.stats.event_count, 1);
    const manual = await f.request('/reflect', { world_id: world.world_id });
    assert.equal(manual.status, 200); assert.equal((await manual.json()).status, 'completed');
    assert.deepEqual(JSON.parse(fs.readFileSync(callsFile)), [{ phase: 'extract', enabled_at_dispatch: true }, { phase: 'summary', enabled_at_dispatch: false }]);
    profile = JSON.parse(fs.readFileSync(path.join(f.stateDirectory, 'story_profile.json')));
    assert.equal(profile.stats.event_count, 1);
    assert.equal((await (await f.request('/checkpoint', { world_id: world.world_id })).json()).reason, 'auto_disabled');
});
