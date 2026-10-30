const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
const { parse } = require('../installer/desktop/node_modules/acorn');
const { DOMParser } = require('../installer/desktop/node_modules/@xmldom/xmldom');

const source = fs.readFileSync(path.join(__dirname, '../installer/launcher-controller.js'), 'utf8');
const statements = parse(source, { ecmaVersion: 'latest' }).body[0].expression.callee.body.body;
function definition(name) {
  const node = statements.find(item => item.id?.name === name || item.expression?.left?.name === name
    || item.declarations?.some(declaration => declaration.id.name === name));
  assert.ok(node, `production controller definition ${name} exists`);
  return source.slice(node.start, node.end);
}

// A DOM adapter for controller behavior only. It supplies standard tree/field
// operations; these tests make no claims about browser layout or native windows.
class Element {
  constructor(tag = 'div') {
    this.tagName = tag.toLowerCase(); this.children = []; this.attributes = {};
    this.dataset = {}; this.style = {}; this.hidden = false; this.disabled = false;
    this.classList = {
      contains: name => this.className.split(/\s+/).includes(name),
      add: (...names) => { this.className = [...new Set([...this.className.split(/\s+/).filter(Boolean), ...names])].join(' '); },
      remove: (...names) => { this.className = this.className.split(/\s+/).filter(name => !names.includes(name)).join(' '); },
      toggle: (name, force) => {
        const enabled = force ?? !this.classList.contains(name);
        this.classList[enabled ? 'add' : 'remove'](name); return enabled;
      },
    };
  }
  get id() { return this.attributes.id || ''; }
  set id(value) { this.attributes.id = value; }
  get className() { return this.attributes.class || ''; }
  set className(value) { this.attributes.class = value; }
  get type() { return this.attributes.type || ''; }
  set type(value) { this.attributes.type = value; }
  get value() {
    if (this.tagName === 'select') {
      const options = this.querySelectorAll('option');
      return this.fieldValue === undefined ? options[0]?.value || '' : options.some(option => option.value === this.fieldValue) ? this.fieldValue : '';
    }
    return this.fieldValue ?? this.attributes.value ?? '';
  }
  set value(value) { this.fieldValue = String(value); }
  get textContent() { return this.text || this.children.map(child => child.textContent).join(''); }
  set textContent(value) { this.replaceChildren(); this.text = String(value); }
  get isConnected() { return Boolean(this.root || this.parentElement?.isConnected); }
  setAttribute(name, value) {
    this.attributes[name] = String(value);
    if (name === 'hidden') this.hidden = true;
    if (name.startsWith('data-')) this.dataset[name.slice(5).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())] = String(value);
  }
  getAttribute(name) { return this.attributes[name] ?? null; }
  append(...children) {
    for (const child of children) { child.remove(); child.parentElement = this; this.children.push(child); }
  }
  prepend(...children) { this.append(...children); this.children.unshift(...this.children.splice(-children.length)); }
  replaceChildren(...children) { for (const child of this.children) child.parentElement = null; this.children = []; this.text = ''; this.append(...children); }
  remove() { if (this.parentElement) this.parentElement.children = this.parentElement.children.filter(child => child !== this); this.parentElement = null; }
  matches(selector) {
    const attributes = [...selector.matchAll(/\[([^=\]]+)(?:="([^"]*)")?\]/g)];
    const simple = selector.replace(/\[[^\]]+\]/g, '');
    const id = simple.match(/#([\w-]+)/)?.[1], classes = [...simple.matchAll(/\.([\w-]+)/g)].map(match => match[1]);
    const tag = simple.match(/^[\w-]+/)?.[0];
    return (!tag || this.tagName === tag) && (!id || this.id === id) && classes.every(name => this.classList.contains(name))
      && attributes.every(([, name, value]) => this.getAttribute(name) !== null && (value === undefined || this.getAttribute(name) === value));
  }
  querySelectorAll(selector) {
    const descendants = this.children.flatMap(child => [child, ...child.querySelectorAll('*')]);
    return descendants.filter(child => selector.split(',').some(part => {
      const pieces = part.trim().split(/\s+/), last = pieces.pop();
      if (!child.matches(last)) return false;
      let owner = child.parentElement;
      while (pieces.length) { while (owner && !owner.matches(pieces.at(-1))) owner = owner.parentElement; if (!owner) return false; pieces.pop(); owner = owner.parentElement; }
      return true;
    }));
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  closest(selector) { return this.matches(selector) ? this : this.parentElement?.closest(selector) || null; }
  focus() { this.focused = true; }
  scrollIntoView() {}
  set innerHTML(html) {
    const parsed = new DOMParser().parseFromString(`<section>${html.replace(/\s(hidden|disabled)(?=[\s>])/g, ' $1="$1"')}</section>`, 'text/html');
    const convert = node => {
      const item = new Element(node.nodeType === 3 ? '#text' : node.tagName);
      if (node.nodeType === 3) { item.textContent = node.data; return item; }
      for (let index = 0; index < node.attributes.length; index++) { const attribute = node.attributes.item(index); item.setAttribute(attribute.name, attribute.value); }
      for (let child = node.firstChild; child; child = child.nextSibling) item.append(convert(child));
      return item;
    };
    this.replaceChildren(...Array.from(parsed.documentElement.childNodes).map(convert));
  }
}

function fixture({ current, initial = {}, providers, read, switchSaved, deleteSaved } = {}) {
  const root = new Element('main'); root.id = 'main'; root.root = true;
  const nodes = new Map([['main', root]]);
  for (const id of ['inline', 'management', 'steps', 'status', 'launchbar', 'launch', 'more', 'moreButton', 'stopAll']) {
    const item = new Element(id === 'launch' ? 'button' : 'div'); item.id = id; root.append(item); nodes.set(id, item);
  }
  nodes.get('launch').append(new Element('span'));
  const entry = new Element('button'); entry.setAttribute('data-action', 'model'); nodes.get('management').append(entry);
  const state = { installed: true, hermesInstalled: true, noraInstalled: true, systemReady: true,
    setupCompleted: true, modelConfigured: true, modelProvider: 'openrouter', modelName: 'stale-model',
    clawchatPaired: true, gatewayRunning: true, running: true, clawchatConnected: true, ...initial };
  const calls = [];
  const catalog = providers || [{ id: 'openrouter', label: 'OpenRouter' }, { id: 'custom', label: '自定义模型', custom: true }];
  let currentValue = current ?? { configured: true, provider: 'custom', model: 'saved-model', baseUrl: 'https://fixture.invalid/v1', authMode: 'key' };
  const api = {
    modelProviders: async () => { calls.push('read-model'); return read ? read() : { ok: true, providers: catalog,
      current: currentValue }; },
    status: async () => ({ ...state }),
    modelOptions: async payload => { calls.push({ list: { ...payload } }); return { models: ['listed-model'] }; },
    saveAndTestModel: async payload => {
      calls.push({ save: { ...payload } }); state.modelConfigured = true;
      const saved = { id:'added',provider:payload.provider,model:payload.model,baseUrl:payload.baseUrl,authMode:payload.authMode,selected:true,available:true };
      currentValue = {configured:true,...saved,selectedId:saved.id,models:[saved],activation:{state:'unknown'}}; return { ok:true };
    },
    switchModel: async (request, options) => {
      calls.push({switch:request.id});
      if(switchSaved)return switchSaved(request,options);
      const model=currentValue.models.find(item=>item.id===request.id);
      currentValue={...currentValue,...model,selectedId:request.id,models:currentValue.models.map(item=>({...item,selected:item.id===request.id}))};
      return {ok:true,current:currentValue,activation:{state:'unknown'}};
    },
    deleteModel: async (request, options) => {
      calls.push({delete:request.id});
      if(deleteSaved)return deleteSaved(request,options);
      currentValue={...currentValue,models:currentValue.models.filter(item=>item.id!==request.id)};
      return {ok:true,current:currentValue};
    },

  };
  const $ = id => root.id === id ? root : root.querySelector(`#${id}`);
  const button = (text, onclick) => Object.assign(new Element('button'), { textContent: text, onclick });
  const context = vm.createContext({ api, $, snapshot: { ...state }, busy: false, daily: true, running: true,
    stage: 2, labels: ['诺拉', '酒馆', '模型', 'ClawChat', '启动'], milestoneStates: [], view: 'daily', modelFormGeneration: 0, modelSelectionUncertain:false,modelSelectionOperation:null,
    pageReturnFocus: null, statusUnknown: false, lastStatusAt: 0, alive: true, refreshing: false, launcherRecoveryConfirmed: false,
    lastFailure: null, firstCompletionPending: false, sawIncompleteSetup: false, operationCancelled: false,
    activeAction: '', activeService: 'all', versionInfo: null, autoStartAttempted: true, bundledUpgradeAttempted: false,
    launchHint: new Element('p'), pollTimer: null, pairTimer: null,
    document: { createElement: tag => new Element(tag), createTextNode: text => Object.assign(new Element('#text'), { textContent: text }),
      querySelectorAll: selector => root.querySelectorAll(selector) },
    button, clearInline: () => $('inline').replaceChildren(),
    say: (...copy) => { context.copy = copy; },
    editHeader: (title,returnLabel='返回酒馆') => { const heading = new Element('div'); heading.className='edit-head'; const label=new Element('span'); label.textContent=title;
      heading.append(label,button(returnLabel, () => context.closeEdit())); $('inline').append(heading); },
    run: (action, options) => { calls.push({ action, ...options }); }, checkVersionsInBackground() {},
    setTimeout: () => 1, clearTimeout() {}, clearInterval() {}, Date, URL,
  });
  const names = ['textError', 'errorCopy', 'operationFailure', 'currentOperation', 'allowedActions', 'noraUpdateGuidance', 'unknownStatusCopy',
    'operationFact', 'retryLabel', 'canCheckNewUpdate', 'hasLogs', 'appendActions', 'recoveredOperation', 'complete', 'canReturnHome',
    'serviceRunning', 'allRunning', 'syncState', 'readStatus', 'hideMenu', 'controls', 'displaySteps', 'setupStage', 'renderServices',
    'renderConversationEntry', 'showVersionNotice', 'dailyHome', 'closeEdit', 'savedModelConfiguration', 'modelActivation', 'modelAuthLabel', 'modelConnectionText', 'renderModelList', 'unresolvedModelOperation', 'recheckModelOperation', 'modelSettings', 'modelForm',
    'pendingModel', 'recheckFailure', 'refreshFailure', 'fail', 'route', 'poll'];
  vm.runInContext(names.map(definition).join('\n'), context);
  const binding = statements.find(node => node.type === 'ExpressionStatement' && node.expression?.callee?.object?.callee?.property?.name === 'querySelectorAll'
    && node.expression.callee.object.arguments[0]?.value === '[data-action]');
  assert.ok(binding, 'the production navigation handler exists');
  vm.runInContext(source.slice(binding.start, binding.end), context);
  const settle = async () => { for (let count = 0; count < 5; count++) await new Promise(resolve => setImmediate(resolve)); };
  const click = async text => { const target = $('inline').querySelectorAll('button').find(item => item.textContent === text); assert.ok(target, `button ${text} exists`); await target.onclick({ currentTarget: target }); await settle(); };
  return { context, state, api, calls, $, entry, click, settle,
    open: async () => { entry.onclick(); await settle(); },
    poll: () => vm.runInContext('poll()', context),
    modelRows: () => $('inline').querySelectorAll('.model-row'),
    rows: () => $('inline').querySelectorAll('.model-row').map(row => ['.model-name','.model-connection','.model-state'].map(selector=>row.querySelector(selector).textContent)),
  };
}

test('configured model entry shows saved native configuration before any credential form', async () => {
  const f = fixture({ current: { configured: true, provider: 'custom', model: 'native-saved-model',
    baseUrl: 'https://fixture.invalid/v1', authMode: 'none', activation: 'next-session' } });
  await f.open();
  assert.deepEqual(f.rows(), [['native-saved-model','自定义模型','当前默认']]);
  assert.match(f.$('inline').querySelector('.model-details').textContent,/https:\/\/fixture.invalid\/v1/);
  assert.match(f.$('inline').querySelector('.model-details').textContent,/无需认证/);
  assert.equal(f.context.copy[0], '模型设置'); assert.equal(f.$('key'), null);
  assert.equal(f.context.view, 'model-overview');
  assert.doesNotMatch(f.$('inline').textContent, /stale-model|运行中|已生效/);
  assert.deepEqual(f.calls, ['read-model']);
  await f.click('+ 添加模型');
  assert.equal(f.context.view, 'model'); assert.equal(f.$('provider').value, 'custom');
  assert.equal(f.$('model').value, 'native-saved-model'); assert.equal(f.$('key').value, '');
  assert.equal(f.$('authMode').value, 'none');
  assert.equal(f.$('key').closest('.secret').parentElement.hidden, true);
  assert.deepEqual(f.calls, ['read-model'], 'entering the editor does not save or validate');
});

test('connection labels keep internal custom IDs and full addresses out of the primary summary', async () => {
  const current={configured:true,selectedId:'current',models:[{id:'current',provider:'custom:nora-launcher',
    model:'kimi-for-coding',connectionLabel:'https://api.kimi.com/coding/v1',baseUrl:'https://api.kimi.com/coding/v1',
    selected:true,available:true,authMode:'key'}]};
  const f=fixture({current});await f.open();
  assert.deepEqual(f.rows(),[['kimi-for-coding','自定义模型 · api.kimi.com','当前默认']]);
  assert.match(f.modelRows()[0].querySelector('.model-details').textContent,/https:\/\/api.kimi.com\/coding\/v1/);
});

test('compact summaries still distinguish paths and saved connection suffixes for identical model names', async () => {
  const current={configured:true,selectedId:'one',models:[
    {id:'one',provider:'custom:one',model:'same',connectionLabel:'https://relay.invalid/a/v1',baseUrl:'https://relay.invalid/a/v1',available:true},
    {id:'two',provider:'custom:two',model:'same',connectionLabel:'https://relay.invalid/b/v1 · ab1234',baseUrl:'https://relay.invalid/b/v1',available:true},
    {id:'three',provider:'custom:three',model:'same',connectionLabel:'https://relay.invalid/b/v1 · cd5678',baseUrl:'https://relay.invalid/b/v1',available:true},
  ]};
  const f=fixture({current});await f.open();
  assert.deepEqual(f.rows().map(row=>row[1]),['自定义模型 · relay.invalid/a/v1',
    '自定义模型 · relay.invalid/b/v1 · ab1234','自定义模型 · relay.invalid/b/v1 · cd5678']);
});

test('an unknown native provider stays truthful until the user explicitly changes models', async () => {
  const f = fixture({ current: { configured: true, provider: 'opencode-go', model: 'go-native-model', authMode: 'native' } });
  await f.open();
  assert.deepEqual(f.rows(), [['go-native-model','opencode-go','当前默认']]);
  assert.match(f.$('inline').querySelector('.model-details').textContent,/Hermes 原生认证/);
  assert.equal(f.$('provider'), null); assert.equal(f.$('key'), null);
  await f.click('+ 添加模型');
  assert.equal(f.$('provider').value, 'openrouter', 'the unchanged supported editor opens only after an explicit change');
  assert.equal(f.calls.filter(call => call.save).length, 0);
});

test('an unconfigured entry and first setup retain the original direct form', async () => {
  for (const firstSetup of [false, true]) {
    const f = fixture({ current: { configured: false }, initial: firstSetup ? { setupCompleted: false, modelConfigured: false, clawchatPaired: false } : {} });
    if (firstSetup) { vm.runInContext('route()', f.context); await f.settle(); } else await f.open();
    assert.equal(f.context.view, 'model'); assert.ok(f.$('key')); assert.equal(f.rows().length, 0);
    assert.equal(f.$('inline').querySelectorAll('button').some(item => item.textContent === '+ 添加模型'), false);
    assert.deepEqual(f.calls, ['read-model']);
  }
});

test('configuration read failures offer a real requery and never become an empty replacement form', async () => {
  for (const rejects of [false, true]) {
    let failing = true;
    const f = fixture({ read: () => {
      if (failing) { if (rejects) throw new Error('模型配置暂时无法读取。'); return { ok: false, warning: '模型配置暂时无法读取。' }; }
      return { ok: true, providers: [], current: { configured: true, provider: 'native-provider', model: 'native-model' } };
    } });
    await f.open(); assert.match(f.$('inline').textContent,/模型配置读取失败/); assert.equal(f.$('key'), null);
    failing = false; await f.click('重新查询');
    assert.deepEqual(f.rows(), [['native-model','native-provider','当前默认']]);
    assert.deepEqual(f.calls, ['read-model', 'read-model']);
  }
});

test('polling preserves both the saved overview and an explicit replacement draft', async () => {
  const f = fixture(); await f.open();
  const overview = f.$('inline').children.slice();
  f.state.gatewayRunning = false; await f.poll();
  assert.deepEqual(f.$('inline').children, overview);
  await f.click('+ 添加模型');
  f.$('key').value = 'fixture-unsaved-key'; f.$('model').value = 'draft-model';
  f.$('endpoint').value = 'https://draft.invalid/v1';
  const form = f.$('key').closest('form');
  f.state.modelProvider = 'another-native-provider'; f.state.modelName = 'another-saved-model'; await f.poll();
  assert.equal(f.$('key').closest('form'), form);
  assert.equal(f.$('key').value, 'fixture-unsaved-key'); assert.equal(f.$('model').value, 'draft-model');
  assert.equal(f.$('endpoint').value, 'https://draft.invalid/v1');
  assert.deepEqual(f.calls, ['read-model']);
});

test('returning home ignores a late overview result or failure', async () => {
  for (const rejects of [false, true]) {
    let finish;
    const f = fixture({ read: () => new Promise((resolve, reject) => { finish = rejects ? reject : resolve; }) });
    f.entry.onclick(); await f.settle(); await f.click('返回酒馆');
    finish(rejects ? new Error('迟到的读取失败。') : { ok: true, providers: [], current: { configured: true, provider: 'late', model: 'late' } });
    await f.settle();
    assert.equal(f.context.view, 'daily'); assert.ok(f.$('inline').querySelector('.services'));
    assert.equal(f.rows().length, 0); assert.equal(f.$('key'), null);
  }
});

test('pending synchronization and a failure correction keep their direct editing context', async () => {
  for (const pending of [false, true]) {
    const f = fixture();
    if (pending) vm.runInContext('pendingModel()', f.context);
    else vm.runInContext("fail({allowedActions:['configure-model']}, 'start')", f.context);
    await f.click(pending ? '更换模型配置' : '配置模型');
    assert.equal(f.context.view, 'model'); assert.ok(f.$('key')); assert.equal(f.rows().length, 0);
  }
});

test('the original editor keeps key masking and list lookup, then returns saved additions to the list', async () => {
  const f = fixture(); await f.open(); await f.click('+ 添加模型');
  f.$('key').value = 'fixture-only-key';
  assert.equal(f.$('key').type, 'password'); f.$('inline').querySelector('.eye').onclick();
  assert.equal(f.$('key').type, 'text'); f.$('inline').querySelector('.eye').onclick();
  assert.equal(f.$('key').type, 'password');
  await f.$('loadModels').onclick(); assert.equal(f.$('modelOptions').children[0].value, 'listed-model');
  f.$('model').value = 'manual-model';
  await f.$('key').closest('form').onsubmit({ preventDefault() {} });
  assert.equal(f.context.copy[0],'模型设置'); assert.equal(f.context.view,'model-overview');
  assert.deepEqual(f.rows(),[['manual-model','自定义模型','当前默认']]);
  const saved = f.calls.find(call => call.save).save;
  assert.deepEqual(saved, { provider: 'custom', key: 'fixture-only-key', model: 'manual-model', baseUrl: 'https://fixture.invalid/v1', authMode: 'key' });
  assert.equal(f.modelRows()[0].querySelector('.model-switch'),null);
  assert.doesNotMatch(f.$('modelList').textContent,/重启诺拉/);
});

test('a saved addition with an interrupted final status query returns to the list after rechecking without saving again', async () => {
  const f=fixture();await f.open();await f.click('+ 添加模型');
  f.$('key').value='fixture-only-key';f.$('model').value='new-saved-model';
  let reads=0;f.api.status=async()=>{if(reads++===0)throw new Error('状态查询暂时中断。');return {...f.state};};
  await f.$('key').closest('form').onsubmit({preventDefault(){}});
  assert.equal(f.context.view,'model');assert.match(f.$('feedback').textContent,/配置已保存/);
  await f.$('modelStatusRecheck').onclick();
  assert.equal(f.context.view,'model-overview');assert.equal(f.rows()[0][0],'new-saved-model');
  assert.equal(f.calls.filter(call=>call.save).length,1);assert.equal(f.context.busy,false);
});

test('an unknown addition result offers requery and cannot use the old configured model as success', async () => {
  const f=fixture();await f.open();await f.click('+ 添加模型');
  f.$('key').value='fixture-only-key';f.$('model').value='requested-new-model';
  const operation={operationId:'unknown-save',kind:'model',snapshotSequence:4,state:'failed',busy:false,
    effectState:'unknown',verification:'unconfirmed',recoveryOutcome:'recovery-required',allowedActions:['recheck','logs']};
  f.state.operation=operation;
  const save=f.api.saveAndTestModel;let writes=0;
  f.api.saveAndTestModel=async()=>{writes++;throw Object.assign(new Error('模型保存响应中断。'),{code:'INVALID_RESPONSE',operation});};
  f.api.operationSnapshot=async id=>{assert.equal(id,operation.operationId);return {...f.state.operation};};
  const form=f.$('key').closest('form');
  await form.onsubmit({preventDefault(){}});
  assert.equal(form.querySelector('button[type="submit"]').disabled,true);
  assert.equal(f.$('modelStatusRecheck').hidden,false);
  await form.onsubmit({preventDefault(){}});assert.equal(writes,1);
  await f.$('modelStatusRecheck').onclick();
  assert.equal(f.context.view,'model','the old configured model is not evidence that this save succeeded');
  assert.equal(form.querySelector('button[type="submit"]').disabled,true);
  assert.equal(f.$('model').value,'requested-new-model');
  f.state.operation={...operation,snapshotSequence:5,effectState:'untouched',recoveryOutcome:'not-required',allowedActions:['retry','recheck','logs']};
  await f.$('modelStatusRecheck').onclick();
  assert.equal(f.context.view,'model');assert.equal(f.$('model').value,'requested-new-model');
  assert.equal(form.querySelector('button[type="submit"]').disabled,false);
  assert.equal(writes,1,'inspection must not send another model request');
  f.api.saveAndTestModel=save;f.state.operation=null;
  await form.onsubmit({preventDefault(){}});
  assert.equal(f.context.view,'model-overview');assert.equal(f.rows()[0][0],'requested-new-model');
});

test('an unknown addition follows its own task rather than a later successful operation', async () => {
  const f=fixture();await f.open();await f.click('+ 添加模型');f.$('key').value='fixture-only-key';
  const operation={operationId:'original-save',kind:'model',snapshotSequence:4,state:'failed',busy:false,
    effectState:'unknown',verification:'unconfirmed',recoveryOutcome:'recovery-required',allowedActions:['recheck','logs']};
  f.api.saveAndTestModel=async()=>{throw Object.assign(new Error('模型保存响应中断。'),{operation});};
  let inspected=0;f.api.operationSnapshot=async id=>{assert.equal(id,operation.operationId);inspected++;return operation;};
  const form=f.$('key').closest('form');await form.onsubmit({preventDefault(){}});
  f.state.operation={...operation,operationId:'unrelated-save',state:'succeeded',verification:'confirmed',effectState:'changed',recoveryOutcome:'not-required'};
  await f.$('modelStatusRecheck').onclick();
  assert.equal(inspected,1);assert.equal(f.context.view,'model');
  assert.equal(form.querySelector('button[type="submit"]').disabled,true);
});

test('a failed task query retains the uncertain draft and releases the busy state', async () => {
  const f=fixture();await f.open();await f.click('+ 添加模型');
  f.$('key').value='fixture-only-key';f.$('model').value='draft-model';
  const operation={operationId:'original-save',kind:'model',snapshotSequence:4,state:'failed',busy:false,
    effectState:'unknown',verification:'unconfirmed',recoveryOutcome:'recovery-required',allowedActions:['recheck','logs']};
  f.api.saveAndTestModel=async()=>{throw Object.assign(new Error('模型保存响应中断。'),{operation});};
  f.api.operationSnapshot=async()=>{throw new Error('原任务暂时无法读取。');};
  const form=f.$('key').closest('form');await form.onsubmit({preventDefault(){}});
  await f.$('modelStatusRecheck').onclick();
  assert.equal(f.context.busy,false);assert.equal(f.$('modelStatusRecheck').hidden,false);
  assert.equal(f.$('modelStatusRecheck').disabled,false);
  assert.equal(form.querySelector('button[type="submit"]').disabled,true);
  assert.equal(f.$('model').value,'draft-model');assert.equal(f.$('key').value,'fixture-only-key');
});

const savedConnections = () => ({configured:true,provider:'custom',model:'same-model',selectedId:'first',models:[
  {id:'second',provider:'custom',model:'same-model',connectionLabel:'连接 B',baseUrl:'https://second.invalid/v1',authMode:'key',selected:false,available:true},
  {id:'first',provider:'custom',model:'same-model',connectionLabel:'连接 A',baseUrl:'https://first.invalid/v1',authMode:'key',selected:true,available:true},
]});

test('saved connections stay distinct, current default comes first, and switch phases retain its badge until confirmation', async () => {
  let finish,progress;
  const current=savedConnections(),f=fixture({current,switchSaved:(_request,options)=>{
    progress=options.onEvent;return new Promise(resolve=>{finish=resolve;});
  }});
  await f.open();
  assert.deepEqual(f.rows(),[['same-model','自定义模型 · 连接 A','当前默认'],['same-model','自定义模型 · 连接 B','']]);
  assert.equal(f.$('inline').textContent.split('模型设置').length-1,0,'the title is not duplicated inside the list');
  assert.equal(f.$('inline').querySelectorAll('details').length,2);
  assert.doesNotMatch(f.$('modelList').textContent,/API Key.*fixture/);
  const target=f.modelRows()[1],action=target.querySelector('.model-switch'),pending=action.onclick();
  await f.settle();assert.equal(action.textContent,'验证中');assert.equal(f.context.busy,true);
  assert.equal(f.modelRows()[0].dataset.modelId,'first');assert.equal(f.modelRows()[0].querySelector('.model-state').textContent,'当前默认');
  assert.equal(f.$('inline').querySelector('.model-add').disabled,true);
  assert.equal(f.$('inline').querySelector('.edit-head button').disabled,true);
  await action.onclick();assert.equal(f.calls.filter(call=>call.switch).length,1);
  progress({event:'model-switch',phase:'applying'});assert.equal(action.textContent,'切换中');
  const updated={...current,selectedId:'second',models:current.models.map(model=>({...model,selected:model.id==='second'}))};
  finish({ok:true,current:updated,activation:{state:'unknown'}});await pending;
  assert.equal(f.modelRows()[0].dataset.modelId,'second');assert.equal(f.modelRows()[0].querySelector('.model-state').textContent,'当前默认');
  assert.equal(f.context.busy,false);assert.equal(f.$('inline').querySelector('.model-add').disabled,false);
  assert.equal(f.calls.filter(call=>call.apply).length,0,'switching never restarts Nora');
});

test('an explicit candidate refusal remains inline, keeps the current model and permits a deliberate retry', async () => {
  let attempts=0;const current=savedConnections();
  const f=fixture({current,switchSaved:async()=>{
    if(++attempts===1)throw Object.assign(new Error('服务暂不可用。'),{modelFailureStage:'candidate',guidance:{title:'服务暂不可用。',detail:'请稍后重试。'}});
    return {ok:true,current:{...current,selectedId:'second',models:current.models.map(model=>({...model,selected:model.id==='second'}))},activation:{state:'pending'}};
  }});
  await f.open();await f.modelRows()[1].querySelector('.model-switch').onclick();
  assert.equal(f.context.view,'model-overview');assert.equal(f.context.copy[0],'模型设置');
  assert.match(f.modelRows()[1].querySelector('.model-row-feedback').textContent,/服务暂不可用/);
  assert.equal(f.modelRows()[0].dataset.modelId,'first');assert.equal(f.context.modelSelectionUncertain,false);
  await f.click('重试');assert.equal(attempts,2);assert.equal(f.rows()[0][2],'待生效');
  assert.equal(f.calls.filter(call=>call.apply).length,0);
});

test('unknown or partial switch outcomes require inspection before any further mutation', async () => {
  for(const partial of [false,true]){
    const f=fixture({current:savedConnections(),switchSaved:async()=>{throw Object.assign(new Error('切换结果尚未确认。'),
      partial?{userCode:'MODEL_CONFIG_PARTIAL',modelFailureStage:'candidate'}:{});}});
    await f.open();await f.modelRows()[1].querySelector('.model-switch').onclick();
    assert.equal(f.context.modelSelectionUncertain,true);assert.equal(f.$('inline').querySelector('.model-add').disabled,true);
    await f.modelRows()[1].querySelector('.model-switch').onclick();assert.equal(f.calls.filter(call=>call.switch).length,1);
    assert.equal(f.$('inline').querySelectorAll('button').some(button=>button.textContent==='重试'),false);
    await f.click('重新查询');assert.equal(f.calls.filter(call=>call==='read-model').length,2);
    assert.equal(f.context.modelSelectionUncertain,false);assert.equal(f.modelRows()[0].dataset.modelId,'first');
  }
});

test('requery closes the original model task before enabling writes and never repeats the mutation',async()=>{
 for(const deleting of [false,true]){
  let confirmed=false,queryFails=true;const current=savedConnections();
  const pending={operationId:'original-model-operation',kind:'model',state:'failed',effectState:'unknown',
    recoveryOutcome:'recovery-required',snapshotSequence:8};
  const refused=async()=>{throw {operation:pending,guidance:{title:'结果尚未确认。'}};};
  const f=fixture({current,switchSaved:refused,deleteSaved:refused,
    read:()=>({ok:true,providers:[{id:'deepseek',label:'DeepSeek'},{id:'opencode-go',label:'Go'}],
      current:confirmed?{...current,selectedId:deleting?'first':'second',
        models:deleting?current.models.filter(row=>row.id==='first'):current.models}:current})});
  const queried=[];
  f.api.operationSnapshot=async id=>{queried.push(id);return pending;};
  f.api.recheckOperation=async payload=>{
    assert.equal(payload.operationId,pending.operationId);assert.equal(payload.snapshotSequence,8);
    if(queryFails)throw new Error('fixture query failed');
    return {operation:confirmed?{...pending,state:'succeeded',effectState:'changed',verification:'confirmed',recoveryOutcome:'not-required'}:pending};
  };
  await f.open();
  if(deleting){await f.modelRows()[1].querySelector('.model-delete').onclick();await f.click('确认删除');}
  else await f.modelRows()[1].querySelector('.model-switch').onclick();
  f.state.operation={operationId:'unrelated-operation',kind:'start',state:'succeeded',effectState:'untouched'};
  await f.click('重新查询');assert.equal(f.context.modelSelectionUncertain,true);
  queryFails=false;await f.click('重新查询');assert.equal(f.context.modelSelectionUncertain,true);
  assert.equal(f.$('inline').querySelector('.model-add'),null,'unconfirmed task cannot expose new writes');
  confirmed=true;await f.click('重新查询');assert.equal(f.context.modelSelectionUncertain,false);
  assert.equal(f.$('inline').querySelector('.model-add').disabled,false);
  assert.ok(queried.every(id=>id===pending.operationId));
  assert.equal(f.calls.filter(call=>deleting?call.delete:call.switch).length,1);
  if(deleting)assert.equal(f.modelRows().length,1);else assert.equal(f.modelRows()[0].dataset.modelId,'second');
 }
});

test('confirmed saved configuration can continue after a failed final setup check without saving again',async()=>{
 for(const syncPending of [false,true]){
  const f=fixture();let writes=0;
  const original={operationId:'saved-config-task',kind:'model',snapshotSequence:5,state:'failed',
    effectState:'unknown',recoveryOutcome:'recovery-required'};
  f.api.saveAndTestModel=async()=>{writes++;throw {operation:original,userCode:'MODEL_CONFIG_PARTIAL'};};
  f.api.operationSnapshot=async()=>original;
  f.api.resumeModelSetup=async()=>{throw new Error('A read must not start synchronization automatically');};
  f.api.recheckOperation=async()=>({operation:{...original,effectState:'changed',verification:'confirmed',
    recoveryOutcome:'not-required',result:{configurationSaved:true}}});
  await f.open();await f.click('+ 添加模型');f.$('key').value='synthetic-key';f.$('model').value='new-model';
  await f.$('key').closest('form').onsubmit({preventDefault(){}});
  assert.equal(f.$('key').closest('form').querySelector('button[type="submit"]').disabled,true);
  f.state.modelSyncPending=syncPending;
  f.api.modelProviders=async()=>({ok:true,providers:[{id:'custom',label:'自定义模型',custom:true}],
    current:{configured:true,provider:'custom',model:'new-model',selectedId:'new',models:[
      {id:'new',provider:'custom',model:'new-model',selected:true,available:true}]}});
  await f.click('重新查询状态');
  assert.equal(f.context.view,syncPending?'model-pending':'model-overview');
  if(!syncPending)assert.equal(f.modelRows()[0].querySelector('.model-name').textContent,'new-model');
  assert.equal(writes,1,'setup requery does not resubmit credentials or validation');
 }
});

test('stopped models show next use and unavailable connections cannot be switched', async () => {
  const current=savedConnections();current.models[0].available=false;current.models[0].problem='连接凭据暂不可用。';
  const f=fixture({current,initial:{gatewayRunning:false}});await f.open();
  assert.equal(f.rows()[0][2],'下次使用');assert.equal(f.modelRows()[0].querySelector('.model-switch'),null);
  const unavailable=f.modelRows()[1];assert.equal(unavailable.querySelector('.model-switch').disabled,true);
  assert.match(unavailable.querySelector('.model-row-feedback').textContent,/凭据暂不可用/);
  await unavailable.querySelector('.model-switch').onclick();assert.equal(f.calls.filter(call=>call.switch).length,0);
});

test('current defaults have no restart action, including pending and stopped states', async () => {
  for (const gatewayRunning of [true,false]) {
    const f=fixture({current:{...savedConnections(),activation:{state:'pending'}},initial:{gatewayRunning}});
    await f.open();
    assert.equal(f.modelRows()[0].querySelector('.model-switch'),null);
    assert.doesNotMatch(f.$('modelList').textContent,/重启诺拉/);
    assert.equal(f.modelRows()[1].querySelector('.model-switch').textContent,'切换');
    assert.equal(f.calls.some(call=>call.action==='restart'||call.apply),false);
  }
});

test('returning from an addition restores the model list and scroll position without saving the draft', async () => {
  const f=fixture({current:savedConnections()});await f.open();f.$('modelList').scrollTop=27;
  await f.click('+ 添加模型');f.$('model').value='unsaved-draft';f.$('key').value='unsaved-fixture-key';
  await f.click('返回模型设置');
  assert.equal(f.context.view,'model-overview');assert.equal(f.context.copy[0],'模型设置');
  assert.equal(f.$('modelList').scrollTop,27);assert.equal(f.rows()[0][0],'same-model');assert.equal(f.$('key'),null);
  assert.equal(f.calls.filter(call=>call.save).length,0);
});

test('a damaged saved list keeps the real current default visible and locks mutation until the list can be read', async () => {
  const f=fixture({current:{configured:true,provider:'custom',model:'actual-current-model',selectedId:'current',models:[],
    modelsProblem:'已保存模型列表格式无效，原配置已保留。'}});await f.open();
  assert.equal(f.rows()[0][0],'actual-current-model');assert.equal(f.rows()[0][2],'当前默认');
  assert.match(f.$('modelListProblem').textContent,/列表格式无效/);assert.equal(f.$('modelListProblem').hidden,false);
  assert.equal(f.$('inline').querySelector('.model-add').disabled,true);
  assert.equal(f.context.modelSelectionUncertain,true);assert.equal(f.$('key'),null);
  await f.click('重新查询');assert.equal(f.calls.filter(call=>call==='read-model').length,2);
  assert.equal(f.$('inline').querySelector('.model-add').disabled,true);assert.equal(f.rows()[0][0],'actual-current-model');
});

test('real deletion requires inline confirmation, cancellation writes nothing, and default cannot be removed',async()=>{
 const f=fixture({current:savedConnections()});await f.open();
 assert.equal(f.modelRows()[0].querySelector('.model-delete').hidden,true);
 const other=f.modelRows()[1];await other.querySelector('.model-delete').onclick();
 assert.equal(other.querySelector('.model-delete-prompt').textContent,'删除这个模型？');
 assert.deepEqual(other.querySelectorAll('.model-delete-buttons button').map(item=>item.textContent),['取消','确认删除']);
 assert.equal(f.calls.some(call=>call.delete),false);
 await f.click('取消');assert.equal(other.querySelector('.model-delete-prompt'),null);
 assert.equal(f.modelRows().length,2);assert.equal(f.calls.some(call=>call.delete),false);
 await other.querySelector('.model-delete').onclick();await f.click('确认删除');
 assert.deepEqual(f.calls.filter(call=>call.delete),[{delete:'second'}]);
 assert.equal(f.modelRows().length,1);assert.equal(f.modelRows()[0].dataset.modelId,'first');
 assert.equal(f.calls.some(call=>call.switch||call.apply||call.save),false);
});

test('deletion remains pending until confirmed and a refusal keeps the row with retry',async()=>{
 let finish;const f=fixture({current:savedConnections(),deleteSaved:()=>new Promise(resolve=>{finish=resolve;})});
 await f.open();await f.modelRows()[1].querySelector('.model-delete').onclick();
 const confirm=f.$('inline').querySelectorAll('button').find(item=>item.textContent==='确认删除');
 const pending=confirm.onclick();await f.settle();
 assert.equal(f.modelRows().length,2);assert.equal(f.context.busy,true);
 assert.equal(f.modelRows()[1].querySelector('.model-delete').textContent,'删除中');
 assert.equal(f.$('inline').querySelector('.model-add').disabled,true);
 finish({ok:false,message:'回退仍在使用该模型。',failureStage:'candidate'});await pending;
 assert.equal(f.modelRows().length,2);assert.equal(f.context.modelSelectionUncertain,false);
 assert.match(f.modelRows()[1].querySelector('.model-row-feedback').textContent,/回退/);
 assert.ok(f.modelRows()[1].querySelector('.model-row-actions button'));
});

test('an unconfirmed deletion cannot hide the row or allow another mutation',async()=>{
 const f=fixture({current:savedConnections(),deleteSaved:async()=>({ok:true,current:savedConnections()})});
 await f.open();await f.modelRows()[1].querySelector('.model-delete').onclick();await f.click('确认删除');
 assert.equal(f.modelRows().length,2);assert.equal(f.context.modelSelectionUncertain,true);
 assert.equal(f.$('inline').querySelector('.model-add').disabled,true);
 assert.match(f.modelRows()[1].querySelector('.model-row-feedback').textContent,/删除结果尚未确认/);
 await f.click('重新查询');assert.equal(f.context.modelSelectionUncertain,false);
});
