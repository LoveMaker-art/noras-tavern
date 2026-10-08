const assert = require('node:assert/strict');
const { test } = require('node:test');
const { createFaultPackets, validFaultPacket } = require('../installer/desktop/fault-packet');
const { createEvidenceStore } = require('../installer/desktop/evidence-store');
const { consumeLines } = require('../installer/desktop/process-output');

test('real installer stderr survives durable freeze and restart into the schema 2 packet', async t => {
  const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
  const id = require('node:crypto').randomUUID();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nora-evidence-chain-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const packets = createFaultPackets();
  const collector = packets.collector(true, { output: true, components: ['installer'] });
  const child = require('node:child_process').spawn(process.execPath, ['-e',
    'process.stderr.write("ExtractError: invalid archive header\\n  at unpack (archive.js:42:3)\\napi_key=fixture-private-key\\n");process.exitCode=7']);
  consumeLines(child.stderr, line => collector.observe({ event: 'log', stream: 'stderr', line }));
  const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
  const error = collector.attach(Object.assign(new Error('command failed'), { exitCode: code, signal: null }));
  createEvidenceStore({ directory: root }).begin({ operationId: id, action: 'install' }).freeze({ error, outcome: 'failed' });
  const stored = createEvidenceStore({ directory: root }).read(id);
  const packet = packets.packet(error, { id, action: 'install' }, { evidence: stored,
    operation: { operationId: id, stageId: 'applying', evidenceStatus: 'saved', effectState: 'untouched' } });
  assert.match(packet.output.join('\n'), /ExtractError: invalid archive header/);
  assert.match(packet.output.join('\n'), /archive.js:42:3/);
  assert.match(packet.output.join('\n'), /exitCode=7/);
  assert.doesNotMatch(JSON.stringify(packet), /fixture-private-key/);
  assert.equal(validFaultPacket(packet), true);
});

test('collector reports message and frame clipping in the final fault packet', () => {
  const packets = createFaultPackets();
  const collector = packets.collector(true, { output: false });
  collector.observe({ event: 'diagnostic', component: 'bridge', error: {
    name: 'Error', message: 'safe detail '.repeat(175),
    stack: Array.from({ length: 20 }, (_, index) => `File "fixture.py", line ${index + 1}, in fixture`).join('\n'),
  } });
  const packet = packets.packet(collector.attach(new Error('outer fixture')), { action: 'start' });
  assert.equal(Buffer.byteLength(packet.errors[0].message), 1200);
  assert.equal(packet.errors[0].frames.length, 12);
  assert.equal(packet.truncated, true);
  assert.equal(validFaultPacket(packet), true);
});

test('four complete error nodes do not claim that evidence was discarded', () => {
  const error = new Error('primary');
  error.cause = new Error('first cause');
  error.cause.cause = new Error('second cause');
  error.cause.cause.cause = new Error('third cause');
  const packet = createFaultPackets().packet(error, { action: 'start' });
  assert.equal(packet.errors.length, 4);
  assert.equal(packet.truncated, false);
  assert.equal(validFaultPacket(packet), true);
});

test('a single shortened installer output line marks the packet as incomplete', () => {
  const packets = createFaultPackets();
  const collector = packets.collector(true);
  collector.observe({ event: 'log', stream: 'combined', line: 'bounded context '.repeat(80) });
  const packet = packets.packet(collector.attach(new Error('installation failed')), { action: 'install' });
  assert.equal(Buffer.byteLength(packet.output[0]), 500);
  assert.equal(packet.truncated, true);
});

test('dropping a secondary branch keeps the primary and marks the packet incomplete', () => {
  const error = new Error('primary program failure');
  error.secondaryErrors = ['cleanup one', 'cleanup two', 'cleanup three'].map(message => ({ error: new Error(message) }));
  const packet = createFaultPackets().packet(error, { action: 'repair' });
  assert.deepEqual(packet.errors.map(item => item.message), ['primary program failure', 'cleanup one', 'cleanup two']);
  assert.equal(packet.truncated, true);
});

test('history clipping is distinguished from exactly filling the history budget', () => {
  const packets = createFaultPackets();
  for (const count of [16, 17]) {
    const packet = packets.packet(new Error('program failure'), { action: 'update', history:
      Array.from({ length: count }, (_, index) => ({ event: 'stage_started', stage: 'verify', status: 'running', elapsed_ms: index })),
    });
    assert.equal(packet.breadcrumbs.length, 16);
    assert.equal(packet.truncated, count === 17);
  }
});

test('direct evidence output and environment clipping mark the packet incomplete', () => {
  const output = Array.from({ length: 13 }, () => 'safe technical detail '.repeat(30));
  const error = Object.assign(new Error('program failure'), { launcherEvidence: { errors: [], output, truncated: false } });
  const packet = createFaultPackets({ environment: { os_release: 'safe release detail '.repeat(8) } })
    .packet(error, { action: 'install' });
  assert.equal(packet.output.length, 12);
  assert.equal(Buffer.byteLength(packet.output[0]), 500);
  assert.equal(Buffer.byteLength(packet.environment.os_release), 80);
  assert.equal(packet.truncated, true);
});

test('packet byte trimming preserves the primary source frame ahead of later error detail', () => {
  const primary = Object.assign(new Error('original program failure ' + '\t'.repeat(1180)), {
    stack: 'Error: original\n at apply (primary.js:42:3)',
  });
  let current = primary;
  for (let index = 0; index < 3; index++) {
    current.cause = Object.assign(new Error('\t'.repeat(1200)), {
      stack: Array.from({ length: 12 }, (_, line) => `at fixture (later.js:${line + 1}:2) ` + '\t'.repeat(190) + ' frame').join('\n'),
    });
    current = current.cause;
  }
  const packet = createFaultPackets().packet(primary, { action: 'start' });
  assert.ok(packet.errors[0].frames.some(frame => frame.includes('primary.js:42:3')));
  assert.match(packet.errors[0].message, /^original program failure/);
  assert.ok(Buffer.byteLength(JSON.stringify(packet)) <= 24576);
  assert.equal(packet.truncated, true);
  assert.equal(validFaultPacket(packet), true);
});

test('schema 2 projects frozen operation facts and reviewed primary evidence without raw logs or private fields',()=>{
  const id=require('node:crypto').randomUUID(),packet=createFaultPackets().packet(new Error('outer wrapper'),{id,action:'update'},
    {operation:{operationId:id,snapshotSequence:9,target:{releasePlan:{tag:'v2.4.3'},currentVersion:'2.4.2'},planDigest:'a'.repeat(64),
      stageId:'applying',effectState:'restored',recoveryOutcome:'files-restored-start-failed',verification:'failed',attempt:2,totalAttempts:3,
      evidenceStatus:'saved-truncated',primaryFailure:{code:'PROGRAM_EXIT'},secondaryFailures:[{code:'ROLLBACK_START_FAILED'}],privateKey:'secret-fixture'},
     evidence:{schema:1,operationId:id,primary:{name:'TypeError',message:'original failure',code:'EPERM',frames:['at apply (main.js:42:8)']},
      secondary:[{operation:'recover',error:{name:'Error',message:'restart failure',frames:[]}}],missingReasons:['unreviewed_output'],truncated:true,output:['PRIVATE CHAT']}});
  assert.equal(packet.schema,2);assert.equal(packet.operation.operation_id,id);assert.equal(packet.operation.target_version,'2.4.3');assert.equal(packet.operation.current_version,'2.4.2');
  assert.equal(packet.errors[packet.evidence.primary_error_index].message,'original failure');assert.equal(packet.evidence.secondary_error_indexes.length,1);
  assert.ok(packet.evidence.missing_reasons.includes('unreviewed_output'));assert.equal(packet.truncated,true);assert.equal(validFaultPacket(packet),true);
  assert.doesNotMatch(JSON.stringify(packet),/PRIVATE CHAT|secret-fixture|privateKey/);
});

test('reviewed native collector retains local facts while fault packets exclude native context',()=>{
  const packets=createFaultPackets(),collector=packets.collector(true,{output:false});
  const context={stage:'native_start',loopback:true,pid:987654321,exitCode:-9,port:54321};
  collector.observe({event:'diagnostic',component:'bridge',error:{name:'NativeLifecycleError',code:'TAVERN_PROCESS_EXITED',message:'native exited',stack:'',
    context,missingReasons:['launch_log_unavailable'],truncated:true,
    secondaryErrors:[{error:{name:'TypeError',message:'reviewed Node failure',stack:'File "server.js", line 41, in node',
      context:{stage:'native_start',loopback:true},missingReasons:['program_message_unreviewed']}}]}});
  collector.observe({event:'diagnostic',component:'unreviewed-child',error:{name:'Error',message:'PRIVATE_CHILD_FACTS',context:{pid:123}}});
  const wrapper=collector.attach(new Error('generic exit wrapper'));
  assert.equal(wrapper.launcherEvidence.errors[0].name,'NativeLifecycleError');
  assert.equal(wrapper.launcherEvidence.errors[0].code,'TAVERN_PROCESS_EXITED');
  assert.deepEqual(wrapper.launcherEvidence.errors[0].context,context);
  assert.deepEqual(wrapper.launcherEvidence.errors[0].missingReasons,['launch_log_unavailable']);
  assert.deepEqual(wrapper.launcherEvidence.errors[1].missingReasons,['program_message_unreviewed']);
  const packet=packets.packet(wrapper,{action:'start'});
  assert.equal(packet.errors[0].kind,'Error');
  assert.equal(packet.errors[0].code,'');
  assert.equal(packet.errors[0].message,'NativeLifecycleError: native exited');
  assert.equal(packet.truncated,true);
  assert.equal(validFaultPacket(packet),true);
  assert.doesNotMatch(JSON.stringify(packet),/987654321|54321|"context"|"pid"|"port"|PRIVATE_CHILD_FACTS/);
});
