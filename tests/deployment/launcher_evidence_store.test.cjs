const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');

const OPERATION_ID = '11111111-1111-4111-8111-111111111111';
function fixture(t, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nora-evidence-store-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const directory = path.join(root, 'installer');
  const { createEvidenceStore } = require('../installer/desktop/evidence-store');
  return { root, directory, store: createEvidenceStore({ directory, ...options }), createEvidenceStore };
}

test('freezing the program failure makes safe evidence readable after the store is recreated', t => {
  const f = fixture(t);
  const operation = f.store.begin({ operationId: OPERATION_ID, action: 'update', runId: 'ui-attempt' });
  const error = Object.assign(new Error('component write denied'), {
    code: 'EACCES', stack: 'Error: component write denied\n at apply (system-update.js:81:4)',
  });
  operation.freeze({ error, outcome: 'failed' });
  const saved = f.createEvidenceStore({ directory: f.directory }).read(OPERATION_ID);
  assert.equal(saved.operationId, OPERATION_ID);
  assert.equal(saved.primary.code, 'EACCES');
  assert.equal(saved.primary.message, 'component write denied');
  assert.ok(saved.primary.frames.some(frame => frame.includes('system-update.js:81:4')));
  assert.equal(saved.outcome, 'failed');
  assert.deepEqual(saved.missingReasons, []);
  assert.equal(operation.directory, path.join(f.directory, 'operations', OPERATION_ID, 'evidence'));
});

test('retained evidence capacity preserves existing primary facts and marks a new bounded capture as missing',t=>{
  const f=fixture(t),first=f.store.begin({operationId:OPERATION_ID});first.freeze({error:new Error('retained primary cause')});
  const target=first.directory,used=fs.readdirSync(target).reduce((total,name)=>total+fs.statSync(path.join(target,name)).size,0);
  const secondId='22222222-2222-4222-8222-222222222222';
  const store=f.createEvidenceStore({directory:f.directory,limits:{globalBytes:used+64,historyCapacity:2,ackCapacity:16}}),second=store.begin({operationId:secondId});
  const frozen=second.freeze({error:Object.assign(new Error('new installation cause'),{code:'EPERM'})});
  assert.equal(frozen.primary.code,'EPERM');assert.ok(frozen.missingReasons.includes('save_failed:CAPACITY'));
  assert.ok(store.read(secondId).missingReasons.includes('save_failed:CAPACITY'));
  assert.equal(fs.existsSync(path.join(second.directory,'metadata.json')),false);
  assert.equal(f.createEvidenceStore({directory:f.directory}).read(OPERATION_ID).primary.message,'retained primary cause');
});

test('delivery updates never create readonly or archived operation evidence',async t=>{
  const f=fixture(t),{createOperationController}=require('../installer/desktop/operation-state');
  assert.equal(f.store.updateDelivery(OPERATION_ID,{queued:0,accepted:2}),false);
  assert.equal(fs.existsSync(path.join(f.directory,'operations',OPERATION_ID)),false);
  const controller=createOperationController({directory:f.directory,evidence:f.store,
    lock:require('./launcher_operation_test_lock.cjs').createTestOperationLock(),executors:{install:async()=>({verification:'confirmed'})}});
  const record=await controller.start('install',{},'owned-evidence');
  assert.equal(f.store.updateDelivery(record.operationId,{operationId:record.operationId,queued:0,accepted:3,last_ack:1}),true);
  assert.equal(f.store.read(record.operationId).delivery.accepted,3);
  assert.equal(f.store.archive(record.operationId),true);
  assert.equal(f.store.updateDelivery(record.operationId,{queued:0,accepted:4}),false);
  assert.equal(fs.existsSync(path.join(f.directory,'operations',record.operationId,'evidence','metadata.json')),false);
});

test('acknowledged statistics cannot archive evidence while original operation logs still await ACK',async t=>{
  const f=fixture(t),{createOperationController}=require('../installer/desktop/operation-state');
  const controller=createOperationController({directory:f.directory,evidence:f.store,
    lock:require('./launcher_operation_test_lock.cjs').createTestOperationLock(),executors:{install:async()=>({verification:'confirmed'})}});
  const record=await controller.start('install',{},'pending-original-log');
  f.store.updateDelivery(record.operationId,{operationId:record.operationId,queued:0,accepted:3,last_ack:1});
  const file=path.join(f.directory,'operations',record.operationId,'telemetry.json.logs');
  const raw={schema:1,jobs:[{id:record.operationId,closed:true,done:false}]};
  fs.writeFileSync(file,JSON.stringify(raw));assert.equal(f.store.archive(record.operationId),false);
  raw.jobs[0].done=true;fs.writeFileSync(file,JSON.stringify(raw));assert.equal(f.store.archive(record.operationId),true);
});

test('reserved ACK space bounds retained data and delivery without replacing a primary',async t=>{
  const limits={globalBytes:4096,historyCapacity:2,ackCapacity:512},f=fixture(t,{limits});
  const {createOperationController}=require('../installer/desktop/operation-state');
  const controller=createOperationController({directory:f.directory,evidence:f.store,
    lock:require('./launcher_operation_test_lock.cjs').createTestOperationLock(),
    executors:{install:async()=>{throw new Error('frozen installation cause');}}});
  const first=await controller.start('install',{target:{version:'one'}},'reserved-one');
  const second=await controller.start('install',{target:{version:'two'}},'reserved-two');
  const targets=[first,second].map(operation=>path.join(f.directory,'operations',operation.operationId,'evidence'));
  const used=targets.reduce((sum,target)=>sum+fs.readdirSync(target).reduce((n,name)=>n+fs.statSync(path.join(target,name)).size,0),0);
  const dataBudget=limits.globalBytes-limits.historyCapacity*limits.ackCapacity;
  assert.ok(used<dataBudget);
  fs.writeFileSync(path.join(targets[0],'python.json'),' '.repeat(dataBudget-used));
  const primaryFile=path.join(targets[0],'metadata.json'),before=fs.readFileSync(primaryFile);
  const capture=f.createEvidenceStore({directory:f.directory,limits}).begin({operationId:first.operationId});
  const rejected=capture.freeze({secondaryErrors:[{operation:'restore',error:new Error('restore detail '.repeat(80))}]});
  assert.ok(rejected.missingReasons.includes('save_failed:CAPACITY'));
  assert.ok(fs.readFileSync(primaryFile).equals(before));
  for(const operation of [first,second])assert.equal(f.store.updateDelivery(operation.operationId,
    {operationId:operation.operationId,queued:0,accepted:3,last_ack:2}),true);
  const actual=targets.reduce((sum,target)=>sum+fs.readdirSync(target).filter(name=>['metadata.json','events.jsonl','python.json','delivery.json'].includes(name))
    .reduce((n,name)=>n+fs.statSync(path.join(target,name)).size,0),0);
  assert.ok(actual<=limits.globalBytes);
  assert.ok(fs.readFileSync(primaryFile).equals(before));
  const thirdId='33333333-3333-4333-8333-333333333333';
  const denied=f.store.begin({operationId:thirdId}).freeze({error:new Error('third cause')});
  assert.ok(denied.missingReasons.includes('save_failed:CAPACITY'));
  assert.equal(fs.existsSync(path.join(f.directory,'operations',thirdId)),false);
});

test('a late ACK owns only delivery.json and cannot rewrite a successor primary or context',async t=>{
  const f=fixture(t),{createOperationController}=require('../installer/desktop/operation-state');
  const controller=createOperationController({directory:f.directory,evidence:f.store,
    lock:require('./launcher_operation_test_lock.cjs').createTestOperationLock(),executors:{install:async()=>({verification:'confirmed'})}});
  const operation=await controller.start('install',{},'late-ack');
  const old=f.store.begin({operationId:operation.operationId,memoryOnly:true});
  old.freeze({error:new Error('old cached cause'),context:{stage:'old-stage'}});
  const successor=f.store.begin({operationId:operation.operationId});
  successor.freeze({error:Object.assign(new Error('successor cause'),{code:'EACCES'}),context:{stage:'successor-stage'}});
  const file=path.join(successor.directory,'metadata.json'),before=fs.readFileSync(file);
  assert.equal(f.store.updateDelivery(operation.operationId,{operationId:operation.operationId,queued:0,accepted:7,last_ack:2}),true);
  assert.ok(fs.readFileSync(file).equals(before));
  const saved=f.createEvidenceStore({directory:f.directory}).read(operation.operationId);
  assert.equal(saved.primary.message,'successor cause');assert.equal(saved.context.stage,'successor-stage');
  assert.equal(saved.delivery.accepted,7);
  assert.ok(fs.statSync(path.join(successor.directory,'delivery.json')).size<=4096);
  assert.equal(f.store.archive(operation.operationId),true);
  assert.equal(fs.existsSync(path.join(successor.directory,'delivery.json')),false);
});

test('memory-only projection never creates files until the owning guard commits it',t=>{
  const f=fixture(t),capture=f.store.begin({operationId:OPERATION_ID,memoryOnly:true});
  capture.observe({event:'progress',stage:'applying'});capture.freeze({error:new Error('in-memory original')});
  assert.equal(fs.existsSync(f.directory),false);
  f.store.commitSnapshot(capture.snapshot());
  assert.equal(f.createEvidenceStore({directory:f.directory}).read(OPERATION_ID).primary.message,'in-memory original');
});

test('rollback removal and later delivery updates cannot replace the frozen primary failure', t => {
  const f = fixture(t);
  const rollback = path.join(f.root, 'temporary-release');
  fs.mkdirSync(rollback);
  const operation = f.store.begin({ operationId: OPERATION_ID, action: 'update' });
  const primary = Object.assign(new Error('original component failure'), {
    code: 'EACCES', stack: `Error: original component failure\n at apply (${path.join(rollback, 'apply.js')}:42:3)`,
  });
  operation.freeze({ error: primary, outcome: 'failed', context: { stage: 'update_apply' } });
  fs.rmSync(rollback, { recursive: true, force: true });
  const rollbackError = Object.assign(new Error('rollback directory cleanup denied'), {
    code: 'EPERM', stack: 'Error: rollback denied\n at rollback (system-update.js:92:3)',
  });
  operation.finish({ outcome: 'failed', error: rollbackError,
    secondaryErrors: [{ operation: 'rollback', error: rollbackError }], delivery: { status: 'pending' } });
  const saved = f.store.read(OPERATION_ID);
  assert.equal(saved.primary.message, 'original component failure');
  assert.equal(saved.primary.code, 'EACCES');
  assert.ok(saved.primary.frames.some(frame => frame.includes('apply.js:42:3')));
  assert.equal(saved.secondary.length, 1);
  assert.equal(saved.secondary[0].operation, 'rollback');
  assert.equal(saved.secondary[0].error.code, 'EPERM');
  assert.equal(saved.delivery.status, 'pending');
  assert.equal(saved.context.stage, 'update_apply');
  assert.equal(primary.message, 'original component failure');
});

test('uncontrolled process output is omitted while bounded reviewed context still preserves the failure', t => {
  const f = fixture(t, { limits: { bytes: 4096, records: 3, messageBytes: 256, frames: 4, errorNodes: 4 } });
  const operation = f.store.begin({ operationId: OPERATION_ID, action: 'install' });
  for (let index = 0; index < 100; index++) {
    operation.observe({ event: 'log', stream: 'combined', line: 'UNREVIEWED_OUTPUT_PRIVATE ' + 'raw text '.repeat(10000) });
  }
  for (let index = 0; index < 100; index++) {
    operation.observe({ event: 'diagnostic', operation: 'subprocess-exit', pid: 551, exitCode: index, durationMs: 3 });
  }
  operation.freeze({ error: Object.assign(new Error('original installation error'), {
    code: 'EACCES', stack: 'Error: denied\n at install (bootstrap.js:41:2)',
  }), outcome: 'failed' });
  const saved = f.store.read(OPERATION_ID);
  assert.equal(saved.primary.message, 'original installation error');
  assert.equal(saved.events.length, 3);
  assert.equal(saved.truncated, true);
  assert.ok(saved.missingReasons.includes('unreviewed_output'));
  assert.doesNotMatch(JSON.stringify(saved), /UNREVIEWED_OUTPUT_PRIVATE|raw text/);
  const files = fs.readdirSync(operation.directory);
  assert.ok(files.includes('events.jsonl'));
  assert.ok(files.includes('metadata.json'));
  assert.ok(files.reduce((total, name) => total + fs.statSync(path.join(operation.directory, name)).size, 0) <= 4096);
});

test('private fields and conversation fragments are omitted after caller redaction', t => {
  const f = fixture(t, {
    clean: value => String(value).replaceAll('REGISTERED_KEY_FIXTURE', '[REDACTED]'),
    redact: value => String(value).replaceAll('PRIVATE_ACCOUNT_FIXTURE', '[ACCOUNT]'),
  });
  const operation = f.store.begin({ operationId: OPERATION_ID, action: 'install' });
  const error = Object.assign(new Error('write failed REGISTERED_KEY_FIXTURE PRIVATE_ACCOUNT_FIXTURE password="PRIVATE_PASSWORD_FIXTURE"'), {
    code: 'EACCES', stack: 'Error: private\n at install (/Users/private-account/bootstrap.js:41:2)',
    body: 'PRIVATE_RESPONSE_FIXTURE', apiKey: 'PRIVATE_KEY_FIELD_FIXTURE',
  });
  operation.observe({ event: 'diagnostic', component: 'bridge', error: {
    name: 'RuntimeError', message: '{"messages":[{"content":"PRIVATE_CONVERSATION_FIXTURE"}]}',
    code: 'EACCES', stack: 'File "bootstrap.py", line 42, in install',
  } });
  operation.freeze({ error, context: { stage: 'runtime_extract', apiKey: 'PRIVATE_CONTEXT_KEY_FIXTURE', body: 'PRIVATE_CONFIG_FIXTURE' } });
  const saved = f.store.read(OPERATION_ID);
  assert.equal(saved.primary.code, 'EACCES');
  assert.match(saved.primary.message, /\[REDACTED\]|\[ACCOUNT\]/);
  assert.ok(saved.missingReasons.includes('sensitive_fields_omitted'));
  assert.ok(saved.missingReasons.includes('sensitive_content_omitted'));
  assert.doesNotMatch(JSON.stringify(saved), /PRIVATE_|REGISTERED_KEY_FIXTURE|private-account/);
});

test('unavailable evidence storage returns missing status without replacing the program error', t => {
  const unavailable = Object.assign(new Error('fixture installation disk unavailable'), { code: 'ENOENT' });
  const f = fixture(t, { directory: () => { throw unavailable; } });
  const original = Object.assign(new Error('original program failure'), {
    code: 'EACCES', stack: 'Error: denied\n at install (bootstrap.js:41:2)',
  });
  let operation, saved;
  assert.doesNotThrow(() => { operation = f.store.begin({ operationId: OPERATION_ID, action: 'install' }); });
  assert.doesNotThrow(() => { saved = operation.freeze({ error: original, outcome: 'failed' }); });
  assert.equal(saved.primary.message, original.message);
  assert.equal(saved.primary.code, 'EACCES');
  assert.ok(saved.missingReasons.includes('save_failed:ENOENT'));
  assert.equal(original.code, 'EACCES');
  assert.equal(Object.hasOwn(original, 'secondaryErrors'), false);
  assert.equal(fs.existsSync(f.directory), false);
});

test('resuming the same operation preserves its frozen primary while updating delivery', t => {
  const f = fixture(t);
  f.store.begin({ operationId: OPERATION_ID, action: 'update' }).freeze({
    error: Object.assign(new Error('frozen original failure'), { code: 'EACCES' }), outcome: 'failed',
  });
  const resumed = f.createEvidenceStore({ directory: f.directory }).begin({ operationId: OPERATION_ID, action: 'update' });
  resumed.finish({ error: new Error('later delivery failure'), delivery: { status: 'failed' } });
  const saved = f.store.read(OPERATION_ID);
  assert.equal(saved.primary.message, 'frozen original failure');
  assert.equal(saved.primary.code, 'EACCES');
  assert.equal(saved.delivery.status, 'failed');
  assert.equal(saved.secondary[0].error.message, 'later delivery failure');
});

test('delivery summaries persist only bounded technical fields for the same operation', t => {
  const f = fixture(t);
  const operation = f.store.begin({ operationId: OPERATION_ID, action: 'update' });
  operation.freeze({ error: Object.assign(new Error('original update failure'), { code: 'EACCES' }), outcome: 'failed' });
  const summary = { schema: 1, operationId: OPERATION_ID, queued: 2, accepted: 4, rejected: 1,
    expired: 0, evicted: 0, paused: 0, detail_suppressed: 1, last_http: 401, last_ack: 1800000000000,
    last_error: 'http_4xx', missing: ['diagnostic_disabled', 'queue_save_failed'],
    body: 'PRIVATE_BODY_FIXTURE', arbitrary: 'PRIVATE_UNKNOWN_FIXTURE' };
  operation.finish({ delivery: summary });
  const saved = f.createEvidenceStore({ directory: f.directory }).read(OPERATION_ID);
  assert.deepEqual(saved.delivery, { schema: 1, operationId: OPERATION_ID, queued: 2, accepted: 4, rejected: 1,
    expired: 0, evicted: 0, paused: 0, detail_suppressed: 1, last_http: 401, last_ack: 1800000000000,
    last_error: 'http_4xx', missing: ['diagnostic_disabled', 'queue_save_failed'] });
  assert.equal(saved.outcome, 'failed');
  assert.equal(saved.primary.message, 'original update failure');
  assert.doesNotMatch(JSON.stringify(saved), /PRIVATE_/);
  operation.finish({ delivery: { ...summary, operationId: '22222222-2222-4222-8222-222222222222', accepted: 99 } });
  assert.deepEqual(f.store.read(OPERATION_ID).delivery, saved.delivery);
});

test('malformed delivery values cannot leak raw errors or inflate durable counters', t => {
  const f = fixture(t);
  const operation = f.store.begin({ operationId: OPERATION_ID, action: 'install' });
  operation.finish({ delivery: { schema: 1, operationId: OPERATION_ID, queued: -1, accepted: Infinity,
    last_http: 999, last_ack: -5, last_error: 'PRIVATE_TOKEN_FIXTURE', missing: ['PRIVATE_ACCOUNT_FIXTURE'],
    rejected: 3 } });
  const saved = f.store.read(OPERATION_ID);
  assert.equal(saved.delivery.rejected, 3);
  assert.equal(saved.delivery.queued, undefined);
  assert.equal(saved.delivery.accepted, undefined);
  assert.equal(saved.delivery.last_http, undefined);
  assert.equal(saved.delivery.last_ack, undefined);
  assert.equal(saved.delivery.last_error, undefined);
  assert.deepEqual(saved.delivery.missing, []);
  assert.doesNotMatch(JSON.stringify(saved), /PRIVATE_/);
});

test('reviewed child evidence supplies the actual primary instead of its generic exit wrapper', t => {
  const f = fixture(t);
  const { createFaultPackets } = require('../installer/desktop/fault-packet');
  const collector = createFaultPackets().collector(true, { output: false });
  collector.observe({ event: 'diagnostic', component: 'bridge', error: {
    name: 'PermissionError', message: 'actual Python permission failure', code: 'EACCES',
    stack: 'File "install.py", line 42, in install',
    cause: { name: 'TypeError', message: 'actual cause', stack: 'File "install.py", line 40, in check' },
    secondaryErrors: [{ error: { name: 'OSError', message: 'rollback failure', code: 'EPERM', stack: 'File "rollback.py", line 51, in restore' } }],
  } });
  const wrapper = collector.attach(new Error('generic JS exit wrapper'));
  wrapper.launcherEvidence.output = ['PRIVATE_UNREVIEWED_CHILD_STDOUT'];
  const operation = f.store.begin({ operationId: OPERATION_ID, action: 'install' });
  operation.freeze({ error: wrapper, outcome: 'failed' });
  const saved = f.store.read(OPERATION_ID);
  assert.equal(saved.primary.name, 'PermissionError');
  assert.equal(saved.primary.code, 'EACCES');
  assert.equal(saved.primary.message, 'actual Python permission failure');
  assert.equal(saved.primary.cause.name, 'TypeError');
  assert.ok(saved.primary.frames.some(frame => frame.includes('install.py')));
  assert.equal(saved.secondary[0].error.message, 'rollback failure');
  assert.ok(saved.secondary[0].error.frames.some(frame => frame.includes('rollback.py')));
  assert.doesNotMatch(JSON.stringify(saved), /generic JS exit wrapper|PRIVATE_UNREVIEWED_CHILD_STDOUT/);
});

test('reviewed native local evidence freezes facts and missing markers without uploading context or raw output',t=>{
  const f=fixture(t),{programError}=require('../installer/desktop/launcher-errors');
  const {createFaultPackets,validFaultPacket}=require('../installer/desktop/fault-packet');
  const packets=createFaultPackets(),collector=packets.collector(true,{output:false});
  const context={stage:'native_start',loopback:true,pid:987654321,exitCode:3221225477,port:54321};
  const diagnostic=programError({name:'NativeLifecycleError',message:'Native process exited',code:'TAVERN_PROCESS_EXITED',stack:'',
    context:{...context,config:'PRIVATE_NATIVE_CONFIG'},missingReasons:['launch_log_unavailable'],truncated:true,
    secondaryErrors:[{error:{name:'TypeError',message:'Cannot read properties of undefined (property omitted).',code:null,
      stack:'File "server.js", line 42, in node',context:{stage:'native_start',loopback:true},
      missingReasons:['program_message_unreviewed','non_project_frames_omitted','save_failed:ENOSPC']}}]});
  collector.observe({event:'diagnostic',component:'bridge',error:diagnostic});
  const wrapper=collector.attach(new Error('generic exit wrapper'));
  wrapper.launcherEvidence.output=['PRIVATE_NATIVE_RAW_OUTPUT'];
  const operation=f.store.begin({operationId:OPERATION_ID,action:'start'});
  operation.observe({event:'diagnostic',component:'bridge',error:diagnostic});
  operation.freeze({error:wrapper,outcome:'failed'});
  const saved=f.createEvidenceStore({directory:f.directory}).read(OPERATION_ID);
  assert.equal(saved.primary.name,'NativeLifecycleError');
  assert.equal(saved.primary.code,'TAVERN_PROCESS_EXITED');
  assert.equal(saved.primary.message,'Native process exited');
  assert.deepEqual(saved.primary.context,context);
  assert.deepEqual(saved.secondary[0].error.context,{stage:'native_start',loopback:true});
  assert.ok(saved.secondary[0].error.frames.some(frame=>frame.includes('server.js')));
  assert.deepEqual(saved.events[0].error.context,context);
  for(const reason of ['launch_log_unavailable','program_message_unreviewed','non_project_frames_omitted','save_failed:ENOSPC','unreviewed_output'])
    assert.ok(saved.missingReasons.includes(reason),reason);
  assert.equal(saved.truncated,true);
  assert.ok(saved.missingReasons.length<=16);
  assert.doesNotMatch(JSON.stringify(saved),/PRIVATE_NATIVE_|generic exit wrapper/);
  const packet=packets.packet(wrapper,{id:OPERATION_ID,action:'start'},
    {operation:{operationId:OPERATION_ID,snapshotSequence:1,target:{},effectState:'untouched',evidenceStatus:'saved-truncated'},evidence:saved});
  assert.ok(packet.evidence.missing_reasons.includes('unknown_evidence_gap'));
  assert.ok(packet.evidence.missing_reasons.includes('save_failed:ENOSPC'));
  assert.equal(packet.evidence.missing_reasons.filter(reason=>reason==='unknown_evidence_gap').length,1);
  assert.equal(validFaultPacket(packet),true);
  assert.equal(packet.errors[0].kind,'Error');
  assert.equal(packet.errors[0].code,'');
  assert.equal(packet.errors[0].message,'NativeLifecycleError: Native process exited');
  assert.match(packet.output.join('\n'),/exitCode=3221225477/);
  assert.match(packet.output.join('\n'),/launch_log_unavailable/);
  assert.doesNotMatch(JSON.stringify(packet),/987654321|54321|"context"|"pid"|"port"|PRIVATE_NATIVE_/);
});

test('the byte budget trims lower priority detail before the primary source location', t => {
  const f = fixture(t, { limits: { bytes: 4096 } });
  const operation = f.store.begin({ operationId: OPERATION_ID, action: 'repair' });
  const error = Object.assign(new Error('primary component failure'), {
    code: 'EACCES', stack: 'Error: denied\n at apply (primary.js:42:3)',
    cause: Object.assign(new Error('bounded cause context '.repeat(400)), {
      code: 'ENOSPC', stack: Array.from({ length: 24 }, (_, index) =>
        `at fixture (cause.js:${index + 1}:2) ${'bounded frame detail '.repeat(20)}`).join('\n'),
    }),
  });
  operation.freeze({ error, outcome: 'failed' });
  const saved = f.store.read(OPERATION_ID);
  assert.equal(saved.primary.message, 'primary component failure');
  assert.equal(saved.primary.code, 'EACCES');
  assert.ok(saved.primary.frames.some(frame => frame.includes('primary.js:42:3')));
  assert.equal(saved.primary.cause.code, 'ENOSPC');
  assert.equal(saved.truncated, true);
  assert.ok(fs.readdirSync(operation.directory).reduce((total, name) => total + fs.statSync(path.join(operation.directory, name)).size, 0) <= 4096);
});

test('later secondary failures share the operation error-node budget', t => {
  const f = fixture(t, { limits: { errorNodes: 4 } });
  const operation = f.store.begin({ operationId: OPERATION_ID, action: 'repair' });
  operation.freeze({ error: new Error('original failure') });
  for (let index = 0; index < 10; index++) {
    operation.finish({ secondaryErrors: [{ operation: 'rollback', error: new Error(`cleanup failure ${index}`) }] });
  }
  const saved = f.store.read(OPERATION_ID);
  assert.equal(saved.primary.message, 'original failure');
  assert.equal(saved.secondary.length, 3);
  assert.deepEqual(saved.secondary.map(item => item.error.message), ['cleanup failure 0', 'cleanup failure 1', 'cleanup failure 2']);
  assert.equal(saved.truncated, true);
});

test('operation evidence refuses an escaped directory while retaining the primary in memory', t => {
  const f = fixture(t);
  const outside = path.join(f.root, 'outside');
  fs.mkdirSync(outside);
  fs.mkdirSync(f.directory);
  fs.symlinkSync(outside, path.join(f.directory, 'operations'), 'dir');
  const operation = f.store.begin({ operationId: OPERATION_ID, action: 'install' });
  const saved = operation.freeze({ error: Object.assign(new Error('original installation error'), { code: 'EACCES' }) });
  assert.equal(saved.primary.code, 'EACCES');
  assert.ok(saved.missingReasons.includes('save_failed:EVIDENCE_PATH'));
  assert.deepEqual(fs.readdirSync(outside), []);
  assert.throws(() => f.store.begin({ operationId: '../escaped', action: 'install' }), /operation ID/);
});

test('later bounded metadata updates preserve the entire frozen primary projection', t => {
  const f = fixture(t, { limits: { bytes: 4096 } });
  const operation = f.store.begin({ operationId: OPERATION_ID, action: 'repair' });
  const error = Object.assign(new Error('original bounded technical failure '.repeat(100)), {
    code: 'EACCES', stack: Array.from({ length: 24 }, (_, index) =>
      `at apply (primary.js:${index + 1}:3) ${'bounded source location '.repeat(20)}`).join('\n'),
  });
  const frozen = operation.freeze({ error, outcome: 'failed' }).primary;
  operation.finish({ delivery: Object.fromEntries(['stage', 'action', 'component', 'source', 'site', 'operation', 'status', 'program']
    .map(key => [key, 'bounded delivery metadata '.repeat(20)])) });
  assert.deepEqual(operation.snapshot().primary, frozen);
  assert.deepEqual(f.store.read(OPERATION_ID).primary, frozen);
});

test('filesystem save errors retain the original failure and successful files use private permissions', t => {
  const f = fixture(t);
  fs.writeFileSync(f.directory, 'fixture blocked path');
  let nativeCode;
  assert.throws(() => fs.mkdirSync(path.join(f.directory, 'operations'), { recursive: true }), error => {
    nativeCode = error.code; return typeof nativeCode === 'string';
  });
  const operation = f.store.begin({ operationId: OPERATION_ID, action: 'install' });
  const saved = operation.freeze({ error: Object.assign(new Error('original program error'), { code: 'EACCES' }) });
  assert.equal(saved.primary.message, 'original program error');
  assert.ok(saved.missingReasons.includes(`save_failed:${nativeCode}`));
  fs.rmSync(f.directory);
  const retry = f.store.begin({ operationId: OPERATION_ID, action: 'install' });
  retry.freeze({ error: new Error('safe retry failure') });
  assert.ok(fs.statSync(retry.directory).isDirectory());
  if (process.platform !== 'win32') assert.equal(fs.statSync(retry.directory).mode & 0o777, 0o700);
  for (const name of ['metadata.json', 'events.jsonl']) {
    const stat = fs.statSync(path.join(retry.directory, name));
    assert.ok(stat.isFile());
    if (process.platform !== 'win32') assert.equal(stat.mode & 0o777, 0o600);
  }
  const snapshot = retry.snapshot();
  snapshot.primary.message = 'caller mutation';
  assert.equal(retry.snapshot().primary.message, 'original program error');
  assert.ok(retry.snapshot().secondary.some(item=>item.error.message==='safe retry failure'));
});

test('missing, invalid and oversized metadata have distinct availability status', t => {
  const f = fixture(t, { limits: { bytes: 4096 } });
  assert.deepEqual(f.store.read(OPERATION_ID).missingReasons, ['evidence_missing']);
  const operation = f.store.begin({ operationId: OPERATION_ID, action: 'install' });
  const metadata = path.join(operation.directory, 'metadata.json');
  fs.writeFileSync(metadata, '{broken JSON');
  assert.deepEqual(f.store.read(OPERATION_ID).missingReasons, ['evidence_invalid']);
  fs.writeFileSync(metadata, 'x'.repeat(4097));
  const saved = f.store.read(OPERATION_ID);
  assert.deepEqual(saved.missingReasons, ['evidence_read_limit']);
  assert.equal(saved.truncated, true);
});
