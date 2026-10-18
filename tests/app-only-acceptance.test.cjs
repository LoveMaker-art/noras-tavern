const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const tool=require('../tooling/release/app-only-acceptance.cjs');
test('native APP-only evidence refuses any core or protected-data mutation before sealing proof',t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'nora-app-evidence-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 fs.mkdirSync(path.join(root,'program'));fs.writeFileSync(path.join(root,'program/main'),'actual core');
 const before=tool.snapshotTree(path.join(root,'program'));assert.equal(before.files.length,1);tool.assertSnapshot(path.join(root,'program'),before);
 fs.writeFileSync(path.join(root,'program/main'),'changed core');assert.throws(()=>tool.assertSnapshot(path.join(root,'program'),before),/changed/);
 fs.writeFileSync(path.join(root,'program/main'),'actual core');fs.writeFileSync(path.join(root,'program/extra'),'unowned');assert.throws(()=>tool.assertSnapshot(path.join(root,'program'),before),/changed/);
});
test('APP-only source identities bind unchanged original core and a true APP version increase',()=>{
 const baseline={schema:'tavern-release/v2',candidate:false,dirty:false,commit:'a'.repeat(40),versions:{tavern:'2.5.2'}};
 const product={schema:'tavern-release/v2',candidate:false,dirty:false,commit:'b'.repeat(40),versions:{tavern:'2.5.2'},launcherVersion:'2.2.3'};
 const before={version:'2.2.2',commit:'a'.repeat(40)},after={version:'2.2.3',commit:'b'.repeat(40)};
 assert.doesNotThrow(()=>tool.assertTransition(baseline,product,before,after));
 assert.throws(()=>tool.assertTransition(baseline,{...product,versions:{tavern:'2.5.3'}},before,after),/core/);
 assert.throws(()=>tool.assertTransition(baseline,product,after,after),/increase/);
});
test('native runtime probes use the managed environment and cannot select a host Liveware',t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'nora-native-env-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 fs.writeFileSync(path.join(root,'nora-hermes-runtime.json'),JSON.stringify({venvPython:'hermes-agent/venv/bin/python'}));
 const env=tool.runtimeOptions({baseline:root,hermes:path.join(root,'hermes'),home:root,installRoot:path.join(root,'tavern')}).env;
 assert.equal(env.HERMES_INSTALL_DIR,path.join(root,'hermes/hermes-agent'));assert.equal(env.TAVERN_DATA_ROOT,path.join(root,'tavern'));
 assert.equal(env.PATH.split(path.delimiter)[0],path.join(root,process.platform==='win32'?'hermes/node':'hermes/node/bin'));
 assert.ok(!env.PATH.includes('.local/bin'));assert.equal(env.TAVERN_NODE_EXECUTABLE,path.join(root,process.platform==='win32'?'hermes/node/node.exe':'hermes/node/bin/node'));
});
test('stopped native matrix waits for the initial canonical start to end before stopping and sealing',async()=>{
 let time=0,stops=0,reads=0;const rows=[[{operationId:'new-start',kind:'start',state:'running'}],[{operationId:'new-start',kind:'start',state:'running'}],[{operationId:'new-start',kind:'start',state:'succeeded',verification:'confirmed'}]];
 const result=await tool.settleStoppedPrecondition({},['old'],{now:()=>time,sleep:async()=>{time+=6000;},operations:()=>rows[Math.min(reads++,2)],readStatus:()=>({running:stops===0}),stop:()=>{assert.ok(reads>=3,'Do not race an unfinished initial start');stops++;}});
 assert.equal(stops,1);assert.equal(result.initialStart.operationId,'new-start');assert.equal(time,12000);assert.equal(result.status.running,false);
});
test('stopped native matrix rejects an unsuccessful initial start and never seals a false stopped case',async()=>{
 let stopped=false;await assert.rejects(()=>tool.settleStoppedPrecondition({},[],{operations:()=>[{operationId:'failed',kind:'start',state:'failed'}],readStatus:()=>({running:false}),stop:()=>{stopped=true;}}),/initial start/);assert.equal(stopped,false);
});
test('prepare and observe share the complete HTTP probe before sealing inventories',t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'nora-probe-order-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));fs.writeFileSync(path.join(root,'nora-hermes-runtime.json'),JSON.stringify({venvPython:'hermes-agent/venv/bin/python'}));
 let source;const proof={hermesContext:true,mcpInstanceRead:true,managedConfiguration:true,clawchatRegistration:true,httpStatus:200,sessionReadable:true};
 assert.deepEqual(tool.runtimeProbe({baseline:root,hermes:path.join(root,'hermes'),home:root,installRoot:path.join(root,'tavern'),port:58009},{execute:(_python,args)=>{source=args[2];return JSON.stringify(proof);}}),proof);
 assert.ok(source.includes('/api/nora-boot/shell?lang=zh-cn'));assert.ok(source.includes('/api/nora-worlds-v2/worlds'));assert.ok(source.includes("world.get('sessions',{}).get('items')"));assert.ok(source.indexOf('/api/nora-boot/shell')<source.indexOf('/api/nora-worlds-v2/worlds'));
});
test('stopped native precondition waits for real UI readiness and all new tasks before stopping',async()=>{
 let time=0,stops=0,ready=0,reads=0;const start={operationId:'start',kind:'start',state:'succeeded',verification:'confirmed'};
 const result=await tool.settleStoppedPrecondition({},[],{now:()=>time,sleep:async()=>{time+=300;},operations:()=>++reads<4?[start,{operationId:'other',kind:'start',state:'running'}]:[start],ready:async()=>{ready++;},readStatus:()=>({running:false}),stop:()=>{assert.ok(ready>0,'Native More readiness must be observed');assert.ok(reads>=4,'No new canonical task may still be running');stops++;}});
 assert.equal(stops,1);assert.equal(result.initialStart.operationId,'start');
});

test('stopped native precondition accepts an idle UI without inventing an initial start requirement',async()=>{
 let ready=false,stopped=false;const result=await tool.settleStoppedPrecondition({},[],{ready:async()=>{ready=true;},operations:()=>[],readStatus:()=>({running:false}),stop:()=>{assert.equal(ready,true);stopped=true;}});assert.equal(stopped,true);assert.equal(result.initialStart,null);
});
test('post-handoff runtime observations wait for native UI readiness before opening any probe',async t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'nora-native-reopen-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));const operationDir=path.join(root,'home/installer/operations','a'.repeat(36));fs.mkdirSync(operationDir,{recursive:true});
 fs.writeFileSync(path.join(root,'checkpoint.json'),JSON.stringify({options:{home:path.join(root,'home')},operationIds:[],targetTag:'v2.5.5'}));const file=path.join(operationDir,'operation.json'),operation={operationId:'a'.repeat(36),kind:'update',state:'awaiting-handoff',verification:'unconfirmed',target:{request:{launcherOnly:true},releasePlan:{tag:'v2.5.5'}}};fs.writeFileSync(file,JSON.stringify(operation));let ready=false;
 await assert.rejects(()=>tool.observeAfterNativeReady(root,()=>{ready=true;}),/handoff/);assert.equal(ready,false);
 fs.writeFileSync(file,JSON.stringify({...operation,state:'succeeded',verification:'confirmed'}));await assert.rejects(()=>tool.observeAfterNativeReady(root,()=>{ready=true;throw Error('readiness sentinel before runtime probe');}),/readiness sentinel/);assert.equal(ready,true);
});
test('post-handoff acceptance rejects stale installer guidance and every unsuccessful new start before probing',t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'nora-native-idle-state-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const installer=path.join(root,'installer'),operationDir=path.join(installer,'operations','a'.repeat(36));fs.mkdirSync(operationDir,{recursive:true});
 const stateFile=path.join(installer,'state.json'),file=path.join(operationDir,'operation.json');
 const checkpoint={options:{home:root},operationIds:['old-failure']},clean={phase:'ready',error:'',task:'',resumeTarget:null};
 fs.writeFileSync(stateFile,JSON.stringify(clean));
 const writeStart=changes=>fs.writeFileSync(file,JSON.stringify({operationId:'new-start',kind:'start',state:'succeeded',verification:'confirmed',...changes}));
 writeStart({});assert.equal(tool.assertPostHandoffReady(checkpoint).starts.length,1);
 for(const changes of [{resumeTarget:'v2.5.5'},{error:'old port occupied'},{task:'stale task'},{phase:'error'}]){
  fs.writeFileSync(stateFile,JSON.stringify({...clean,...changes}));assert.throws(()=>tool.assertPostHandoffReady(checkpoint),/installer/);
 }
 fs.writeFileSync(stateFile,JSON.stringify(clean));
 for(const state of ['failed','blocked','running','rolled-back']){writeStart({state});assert.throws(()=>tool.assertPostHandoffReady(checkpoint),/start/);}
 writeStart({verification:'unconfirmed'});assert.throws(()=>tool.assertPostHandoffReady(checkpoint),/start/);
 writeStart({operationId:'old-failure',state:'failed'});assert.equal(tool.assertPostHandoffReady(checkpoint).starts.length,0,'Historical failures remain evidence, not a new workflow failure');
});
test('core receipt identity permits only release bytes or the exact authenticated first-install representation',async()=>{
 const {coreReceiptRepresentations}=await import('../tooling/release/system-release.mjs'),hash=bytes=>require('node:crypto').createHash('sha256').update(bytes).digest('hex');
 const source=Buffer.from(JSON.stringify({schema:'tavern-release/v2',commit:'a'.repeat(40),versions:{tavern:'2.5.2'},artifacts:{'app/main.js':hash('program')}},null,2)+'\n');
 const dependencies={schema:1,platform:'win32',arch:'x64',archive:'nora-tavern-dependencies-win32-x64.tar.gz',sha256:hash('archive'),size:50,nodeMajor:24,roots:['app/engine/sillytavern/node_modules','nora-mcp/node_modules']};
 const bytes=Buffer.from(JSON.stringify(dependencies)),entry={sha256:hash(bytes),size:bytes.length};
 const options={dependenciesBytes:bytes,dependencyEntry:entry,platform:'win32',arch:'x64'},expected=Buffer.from(JSON.stringify({...JSON.parse(source),integratedDependencies:dependencies},null,2));
 const identity=coreReceiptRepresentations(source,options);assert.equal(identity.sourceManifestSha256,hash(source));assert.deepEqual(identity.representations.map(v=>v.sha256),[hash(source),hash(expected)]);
 const altered=Buffer.from(JSON.stringify({...JSON.parse(expected),otherField:true},null,2));assert.ok(!identity.representations.some(v=>v.sha256===hash(altered)),'Extra installed fields are never ignored');
 for(const changed of [{dependencyEntry:{...entry,sha256:hash('forged')}},{dependenciesBytes:Buffer.concat([bytes,Buffer.from(' ')] )},{platform:'darwin'},{arch:'arm64'}])assert.throws(()=>coreReceiptRepresentations(source,{...options,...changed}));
 const existing=Buffer.from(JSON.stringify({...JSON.parse(source),integratedDependencies:{...dependencies,nodeMajor:22}}));assert.throws(()=>coreReceiptRepresentations(existing,options),'Do not overwrite a conflicting integrated dependency declaration');
});
