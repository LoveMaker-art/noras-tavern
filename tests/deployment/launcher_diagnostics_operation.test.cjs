const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { createDiagnostics } = require('../installer/desktop/diagnostics');
const vm=require('node:vm');
const {parse}=require('../installer/desktop/node_modules/acorn');

test('the actual update-check handler binds failure logs to the check, not the previous successful install',async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'nora-check-log-binding-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const diagnostics=createDiagnostics({primary:()=>path.join(root,'install.log')});
  const install=diagnostics.begin('install',{action:'install'});diagnostics.finish('succeeded');
  const {createTelemetry}=require('../installer/desktop/telemetry');
  const telemetry=createTelemetry({file:path.join(root,'telemetry.json'),enabled:false,automatic:false,
    logScope:(task,work)=>diagnostics.scope(task.id,{action:task.action},work)});
  t.after(()=>telemetry.close());
  const source=fs.readFileSync(path.join(__dirname,'../installer/desktop/main.js'),'utf8');
  let callback;const definitions=new Map();
  function visit(node){if(!node||typeof node!=='object')return;
    if(node.type==='FunctionDeclaration')definitions.set(node.id.name,node);
    if(node.type==='CallExpression'&&node.callee.name==='handle'&&node.arguments[0]?.value==='nora:check-update')callback=node.arguments[1];
    for(const value of Object.values(node))if(Array.isArray(value))value.forEach(visit);else visit(value);}
  visit(parse(source,{ecmaVersion:'latest'}));
  const original=Object.assign(new Error('published protocol mismatch'),{code:'VERIFICATION_FAILED',userCode:'RELEASE_EXECUTOR_INCOMPATIBLE'});
  const context=vm.createContext({activeRun:false,modelBusy:false,diagnostics,path,
    releaseCheckRequest:null,releaseMetadataState:null,noraHome:()=>root,
    describeError:require('../installer/desktop/launcher-errors').describeError,
    trackLauncher:(...args)=>telemetry.track(...args),releases:{check:async()=>({state:'blocked',compatibilityError:original.message,diagnosticError:original})},
    updateFetch:null,installRoot:()=>root,app:{getVersion:()=> '2.0.2'},CHANNEL:'stable',
    formatUserError:require('../installer/desktop/error-presentation').formatUserError});
  context.releases.createMetadataCache=require('../installer/desktop/releases').createMetadataCache;
  for(const name of ['releaseMetadataCache','checkRelease']){
    const node=definitions.get(name);assert.ok(node);vm.runInContext(source.slice(node.start,node.end),context);
  }
  const result=await vm.runInContext(`(${source.slice(callback.start,callback.end)})`,context)();
  assert.equal(result.failureCode,'verification_failed');
  assert.doesNotMatch(diagnostics.readOperation(install).records.map(r=>r.text).join('\n'),/protocol mismatch|release.check-failed/);
  assert.match(result.logOperationId,/^[a-f0-9-]{36}$/);assert.notEqual(result.logOperationId,install);
  const records=diagnostics.readOperation(result.logOperationId).records;
  assert.match(records.map(r=>r.text).join('\n'),/protocol mismatch|RELEASE_EXECUTOR_INCOMPATIBLE/);
  assert.equal(records.at(-1).outcome,'failed');
});

test('an actual admission block records and reports its own log rather than modifying the preceding successful run',t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'nora-admission-log-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const diagnostics=createDiagnostics({primary:()=>path.join(root,'install.log')});
  const prior=diagnostics.begin('start',{action:'start'});diagnostics.finish('succeeded');
  const id=require('node:crypto').randomUUID(),calls=[];
  const source=fs.readFileSync(path.join(__dirname,'../installer/desktop/main.js'),'utf8');
  const node=parse(source,{ecmaVersion:'latest'}).body.find(node=>node.id?.name==='finishOperationTelemetry');
  const context=vm.createContext({diagnostics,operationErrors:new Map(),launcherError:require('../installer/desktop/launcher-errors').launcherError,
    telemetry:{begin:(...args)=>calls.push(['begin',...args]),finish:(...args)=>calls.push(['finish',...args])}});
  vm.runInContext(`(${source.slice(node.start,node.end)})`,context)({operationId:id,kind:'start',state:'blocked',effectState:'untouched',
    primaryFailure:{code:'RETRY_CONDITIONS_UNCHANGED',guidance:{title:'连续失败，已暂停重试。'}}});
  assert.doesNotMatch(diagnostics.readOperation(prior).records.map(r=>r.text).join('\n'),/admission|RETRY_CONDITIONS/);
  const records=diagnostics.readOperation(id).records;assert.match(records.map(r=>r.text).join('\n'),/RETRY_CONDITIONS_UNCHANGED/);
  assert.equal(records.at(-1).outcome,'failed');assert.equal(calls[0][2].operationId,id);assert.equal(calls[1][1],'failed');
});

test('scope bookkeeping cannot replace a frozen or primitive primary failure',async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'nora-frozen-error-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const diagnostics=createDiagnostics({primary:()=>path.join(root,'install.log')});
  for(const original of [Object.freeze(new Error('frozen primary')),null]){
    const id=require('node:crypto').randomUUID();
    try{await diagnostics.scope(id,{action:'check_update'},async()=>{throw original;});assert.fail('scope must rethrow');}
    catch(error){assert.equal(error,original);}
    assert.equal(diagnostics.readOperation(id).records.at(-1).outcome,'failed');
  }
});

test('operation console reads native text and traceback across restart without mixing operations', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nora-console-read-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'install.log'), fallback = path.join(root, 'fallback.log');
  const id = '11111111-1111-4111-8111-111111111111';
  let diagnostics = createDiagnostics({ primary: () => file, fallback });
  diagnostics.begin('ui', { operationId: id, action: 'install', version: '2.0.2' });
  diagnostics.event({ event: 'log', line: '  at unpack (archive.js:42:3)', stream: 'stderr' });
  diagnostics.error('run.failed', Object.assign(new Error('ExtractError: invalid archive'), { stack: 'ExtractError: invalid archive\n  at unpack (archive.js:42:3)' }));
  diagnostics.finish('failed');
  diagnostics.begin('other', { action: 'repair' });
  diagnostics.event({ event: 'log', line: 'OTHER_OPERATION' });
  diagnostics = createDiagnostics({ primary: () => file, fallback });
  const first = diagnostics.readOperation(id);
  assert.match(first.records.map(r => r.text).join('\n'), /\[START\].*install/);
  assert.match(first.records.map(r => r.text).join('\n'), /\n  at unpack/);
  assert.ok(first.records.some(r => r.error));
  assert.equal((first.records.find(r=>r.text.includes('outcome=failed')).text.match(/durationMs=/g)||[]).length,1);
  assert.doesNotMatch(JSON.stringify(first), /OTHER_OPERATION/);
  assert.equal(first.hasMore, false);
  assert.deepEqual(diagnostics.readOperation(id, first.cursor).records, []);
  assert.throws(() => diagnostics.readOperation('../private'), /operation ID/);
  fs.renameSync(file, file + '.1');
  diagnostics.begin('same', { operationId: id, action: 'install' });
  diagnostics.event({ event: 'log', line: 'new output api_key=fixture-secret' });
  const next = diagnostics.readOperation(id, first.cursor);
  assert.match(next.records.map(r => r.text).join('\n'), /new output/);
  assert.doesNotMatch(JSON.stringify(next), /fixture-secret|invalid archive/);
});

test('operation console refuses symlinked logs instead of reading an arbitrary file', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nora-console-link-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const privateFile = path.join(root, 'private.txt'), file = path.join(root, 'install.log');
  fs.writeFileSync(privateFile, 'PRIVATE_DATA'); fs.symlinkSync(privateFile, file);
  const result = createDiagnostics({ primary: () => file }).readOperation('11111111-1111-4111-8111-111111111111');
  assert.deepEqual(result.records, []);
  assert.ok(result.missing.includes('log_path_rejected'));
});

test('real primary write failures retain chronological operation output across fallback, batches and restart',t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'nora-log-order-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const file=path.join(root,'install.log'),fallback=path.join(root,'fallback.log'),blocked=path.join(root,'blocked');
  fs.mkdirSync(blocked);let unavailable=false;
  let diagnostics=createDiagnostics({primary:()=>unavailable?blocked:file,fallback});
  const id=diagnostics.begin('ordered',{action:'update'});
  for(let index=0;index<900;index++){
    unavailable=index%3===1;diagnostics.event({event:'log',line:`entry ${index} ${'native output '.repeat(90)}`,uploadScope:'maintenance'});
  }
  unavailable=false;diagnostics.finish('failed');
  diagnostics=createDiagnostics({primary:()=>file,fallback});
  const entries=[];let cursor,result,reads=0;
  do{
    result=diagnostics.readOperation(id,cursor);cursor=result.cursor;reads++;
    entries.push(...result.records.filter(record=>/^entry /.test(record.text)).map(record=>Number(record.text.match(/^entry (\d+)/)[1])));
  }while(result.hasMore&&reads<30);
  assert.ok(reads>1);assert.equal(result.hasMore,false);assert.equal(entries.length,900);
  assert.ok(entries.every((value,index)=>value===index),`first out-of-order record: ${entries.findIndex((value,index)=>value!==index)}`);
  assert.deepEqual(diagnostics.readOperation(id,cursor).records,[]);
  diagnostics.begin('continuation',{operationId:id,action:'repair'});diagnostics.event({event:'log',line:'after restart'});
  assert.ok(diagnostics.readOperation(id,cursor).records.some(record=>record.text==='after restart'));
});

test('legacy simultaneous primary and fallback records disclose unknown order',t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'nora-legacy-order-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const file=path.join(root,'install.log'),fallback=path.join(root,'fallback.log'),id='11111111-1111-4111-8111-111111111111';
  for(const [target,line] of [[file,'primary'],[fallback,'fallback']])fs.writeFileSync(target,JSON.stringify({timestamp:'2026-10-04T00:00:00.000Z',operationId:id,event:'log',line})+'\n');
  const result=createDiagnostics({primary:()=>file,fallback}).readOperation(id);
  assert.equal(result.records.length,2);assert.ok(result.missing.includes('log_order_unknown'));
});

test('partial and oversized records preserve cursor boundaries and disclose missing output',t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'nora-log-boundaries-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const file=path.join(root,'install.log'),id='11111111-1111-4111-8111-111111111111',diagnostics=createDiagnostics({primary:()=>file});
  diagnostics.begin('boundaries',{operationId:id,action:'install'});
  fs.appendFileSync(file,'x'.repeat(300*1024)+'\n');
  const tail=JSON.stringify({timestamp:'2026-10-04T00:00:00.000Z',operationId:id,event:'log',line:'complete after append'});
  fs.appendFileSync(file,tail);
  const records=[],missing=new Set();let cursor,result,reads=0;
  do{result=diagnostics.readOperation(id,cursor);cursor=result.cursor;records.push(...result.records);result.missing.forEach(reason=>missing.add(reason));}while(result.hasMore&&++reads<10);
  assert.ok(missing.has('console_record_too_large'));assert.equal(result.pendingTail,true);
  assert.ok(!records.some(record=>record.text==='complete after append'));
  fs.appendFileSync(file,'\n');
  result=diagnostics.readOperation(id,cursor);
  assert.deepEqual(result.records.map(record=>record.text),['complete after append']);assert.equal(result.pendingTail,false);
});

test('an independent check keeps its log identity without stealing a running installation', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nora-log-scope-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file=path.join(root,'install.log'), diagnostics=createDiagnostics({primary:()=>file});
  const install=diagnostics.begin('install',{action:'install'}), check=require('node:crypto').randomUUID();
  await Promise.all([
    diagnostics.scope(check,{action:'check_update'},async()=>{await Promise.resolve();diagnostics.event({event:'log',line:'CHECK_OUTPUT'});}),
    Promise.resolve().then(()=>diagnostics.event({event:'log',line:'INSTALL_OUTPUT'}))
  ]);
  const records=fs.readFileSync(file,'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(records.find(r=>r.line==='CHECK_OUTPUT').operationId,check);
  assert.equal(records.find(r=>r.line==='INSTALL_OUTPUT').operationId,install);
  assert.equal(diagnostics.operationId,install);
});

test('diagnostics retain an operation identity without any telemetry client', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nora-diagnostics-operation-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'install.log');
  const diagnostics = createDiagnostics({ primary: () => file, fallback: path.join(root, 'fallback.log') });
  const first = diagnostics.begin('same-ui-run', { action: 'install' });
  assert.match(first, /^[a-f0-9-]{36}$/);
  assert.equal(diagnostics.operationId, first);
  diagnostics.error('run.failed', new Error('original installation failure'));
  diagnostics.finish('failed');
  const second = diagnostics.begin('same-ui-run', { action: 'repair' });
  assert.notEqual(second, first);
  diagnostics.finish('succeeded');
  const records = fs.readFileSync(file, 'utf8').trim().split('\n').map(JSON.parse);
  assert.ok(records.filter(record => record.event === 'run.failed' || record.event === 'run.end' && record.outcome === 'failed')
    .every(record => record.operationId === first));
  assert.ok(records.filter(record => record.event === 'run.start').every(record => record.runId === 'same-ui-run'));
});

test('diagnostics reuse the operation identity supplied by the operation journal', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nora-diagnostics-identity-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'install.log');
  const diagnostics = createDiagnostics({ primary: () => file, fallback: path.join(root, 'fallback.log') });
  const operationId = '11111111-1111-4111-8111-111111111111';
  assert.equal(diagnostics.begin('ui-attempt', { action: 'update', operationId }), operationId);
  assert.equal(diagnostics.operationId, operationId);
  diagnostics.write('process.exit', { exitCode: 7 });
  assert.ok(fs.readFileSync(file, 'utf8').trim().split('\n').map(JSON.parse).every(record => record.operationId === operationId));
});
