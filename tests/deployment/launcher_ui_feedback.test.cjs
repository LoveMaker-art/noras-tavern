const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const {parse} = require('../installer/desktop/node_modules/acorn');
const source = fs.readFileSync(path.join(__dirname,'../installer/launcher-controller.js'),'utf8');
const statements = parse(source,{ecmaVersion:'latest'}).body[0].expression.callee.body.body;
function definition(name) {
  const node = statements.find(n=>n.id?.name === name || n.expression?.left?.name === name || n.declarations?.some(d=>d.id.name===name));
  return node ? source.slice(node.start,node.end) : '';
}
function fixture(overrides = {}) {
  const elements = new Map();
  function descendants(node) {
    return [node,...(node.children || []).flatMap(descendants)];
  }
  function element() {
    const children = [], queries = new Map();
    return {children,dataset:{},hidden:false,disabled:false,textContent:'',
      classList:{add(){},remove(){},toggle(){}},setAttribute(){},
      append(...items){children.push(...items);},prepend(...items){children.unshift(...items);},
      querySelectorAll(selector){assert.equal(selector,'[data-retry-at]');return children.flatMap(descendants).filter(node=>node.dataset?.retryAt);},
      querySelector(selector){if(!queries.has(selector))queries.set(selector,element());return queries.get(selector);}};
  }
  const $ = id => {
    if(['logFeedback','launcherDownloadFeedback'].includes(id)) return elements.has('inline') ? descendants(elements.get('inline')).find(n=>n.id===id) || null : null;
    if(!elements.has(id))elements.set(id,element());return elements.get(id);
  };
  const context = vm.createContext({snapshot:{},busy:false,daily:true,running:false,stage:0,view:'daily',
    refreshing:false,statusUnknown:false,launcherRecoveryConfirmed:false,lastStatusError:'',lastStatusAt:0,versionInfo:null,alive:true,pollTimer:null,activeAction:'',activeService:'all',lastFailure:null,operationCancelled:false,
    firstCompletionPending:false,sawIncompleteSetup:false,launchHint:element(),api:{},
    document:{createElement:element,querySelectorAll:selector=> {
      if (selector==='#management [data-action]') return [];
      const all = descendants($('inline'));
      return [...all.filter(n=>n.className==='icon-action'),$('stopAll')];
    }},$,
    clearInline:()=>{$('inline').children.length=0;},hideMenu(){},setupStage(){},say:(...args)=>{context.copy=args;},
    renderConversationEntry(){},showVersionNotice(){},
    button:(text,onclick)=>Object.assign(element(),{textContent:text,onclick}),
    clearTimeout(){},clearInterval(){},setTimeout:()=>1,checkVersionsInBackground(){},...overrides});
  vm.runInContext(['textError','errorCopy','operationFailure','currentOperation','allowedActions','noraUpdateGuidance','recheckFailure','refreshFailure','recoveryReason','hasLogs','appendActions','checkedTime','unknownStatusCopy','operationFact','retryLabel','complete','canReturnHome','serviceRunning','allRunning','syncState','readStatus',
    'controls','renderServices','dailyHome','openLogs','openLauncherDownload','recoveredOperation','route','poll'].map(definition).join('\n'),context);
  return {context,$,descendants};
}
test('an incompatible package offers its replacement page and preserves the failure when that page cannot open',async()=>{
  for(const rejects of [false,true]){
    const opened=[],{context,$,descendants}=fixture({api:{openExternal:async url=>{
      opened.push(url);if(rejects)throw new Error('raw browser launch failure');return {ok:true};
    },openLogs:async()=>({ok:true})}});
    context.problem={userCode:'RELEASE_EXECUTOR_INCOMPATIBLE',allowedActions:['replace-launcher','logs'],
      guidance:{title:'安装包与当前启动器不兼容。',detail:'原安装和数据未修改。',next:'请下载新版完整安装包，保留原数据目录。'}};
    vm.runInContext(definition('fail'),context);
    vm.runInContext("fail(problem, 'install')",context);
    const controls=descendants($('inline'));
    assert.equal(controls.some(node=>node.textContent==='重试'),false);
    const replacement=controls.find(node=>node.textContent==='下载新版完整启动器');
    assert.ok(replacement,'the replacement action must have a visible button');
    const title=context.copy[0];
    await replacement.onclick({currentTarget:replacement});
    assert.deepEqual(opened,['https://github.com/LoveMaker-art/noras-tavern/releases/latest']);
    assert.equal(context.copy[0],title);assert.equal(context.view,'error');assert.equal(replacement.disabled,false);
    const feedback=$('launcherDownloadFeedback');assert.ok(feedback);
    assert.match(feedback.textContent,rejects?/未能打开/:/已.*打开/);
    assert.doesNotMatch(feedback.textContent,/raw browser/);
  }
});

test('the recovery log button displays returned failure and rejection without leaving recovery', async () => {
  for(const mode of ['missing','rejected','success']) {
    const {context,$,descendants}=fixture({snapshot:{updateRecovery:{backup:'/fixture/backup'}},api:{openLogs:async()=>{
      if(mode==='rejected')throw new Error('Error: raw OS fixture');
      return mode==='missing'?{ok:false,warning:'日志文件还不存在。'}:{ok:true};
    }}});
    vm.runInContext('route()',context);
    const action=descendants($('inline')).find(n=>n.textContent==='查看日志');
    const heading=context.copy[0];
    await action.onclick({currentTarget:action});
    assert.equal(context.view,'recovery');assert.equal(context.copy[0],heading);
    const feedback=$('logFeedback');assert.ok(feedback,'opening logs must give visible feedback');
    if(mode==='missing')assert.match(feedback.textContent,/日志文件还不存在/);
    if(mode==='rejected') {assert.match(feedback.textContent,/未能打开|无法打开/);assert.doesNotMatch(feedback.textContent,/raw OS/);}
    if(mode==='success')assert.match(feedback.textContent,/已.*打开/);
    assert.equal(action.disabled,false);
  }
});

test('failed daily polling marks service status unknown and restores it after the next successful query', async () => {
  const ready={installed:true,hermesInstalled:true,setupCompleted:true,systemReady:true,
    running:true,gatewayRunning:true,clawchatConnected:true,clawchatPaired:false};
  for(const mode of ['rejection','fallback']) {
    let failed=true;
    const {context,$}=fixture({snapshot:{...ready},api:{status:async()=>{
      if(!failed)return {...ready};
      if(mode==='rejection')throw new Error('raw IPC fixture');
      return {statusUnavailable:true,warning:'后台状态查询未完成。',running:false,systemReady:false};
    }}});
    await vm.runInContext('poll()',context);
    assert.equal(context.statusUnknown,true);
    assert.match(context.copy[0],/状态.*无法确认/);
    assert.equal(context.snapshot.running,true,'a failed query cannot overwrite the last known facts');
    assert.equal(context.snapshot.systemReady,true);
    const rows=$('inline').children.find(n=>n.className==='services').children;
    assert.deepEqual(rows.map(row=>row.dataset.state),['unknown','unknown']);
    rows.forEach(row=>assert.match(row.querySelector('.service-state').textContent,/未知/));
    rows.forEach(row=>row.children.forEach(child=>{if(child.className==='icon-action')assert.equal(child.disabled,true);}));
    assert.equal($('launch').disabled,true);
    failed=false;await vm.runInContext('poll()',context);
    assert.equal(context.statusUnknown,false);
    assert.equal($('launch').disabled,false);
    assert.equal(context.copy[0],'欢迎回来，坐一会儿吧。');
    assert.equal($('inline').children.find(n=>n.className==='services').children[0].dataset.state,'running');
    $('inline').children.find(n=>n.className==='services').children.forEach(row=>row.children.forEach(child=>{
      if(child.className==='icon-action')assert.equal(child.disabled,false);
    }));
  }
});

test('polling failure and recovery do not clear a model form or issue service operations', async () => {
  for(const setupCompleted of [true,false]) {
  const marker={textContent:'unsaved model fixture'};
  let failed=true;
  const {context,$}=fixture({view:'model',snapshot:{setupCompleted,systemReady:true},api:{status:async()=>{
    if(failed)throw new Error('fixture connection lost');return {setupCompleted,systemReady:true};
  }}});
  $('status').textContent='需要你参与';
  $('inline').append(marker);
  await vm.runInContext('poll()',context);
  assert.equal(context.view,'model');assert.equal($('inline').children[0],marker);
  assert.equal($('status').hidden,false);assert.match($('status').textContent,/无法确认/);
  failed=false;await vm.runInContext('poll()',context);
  assert.equal(context.view,'model');assert.equal($('inline').children[0],marker);
  assert.equal($('status').hidden,setupCompleted);
  assert.equal($('status').textContent,'需要你参与');
  }
});

test('unknown state cannot trigger an automatic service start or bundled update from old facts', () => {
  for(const bundledUpgradeTarget of [null,'v9.0.0']) {
    const calls=[], {context}=fixture({statusUnknown:true,snapshot:{installed:true,hermesInstalled:true,
      systemReady:true,running:false,bundledUpgradeTarget},fail:()=>calls.push('status-feedback'),run:()=>calls.push('service-operation')});
    vm.runInContext('route()',context);
    assert.deepEqual(calls,['status-feedback']);
  }
});

const mainSource = fs.readFileSync(path.join(__dirname,'../installer/desktop/main.js'),'utf8');
function mainHandler(channel, values) {
  let callback;
  function visit(node) {
    if(!node || typeof node!=='object')return;
    if(node.type==='CallExpression' && node.callee.name==='handle' && node.arguments[0]?.value===channel)callback=node.arguments[1];
    for(const value of Object.values(node))if(Array.isArray(value))value.forEach(visit);else if(value && typeof value==='object')visit(value);
  }
  const ast = parse(mainSource,{ecmaVersion:'latest'}); visit(ast);
  const cancellation = ast.body.find(n=>n.id?.name==='taskCancellation');
  return vm.runInNewContext(`${mainSource.slice(cancellation.start,cancellation.end)}\n(${mainSource.slice(callback.start,callback.end)})`,
    {updatingSystem:false,cancelled:false,releaseAbort:null,activeProcess:null,activeOperationContext:null,...values});
}

test('main status failures return unavailable instead of invented stopped or broken-installation facts', async () => {
  for(const mode of ['bridge-failed','missing-python','empty-install','healthy']) {
    const failures=[], original=new Error('raw status fixture');
    const status=mainHandler('nora:status',{
      quitting:false,uninstalling:false,selectingLocation:false,modelBusy:false,activeRun:false,statusRequest:null,readLauncherRecovery:async()=>null,
      lastStatusError:'',activeOperationContext:null,systemUpdate:{pending:()=>false,inspect:()=>null},operations:()=>({snapshot:async()=>null}),noraHome:()=>'/fixture',
      readInstallerState:()=>({phase:'ready'}),findPython:()=>!['missing-python','empty-install'].includes(mode),
      nodeStatus:()=>({installed:mode!=='empty-install',running:false,systemReady:false}),
      runBridge:async()=>{if(mode==='bridge-failed')throw original;return {installed:true,running:true,systemReady:true};},
      statusErrorMessage:error=>{failures.push(error);return '状态查询未完成。';},
      LOCAL_TEST:true,telemetry:null,locationStatus:()=>({}),
    });
    const result=await status();
    if(['bridge-failed','missing-python'].includes(mode)) {
      assert.equal(result.statusUnavailable,true);
      assert.equal(result.running,undefined);assert.equal(result.systemReady,undefined);
      assert.equal(failures.length,1);
      if(mode==='bridge-failed')assert.equal(failures[0],original);
    } else {
      assert.equal(result.statusUnavailable,undefined);
      assert.equal(result.installed,mode==='healthy');
      assert.equal(failures.length,0);
    }
  }
});

test('system log-open failure preserves raw evidence and produces guidance without the OS dump', async () => {
  const {launcherError}=require('../installer/desktop/launcher-errors');
  const {formatUserError}=require('../installer/desktop/error-presentation');
  for(const mode of ['result','rejection']) {
  const original = new Error('private raw OS fixture');
  const open=mainHandler('nora:open-logs',{fs:{existsSync:()=>true},path,
    diagnostics:{lastFile:'/fixture/install.log',error(){}},readLauncherRecovery:async()=>null,installerDirectory:()=>'/fixture',
    installRoot:()=>'/fixture',shell:{openPath:async()=> {if(mode==='rejection')throw original;return original.message;}},launcherError});
  await assert.rejects(open(),error=>{
    assert.equal(error.userCode,'LOG_OPEN_FAILED');
    assert.equal(error.cause.message,'private raw OS fixture');
    if(mode==='rejection')assert.equal(error.cause,original);
    const copy=formatUserError(error);assert.match(copy,/无法打开日志/);assert.match(copy,/重新打开启动器/);assert.doesNotMatch(copy,/打开安装目录/);
    assert.doesNotMatch(copy,/private raw/);return true;
  });
  }
});


function diagnosticChoice(api) {
  const node=statements.find(n=>n.type==='IfStatement' && source.slice(n.test.start,n.test.end)==='api.telemetry');
  const elements=new Map();
  const $=id=>{if(!elements.has(id))elements.set(id,{checked:false,disabled:true,hidden:true,textContent:'',setAttribute(){}});return elements.get(id);};
  $('telemetryExplanation').textContent='仅上报脱敏程序错误，不收集聊天内容、模型回复或密钥。';
  vm.runInNewContext(source.slice(node.start,node.end),{api,$});
  return $;
}
const tick=()=>new Promise(resolve=>setImmediate(resolve));
test('diagnostic choice reflects persisted values and keeps its notice through failure and recovery',async()=>{
  let enabled=true,fail=false,resolve;
  const $=diagnosticChoice({telemetry:async value=>{
    if(value===undefined)return {available:true,enabled};
    if(fail)throw Error('failed');
    await new Promise(r=>{resolve=r;});enabled=value;return {available:true,enabled};
  }});
  await tick();assert.equal($('telemetryEnabled').checked,true);assert.equal($('telemetryEnabled').disabled,false);
  const notice=$('telemetryExplanation').textContent;
  fail=true;$('telemetryEnabled').checked=false;await $('telemetryEnabled').onchange();
  assert.equal($('telemetryEnabled').checked,true);assert.equal($('telemetryExplanation').textContent,notice);
  assert.match($('telemetryFeedback').textContent,/未保存/);
  fail=false;$('telemetryEnabled').checked=false;const save=$('telemetryEnabled').onchange();
  assert.equal($('telemetryEnabled').disabled,true);assert.match($('telemetryFeedback').textContent,/保存/);
  resolve();await save;assert.equal($('telemetryEnabled').disabled,false);assert.equal($('telemetryEnabled').checked,false);
  assert.doesNotMatch($('telemetryFeedback').textContent,/未保存/);assert.equal($('telemetryExplanation').textContent,notice);
});
test('a failed diagnostic save cannot masquerade as successful opt out',async()=>{
  const $=diagnosticChoice({telemetry:async value=>value===undefined?{available:true,enabled:true}:undefined});
  await tick();$('telemetryEnabled').checked=false;await $('telemetryEnabled').onchange();
  assert.equal($('telemetryEnabled').checked,true);assert.match($('telemetryFeedback').textContent,/未保存/);
});
