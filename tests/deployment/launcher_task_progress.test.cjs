const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

function fixture() {
  const source = fs.readFileSync(process.env.NORA_CONTROLLER_SOURCE || path.join(__dirname, '../installer/launcher-controller.js'), 'utf8');
  let time = 1000;
  const nodes = new Map();
  const node = id => {
    if (!nodes.has(id)) nodes.set(id, {textContent:'', hidden:false, style:{}, children:[], append(child) {this.children.push(child);}});
    return nodes.get(id);
  };
  const classes = new Set();
  const meter = {classList:{add:name=>classes.add(name), toggle:(name,on)=>on ? classes.add(name) : classes.delete(name)}};
  const context = vm.createContext({
    Date:{now:()=>time}, $:node, document:{querySelector:()=>meter},
    api:{cancel:async()=>({ok:true})}, hasLogs:()=>false,
    controls(){const cancel=node('taskActions').children.find(n=>n.id==='taskCancel');if(cancel)cancel.disabled=context.snapshot.canCancel!==true||context.operationCancelled;},
    syncState(value){Object.assign(context.snapshot,value);},setupStage:()=>{},say:()=>{},clearInline:()=>{},
    button:(_label,onclick)=>({onclick}), setInterval:()=>1, clearInterval:()=>{}, displaySteps:()=>{}, textError:error=>error.message,
    snapshot:{canCancel:true},activeService:'all',stage:0, view:'', currentTask:'', startedAt:0, lastEvent:0, taskTimer:null,
    taskStage:'', stageStartedAt:0, taskProgress:null, lastProgressAt:0, milestoneStates:[], operationCancelled:false,
  });
  vm.runInContext(source.slice(source.indexOf('  function taskView('), source.indexOf('  function fail(')), context);
  context.taskView('install');
  return {context, node, classes, advance(ms) {time += ms; context.updateTask();},
    event(message) {context.onEvent(message);}, note:()=>node('jobNote').textContent};
}

test('download reports actual bytes and resource percentage with one elapsed-time line', () => {
  const f = fixture(); f.advance(5000);
  f.event({event:'task',stage_id:'download',task:'下载酒馆组件'});
  f.event({event:'progress',current:1024 ** 2,total:4 * 1024 ** 2}); f.advance(3000);
  assert.equal(f.node('jobTitle').textContent,'下载酒馆组件');
  assert.equal(f.node('jobPercent').textContent,'25%');
  assert.equal(f.node('meterFill').style.width,'25%');
  assert.match(f.note(),/已下载 1\.0 MB \/ 4\.0 MB/);
  assert.match(f.note(),/已用时 8 秒/); assert.doesNotMatch(f.note(),/本阶段|总用时/);
});

test('three minutes without download bytes shows network guidance despite heartbeats, logs and repeated zero progress', () => {
  const f = fixture(); f.event({event:'task',stage_id:'download',task:'下载组件'});
  f.event({event:'progress',current:0,total:100}); f.advance(120000);
  assert.doesNotMatch(f.note(),/代理/); f.advance(59000);
  assert.doesNotMatch(f.note(),/代理/);
  f.event({event:'heartbeat'}); f.event({event:'log',line:'background alive'});
  f.event({event:'progress',current:0,total:100}); f.advance(1000);
  assert.match(f.note(),/连续 3 分钟无进展/);
  assert.match(f.note(),/网络或代理/);
  assert.equal(f.note().split("\n").length,2);
});

test('waiting for download response headers also triggers guidance, and real progress clears it immediately', () => {
  const f = fixture(); f.event({event:'task',stage_id:'download',task:'下载组件'}); f.advance(180000);
  assert.match(f.note(),/代理/);
  f.event({event:'progress',current:1,total:100});
  assert.doesNotMatch(f.note(),/代理/);
  f.advance(180000); assert.match(f.note(),/代理/);
  f.event({event:'progress',current:100,total:100});
  f.advance(180000); assert.doesNotMatch(f.note(),/代理/);
});

test('a slow download that keeps receiving data never warns solely because the total wait is long', () => {
  const f = fixture(); f.event({event:'task',stage_id:'download',task:'下载组件'});
  f.event({event:'progress',current:0,total:10000});
  for (let i = 1; i <= 20; i++) {
    f.advance(60000); assert.doesNotMatch(f.note(),/代理/);
    f.event({event:'progress',current:i,total:10000});
  }
  assert.match(f.note(),/已用时 1200 秒/);
});

test('local extraction and verification never give proxy advice or invent a percentage', () => {
  const f = fixture(); f.event({event:'task',stage_id:'download',task:'下载组件'});
  f.event({event:'progress',current:10,total:100}); f.advance(180000);
  assert.match(f.note(),/代理/);
  for (const stage_id of ['verify','runtime_extract','runtime_init','install_components','install_verify']) {
    f.event({event:'task',stage_id,task:stage_id}); f.advance(180000);
    assert.doesNotMatch(f.note(),/代理|已下载/);
    assert.match(f.note(),/正在等待处理结果/);
    assert.equal(f.node('jobPercent').textContent,'');
    assert.ok(f.classes.has('indeterminate'));
  }
});

test('the next component and a retry reset the waiting episode; unknown download sizes stay indeterminate', () => {
  const f = fixture(); f.event({event:'task',stage_id:'download',task:'下载组件一'});
  f.event({event:'progress',current:1,total:0}); f.advance(180000);
  assert.match(f.note(),/代理/); assert.equal(f.node('jobPercent').textContent,'');
  f.event({event:'task',stage_id:'verify',task:'准备下一组件'});
  f.event({event:'task',stage_id:'download',task:'下载组件二'});
  assert.doesNotMatch(f.note(),/代理|已下载/);
  f.advance(180000); assert.match(f.note(),/代理/);
  f.context.taskView('install'); f.event({event:'task',stage_id:'download',task:'下载组件二'});
  assert.doesNotMatch(f.note(),/代理/);
});

test('accepted cancellation retains the original handler and replaces download advice with a pending result', async () => {
  const f = fixture(); f.event({event:'task',stage_id:'download',task:'下载组件'}); f.advance(180000);
  f.event({event:'progress',current:40,total:100});assert.equal(f.node('jobPercent').textContent,'40%');
  const cancel = f.node('taskActions').children[0];
  await cancel.onclick(); f.advance(180000);
  f.event({event:'task',stage_id:'download',task:'late download task'});
  f.event({event:'progress',current:10,total:100});
  assert.equal(f.node('jobTitle').textContent,'正在取消，请等待任务结束');
  assert.doesNotMatch(f.note(),/代理/);
  assert.equal(cancel.disabled,true);
  assert.equal(f.node('jobPercent').textContent,'');assert.ok(f.classes.has('indeterminate'));
});

test('an unknown download size cannot show a percentage supplied without byte evidence',()=>{
  const f=fixture();f.event({event:'task',stage_id:'download',task:'下载组件'});
  f.event({event:'progress',current:1024,total:0,ratio:.75});
  assert.equal(f.node('jobPercent').textContent,'');assert.ok(f.classes.has('indeterminate'));
  assert.match(f.note(),/已下载 1\.0 KB/);
});

test('backend cancellation refusal keeps the operation active and pauses cancellation until the backend allows it', async () => {
  const f = fixture(); f.event({event:'task',stage_id:'runtime_extract',task:'释放 Nora 核心'});
  f.context.api.cancel = async () => ({ok:false,warning:'正在处理受管文件，请等待'});
  const cancel = f.node('taskActions').children[0]; await cancel.onclick();
  assert.equal(f.context.operationCancelled,false);
  assert.equal(cancel.disabled,true);
  assert.match(f.note(),/正在处理受管文件/);
  f.event({event:'task',stage_id:'runtime_verify',task:'检查 Nora'});
  assert.equal(f.node('jobTitle').textContent,'检查 Nora');
  assert.doesNotMatch(f.note(),/代理/);
  assert.equal(cancel.disabled,true);
  f.event({event:'task',stage_id:'download',task:'下载组件',canCancel:true});
  assert.equal(cancel.disabled,false,'only a new backend cancellation fact can enable the button');
});

 test('wording and heartbeat changes within the same download stage do not reset stalled byte timing',()=>{
  const f=fixture();f.event({event:'task',stage_id:'download',task:'下载组件'});f.event({event:'progress',stage_id:'download',current:1,total:100});
  f.advance(170000);f.event({event:'task',stage_id:'download',task:'仍在等待下载响应'});f.event({event:'heartbeat'});f.advance(10000);
  assert.match(f.note(),/连续 3 分钟/);assert.match(f.note(),/已用时 180 秒/);
});
test('explicit verify progress exits the download episode even without a task event',()=>{
  const f=fixture();f.event({event:'task',stage_id:'download',task:'下载组件'});f.event({event:'progress',current:1,total:100});f.advance(180000);
  f.event({event:'progress',stage_id:'verify',current:1,total:100});f.advance(180000);assert.doesNotMatch(f.note(),/代理|已下载/);
});

test('an untyped task cannot inherit an earlier download and produce a network diagnosis',()=>{
  const f=fixture();f.event({event:'task',stage_id:'download',task:'下载组件'});f.event({event:'progress',current:1,total:100});
  f.event({event:'task',task:'准备本地文件'});f.advance(180000);assert.doesNotMatch(f.note(),/代理|已下载/);
});
