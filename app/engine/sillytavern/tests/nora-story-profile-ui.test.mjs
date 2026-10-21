import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import { createStoryPreferenceSettings } from '../../../native-extensions/nora-ui/story-profile-controller.js';

const actor = fs.readFileSync(new URL('../../../../story-profile/public/actor.js', import.meta.url), 'utf8');
const labels = fs.readFileSync(new URL('../../../../story-profile/public/i18n.js', import.meta.url), 'utf8');

async function archive(cardStatus = 200, card = {}) {
    const elements = new Map();
    for (const id of ['acRoot', 'personalityContent', 'personalityCancel', 'personalitySave']) {
        elements.set(id, { innerHTML: '', addEventListener() {}, classList: { add() {}, remove() {} } });
    }
    const calls = [];
    const scope = {
        URLSearchParams, navigator: { language: 'zh-CN' }, location: { search: '?lang=zh', href: '/' }, history: { length: 1 },
        sessionStorage: { getItem() { return null; }, setItem() {} },
        document: { documentElement: {}, body: { dataset: {} }, getElementById: id => elements.get(id) || null, querySelectorAll: () => [] },
        TavernUI: { escapeHtml: value => String(value ?? '').replaceAll('<', '&lt;'), safeSameOriginTarget: () => '' },
        fetch: async url => {
            calls.push(url);
            if (url === '/api/identity') return { ok: true, json: async () => ({}) };
            if (url === '/api/personality') return { ok: true, json: async () => ({ supported: false }) };
            assert.ok(url.startsWith('/api/actor_card'));
            return { ok: cardStatus === 200, status: cardStatus, json: async () => cardStatus === 200
                ? { career: { turns: 311 }, intimacy: { log: 1 }, knows: ['detective stories'], timeline: [], ...card }
                : { error: 'PROFILE_UNREADABLE' } };
        },
    };
    vm.runInNewContext(labels + '\n' + actor, scope);
    for (let i = 0; i < 20; i++) await Promise.resolve();
    return { elements, calls };
}

test('original archive remains read-only and has no new operation panel or model calls', async () => {
    const page = await archive();
    assert.match(page.elements.get('acRoot').innerHTML, /detective stories/);
    assert.doesNotMatch(actor, /reflectionPanel|\/api\/nora-story-profile\//);
    assert.ok(page.calls.every(url => /\/api\/(identity|personality|actor_card)/.test(url)));
    const html = fs.readFileSync(new URL('../../../../story-profile/public/actor.html', import.meta.url), 'utf8');
    assert.doesNotMatch(html, /reflectionPanel|reflectionWorld|reflectionRun/);
});

test('archive read failure stays an error rather than rendering zero records', async () => {
    const page = await archive(503);
    assert.match(page.elements.get('acRoot').innerHTML, /PROFILE_UNREADABLE/);
    assert.doesNotMatch(page.elements.get('acRoot').innerHTML, /acStats/);
});

test('reader yearbook shows concise recollections, defaults to three recently played stories, and hides machine details', async () => {
    const progress = Array.from({ length: 5 }, (_, index) => ({ world_id: `w${index}`, world_name: `世界${index}`, session_id: `session:uuid-${index}`, session_name: `session:uuid-${index}`,
        status: 'ready', summary_status: 'prepared', covered_turns: 20, total_turns: 27, last_played_at: index+1, updated_at: 100-index,
        timeline: [`已保存进展${index}`], open_threads: [`未解事项${index}`], uncovered: { from_user_turn:21,to_user_turn:27,count:7 },
        recap: {current:`近况${index}`,milestones:[`关键转折${index}`],threads:[`保留的悬念${index}`]} }));
    const page = await archive(200, { timeline: [{ change: '偏好学习不当剧情' }], story_progress: progress });
    const markup = page.elements.get('acRoot').innerHTML;
    const primary=markup.split('<details')[0], others=markup.split('<details')[1];
    assert.equal((primary.match(/data-story-world=/g)||[]).length,3);
    assert.ok(primary.indexOf('世界4')<primary.indexOf('世界3'));
    assert.match(primary,/已保存进展4/); assert.doesNotMatch(primary,/世界1|世界0/);
    assert.match(others,/查看其他故事/);assert.match(others,/世界1/);assert.match(others,/世界0/);
    assert.doesNotMatch(markup,/<details[^>]* open/);
    const visible=markup.replace(/<[^>]*>/g,'');
    assert.doesNotMatch(visible,/session:|个会话|已整理|用于续写|最近未整理|关键转折|近况4|保留的悬念|偏好学习不当剧情/);
    assert.match(markup,/记下你 1 笔/);assert.match(markup,/detective stories/);
    assert.ok(page.calls.every(url=>/\/api\/(identity|personality|actor_card)/.test(url)));
});

test('yearbook excludes unsummarized or unusable sessions and counts only saved valid progress', async () => {
    const page = await archive(200, { story_progress_status: 'ready', story_progress: [
        { world_id: 'a', world_name: '尚未整理世界', session_id: 's1', status: 'unorganized', total_turns: 12, covered_turns: 0 },
        { world_id: 'b', world_name: '未知世界', session_id: 's2', status: 'stale', total_turns: null, covered_turns: null },
        { world_id: 'c', world_name: '读取失败世界', session_id: 's3', status: 'error', total_turns: null, covered_turns: null },
        { world_id: 'd', world_name: '有效故事', session_id: 's4', status: 'ready', summary_status: 'prepared', covered_turns: 15, total_turns: 20, timeline: ['实际整理事件'], recap: { current: '实际整理事件', milestones: [], threads: [] } },
        { world_id: 'e', world_name: '空摘要世界', session_id: 's5', status: 'ready', summary_status: 'prepared', covered_turns: 0, total_turns: 0 },
    ] });
    const markup = page.elements.get('acRoot').innerHTML;
    assert.match(markup, /有效故事/);
    assert.match(markup, /实际整理事件/);
    assert.equal((markup.match(/data-story-world=/g) || []).length, 1);
    assert.doesNotMatch(markup, /个会话/);
    assert.doesNotMatch(markup, /尚未整理世界|未知世界|读取失败世界|空摘要世界/);
    assert.match(markup, /detective stories/);
    assert.match(markup, /记下你 1 笔/);
    assert.ok(page.calls.every(url => /\/api\/(identity|personality|actor_card)/.test(url)));
});

test('yearbook without summarized stories shows one empty state while read failure remains explicit', async () => {
    const page = await archive(200, { story_progress: [
        { world_id: 'empty', world_name: '空故事', session_id: 's', status: 'unorganized', covered_turns: 0, total_turns: 0 },
    ] });
    const markup = page.elements.get('acRoot').innerHTML;
    assert.match(markup, /还没有已整理的故事进展/);
    assert.doesNotMatch(markup, /data-story-world=|个会话|空故事/);
    const missing = await archive(200);
    assert.match(missing.elements.get('acRoot').innerHTML, /暂时无法读取故事进度/);
    for (const status of ['error', 'unavailable', 'stale']) {
        const failed = await archive(200, { story_progress: [{ world_id: 'failed', session_id: 's', status }] });
        const result = failed.elements.get('acRoot').innerHTML;
        assert.match(result, /暂时无法读取故事进度/);
        assert.doesNotMatch(result, /还没有已整理的故事进展|data-story-world=/);
    }
});

test('legacy yearbook shows real progress and unresolved matters without saved display prose or model calls', async () => {
    const input={world_id:'saved',world_name:'已保存世界',session_id:'session:uuid',session_name:'session:uuid',
      status:'ready',summary_status:'prepared',enabled:false,covered_turns:15,total_turns:32,code:'NORA_LEDGER_COMPRESSION_TIMEOUT',stale_candidate:true,
      timeline:['旧事件一','旧事件二','旧事件三','旧事件四'],open_threads:['旧悬念一','旧悬念二','旧悬念三'],
      scene:{time:'第三天上午',place:'咖啡店',participants:[{character_id:'__user__',activity:'等候同伴'}]},
      recap:{current:'手工填入的场景',milestones:['不应成为实际进展'],threads:[]}};
    const before=JSON.stringify(input),page=await archive(200,{story_progress:[input]});
    const markup=page.elements.get('acRoot').innerHTML,visible=markup.replace(/<[^>]*>/g,'');
    assert.match(visible,/第三天上午 · 咖啡店/);assert.match(visible,/等候同伴/);
    for(const text of [...input.timeline,...input.open_threads]) assert.ok(markup.includes(text),text);
    const main=markup.split('<details')[0];
    assert.doesNotMatch(main,/旧事件一|旧悬念三/);
    assert.match(main,/旧事件二/);assert.match(main,/旧事件四/);assert.match(main,/旧悬念一/);
    assert.match(markup,/<details[^>]*class="acStoryDetails"/);assert.doesNotMatch(markup,/<details[^>]* open/);
    assert.doesNotMatch(visible,/session:|已停用|待用摘要|已整理|用于续写|手工填入|不应成为/);
    assert.equal(JSON.stringify(input),before);
    assert.ok(page.calls.every(url=>/\/api\/(identity|personality|actor_card)/.test(url)));
});

test('yearbook preserves complete source sentences, removes exact duplicates and escapes source markup', async () => {
    const negative='确认遗嘱的内容之前'.repeat(12)+'，不能认定他已经继承了庄园。';
    const page=await archive(200,{story_progress:[{world_id:'w',world_name:'<img src=x>',session_id:'s',status:'ready',summary_status:'active',covered_turns:15,
      timeline:['收到一封信','收到一封信',negative,'<script>alert(1)</script>'],open_threads:['收到一封信','信件的来历仍未确认'],
      scene:{time:'夜晚',place:'庄园',participants:[]}}]});
    const html=page.elements.get('acRoot').innerHTML;
    assert.ok(html.includes(negative),'do not cut off the negative conclusion');
    assert.equal((html.match(/收到一封信/g)||[]).length,1);
    assert.match(html,/信件的来历仍未确认/);assert.doesNotMatch(html,/<script>|<img src=x>/);
    assert.match(html,/&lt;script>/);assert.doesNotMatch(html,/undefined|null/);
});

test('a meaningful branch name is shown only to distinguish stories in the same world', async () => {
    const row={world_id:'w',world_name:'雾港',status:'ready',summary_status:'active',covered_turns:15,
      recap:{current:'咖啡店等候',milestones:[],threads:[]}};
    const page=await archive(200,{story_progress:[{...row,session_id:'a',session_name:'番外'},{...row,session_id:'session:uuid',session_name:'session:uuid'}]});
    const visible=page.elements.get('acRoot').innerHTML.replace(/<[^>]*>/g,'');
    assert.match(visible,/番外/);assert.doesNotMatch(visible,/session:uuid/);
});

function settings({ enabled = false, failRead = false, failSave = false, waitSave = null } = {}) {
    function element() {
        const value = { children: new Map(), textContent: '', disabled: false, checked: false, isConnected: true,
            addEventListener(name, fn) { this['on' + name] = fn; },
            insertAdjacentHTML(_position, text) { parse(this, text); } };
        Object.defineProperty(value, 'innerHTML', { get: () => value.html || '', set(text) { value.html = text; value.children.clear(); parse(value, text); } });
        return value;
    }
    function parse(parent, text) {
        for (const match of text.matchAll(/data-(preference-settings|auto-preferences|preference-result|preference-retry)/g)) {
            const child = element();
            if (match[1] === 'auto-preferences') child.checked = /data-auto-preferences checked/.test(text);
            parent.children.set('[data-' + match[1] + ']', child);
        }
    }
    const calls = [];
    let modal, closeGuard;
    const dialogs = { version: 0, open(_title, markup) { this.version++; modal = element(); modal.innerHTML = markup; return modal; }, setCloseGuard(fn) { closeGuard = fn; } };
    const controller = createStoryPreferenceSettings({ dialogs, select: (selector, root) => root.children.get(selector), escapeHtml: value => String(value),
        requestHeaders: () => ({ 'Content-Type': 'application/json', 'X-CSRF-Token': 'test-csrf' }),
        fetchImpl: async (url, options) => {
            calls.push({ url, options });
            assert.equal(url, '/api/nora-story-profile/settings');
            if (options.method === 'POST') {
                if (waitSave) await waitSave;
                if (failSave) throw new Error('lost acknowledgement');
                enabled = JSON.parse(options.body).auto_enabled;
            } else if (failRead) return { ok: false, json: async () => ({ error: 'SETTINGS_UNREADABLE' }) };
            return { ok: true, json: async () => ({ auto_enabled: enabled }) };
        } });
    return { controller, calls, dialogs, body: () => modal.children.get('[data-preference-settings]'), guard: () => closeGuard(), readWorks() { failRead = false; } };
}

test('curator settings read existing enabled choice without changing it or calling models', async () => {
    const page = settings({ enabled: true });
    await page.controller.open();
    assert.equal(page.body().children.get('[data-auto-preferences]').checked, true);
    assert.equal(page.calls.length, 1);
    assert.equal(page.calls[0].options.method, 'GET');
    assert.match(page.body().innerHTML, /all worlds|所有世界/);
    assert.match(page.body().innerHTML, /charges|费用/);
    assert.doesNotMatch(page.body().innerHTML, /<select|reflectionRun|reflectionSummary/);
});

test('explicit on and off choices persist through the same consent endpoint with CSRF', async () => {
    const page = settings(); await page.controller.open();
    const toggle = page.body().children.get('[data-auto-preferences]');
    for (const enabled of [true, false]) {
        toggle.checked = enabled; await toggle.onchange();
        const call = page.calls.at(-1);
        assert.deepEqual(JSON.parse(call.options.body), { auto_enabled: enabled, consent_version: 'story-profile-auto/v1' });
        assert.equal(call.options.headers['X-CSRF-Token'], 'test-csrf');
        assert.equal(toggle.checked, enabled);
        assert.equal(toggle.disabled, false);
    }
    await page.controller.open();
    assert.equal(page.body().children.get('[data-auto-preferences]').checked, false);
});

test('unreadable settings never masquerade as a disabled choice and can be reread', async () => {
    const page = settings({ enabled: true, failRead: true }); await page.controller.open();
    assert.equal(page.body().children.has('[data-auto-preferences]'), false);
    assert.match(page.body().innerHTML, /SETTINGS_UNREADABLE/);
    page.readWorks(); await page.body().children.get('[data-preference-retry]').onclick();
    assert.equal(page.body().children.get('[data-auto-preferences]').checked, true);
});

test('lost save acknowledgement stays unconfirmed and blocks further changes until reread', async () => {
    const page = settings({ failSave: true }); await page.controller.open();
    const toggle = page.body().children.get('[data-auto-preferences]'); toggle.checked = true; await toggle.onchange();
    assert.equal(toggle.disabled, true);
    assert.match(page.body().children.get('[data-preference-result]').textContent, /unconfirmed|未能确认/);
    assert.equal(page.calls.length, 2);
});

test('double submission is blocked and closing is guarded only during the write', async () => {
    let release; const waiting = new Promise(resolve => { release = resolve; });
    const page = settings({ waitSave: waiting }); await page.controller.open();
    const toggle = page.body().children.get('[data-auto-preferences]'); toggle.checked = true;
    const first = toggle.onchange(); await toggle.onchange();
    assert.equal(page.calls.filter(x => x.options.method === 'POST').length, 1);
    assert.equal(page.guard(), false); release(); await first; assert.equal(page.guard(), true);
});
