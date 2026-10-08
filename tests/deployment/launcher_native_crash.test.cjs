const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {test}=require('node:test');
const vm=require('node:vm');
const {parse}=require('../installer/desktop/node_modules/acorn');

function dumpFixture(){
  const buffer=Buffer.alloc(512);
  buffer.write('MDMP');buffer.writeUInt32LE(0xa793,4);buffer.writeUInt32LE(2,8);buffer.writeUInt32LE(32,12);buffer.writeUInt32LE(1700000000,20);
  buffer.writeUInt32LE(6,32);buffer.writeUInt32LE(168,36);buffer.writeUInt32LE(64,40);
  buffer.writeUInt32LE(4,44);buffer.writeUInt32LE(112,48);buffer.writeUInt32LE(232,52);
  buffer.writeUInt32LE(42,64);buffer.writeUInt32LE(0xc0000005,72);buffer.writeBigUInt64LE(0x1012n,88);
  buffer.writeUInt32LE(1,232);buffer.writeBigUInt64LE(0x1000n,236);buffer.writeUInt32LE(0x100,244);buffer.writeUInt32LE(344,256);
  const module=Buffer.from('C:\\private-user\\Electron.dll','utf16le');buffer.writeUInt32LE(module.length,344);module.copy(buffer,348);
  buffer.write('PRIVATE_CHAT_AND_MODEL_KEY',450);
  return buffer;
}

test('native crash collection is local only and restart replays a bounded safe projection once',async t=>{
  const {createNativeCrashDiagnostics}=require('../installer/desktop/native-crash');
  const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'nora-native-crash-')));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const calls=[],events=[],options={directory:root,onEvidence:async value=>events.push(value)};
  const collector=createNativeCrashDiagnostics(options);
  assert.equal(collector.start({app:{setPath:(...args)=>calls.push(args)},crashReporter:{start:config=>calls.push(config)}}),true);
  assert.equal(calls[1].uploadToServer,false);assert.equal(calls[1].submitURL,undefined);
  fs.mkdirSync(path.join(root,'unfixed-layout'));
  fs.writeFileSync(path.join(root,'unfixed-layout','fresh.dmp'),dumpFixture());
  await createNativeCrashDiagnostics(options).collect();
  assert.equal(events.length,1);assert.equal(events[0].exceptionCode,'0xc0000005');
  assert.equal(events[0].location,'Electron.dll+0x12');assert.equal(events[0].stackStatus,'symbolication_required');
  assert.doesNotMatch(JSON.stringify(events),/private-user|PRIVATE_CHAT_AND_MODEL_KEY/);
  await createNativeCrashDiagnostics(options).collect();assert.equal(events.length,1);
});

test('native collector rejects linked evidence and discloses incomplete dumps without reading arbitrary files',async t=>{
  const {createNativeCrashDiagnostics}=require('../installer/desktop/native-crash');
  const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'nora-crash-boundary-')));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const crashes=path.join(root,'crashes');fs.mkdirSync(crashes);
  fs.writeFileSync(path.join(root,'private.dmp'),dumpFixture());fs.symlinkSync(path.join(root,'private.dmp'),path.join(crashes,'linked.dmp'));
  fs.writeFileSync(path.join(crashes,'broken.dmp'),'MDMP');
  const events=[];await createNativeCrashDiagnostics({directory:crashes,onEvidence:async event=>events.push(event)}).collect();
  assert.equal(events.length,1);assert.equal(events[0].evidenceStatus,'dump_unreadable');
  assert.equal(events[0].stackStatus,'unavailable');
});

test('Windows x64 and ARM64 instruction contexts produce module offsets without exporting other registers',async t=>{
  const {createNativeCrashDiagnostics}=require('../installer/desktop/native-crash');
  for(const arch of [9,12]){
    const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'nora-crash-register-')));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
    const original=dumpFixture(),buffer=Buffer.alloc(2048);original.copy(buffer);
    buffer.writeUInt32LE(3,8);buffer.writeUInt32LE(1024,12);original.copy(buffer,1024,32,56);
    buffer.writeUInt32LE(7,1048);buffer.writeUInt32LE(56,1052);buffer.writeUInt32LE(1080,1056);buffer.writeUInt16LE(arch,1080);
    buffer.writeBigUInt64LE(0n,88);buffer.writeUInt32LE(arch===9?256:272,224);buffer.writeUInt32LE(1136,228);
    if(arch===9){buffer.writeUInt32LE(0x00100001,1184);buffer.writeBigUInt64LE(0x1012n,1384);}
    else {buffer.writeUInt32LE(0x00400001,1136);buffer.writeBigUInt64LE(0x1012n,1400);}
    fs.writeFileSync(path.join(root,'context.dmp'),buffer);const events=[];
    await createNativeCrashDiagnostics({directory:root,onEvidence:async value=>events.push(value)}).collect();
    assert.equal(events[0].location,'Electron.dll+0x12');assert.doesNotMatch(JSON.stringify(events),/PRIVATE_CHAT_AND_MODEL_KEY/);
  }
});

test('native artifact retention is limited to the newest ten dumps and never removes another file',async t=>{
  const {createNativeCrashDiagnostics}=require('../installer/desktop/native-crash');
  const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'nora-crash-retention-')));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  fs.writeFileSync(path.join(root,'keep.txt'),'keep');
  for(let i=0;i<12;i++){const file=path.join(root,i+'.dmp');fs.writeFileSync(file,dumpFixture());fs.utimesSync(file,1700000000+i,1700000000+i);}
  const events=[];await createNativeCrashDiagnostics({directory:root,onEvidence:async value=>events.push(value)}).collect();
  assert.equal(events.length,10);assert.equal(fs.readdirSync(root).filter(name=>name.endsWith('.dmp')).length,10);
  assert.equal(fs.existsSync(path.join(root,'0.dmp')),false);assert.equal(fs.existsSync(path.join(root,'11.dmp')),true);
  assert.equal(fs.readFileSync(path.join(root,'keep.txt'),'utf8'),'keep');
});

test('startup registers crash reporting before creating the window and records the actual renderer reason',()=>{
  const source=fs.readFileSync(path.join(__dirname,'../installer/desktop/main.js'),'utf8');
  assert.ok(/nativeCrashes\.start\(/.test(source));
  assert.ok(source.indexOf('nativeCrashes.start(')<source.indexOf('app.whenReady().then'));
  assert.ok(/recordNativeFailure\([^;]*details\.reason/.test(source));
  const manifest=require('../installer/desktop/package.json');assert.ok(manifest.build.files.includes('native-crash.js'));
});

test('the real crash callback sends reason and location through the existing fault and failure-log transport, respecting opt-out',async t=>{
  const source=fs.readFileSync(path.join(__dirname,'../installer/desktop/main.js'),'utf8');
  const node=parse(source,{ecmaVersion:'latest'}).body.find(node=>node.id?.name==='recordNativeFailure');
  for(const enabled of [true,false]){
    const root=fs.mkdtempSync(path.join(os.tmpdir(),'nora-native-transport-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
    const diagnostics=require('../installer/desktop/diagnostics').createDiagnostics({primary:()=>path.join(root,'install.log')});
    const sent=[],chunks=[];
    const telemetry=require('../installer/desktop/telemetry').createTelemetry({file:path.join(root,'telemetry.json'),enabled:true,automatic:false,
      diagnosticDefault:enabled,operationLogs:(...args)=>diagnostics.readOperation(...args),
      logScope:(task,work)=>diagnostics.scope(task.id,{action:task.action},work),
      fetcher:async(url,options)=>{const body=JSON.parse(options.body);if(url.endsWith('/logs')){chunks.push(body);return {ok:true,status:200,json:async()=>({accepted:true,index:body.index,chunk_id:body.chunk_id})};}
        sent.push(...body.events);return {ok:true,status:200,json:async()=>({accepted:body.events.length})};}});
    t.after(()=>telemetry.close());
    const context=vm.createContext({diagnostics,launcherError:require('../installer/desktop/launcher-errors').launcherError,
      trackLauncher:(...args)=>telemetry.track(...args)});
    await vm.runInContext(`(${source.slice(node.start,node.end)})`,context)('renderer',{reason:'crashed',exitCode:139,location:'Electron.dll+0x12',stackStatus:'symbolication_required'});
    for(let i=0;i<4;i++)await telemetry.flush();
    const failure=sent.find(event=>event.event==='operation_finished'&&event.status==='failed');assert.ok(failure);
    if(enabled){assert.match(JSON.stringify(failure.fault),/crashed/);assert.match(chunks.map(c=>c.text).join(''),/Electron.dll\+0x12/);}
    else {assert.equal(failure.fault,null);assert.equal(chunks.length,0);}
  }
});

test('real Electron main, renderer and guarded Node crashes survive restart as safe local evidence',
  {skip:!process.env.NORA_TEST_ELECTRON,timeout:30000},async t=>{
    const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'nora-electron-crash-')));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
    const fixture=path.join(root,'fixture');fs.mkdirSync(fixture);
    fs.writeFileSync(path.join(fixture,'package.json'),JSON.stringify({name:'nora-native-crash-fixture',version:'1.0.0',main:'main.cjs'}));
    fs.writeFileSync(path.join(fixture,'child.cjs'),"global.fixtureSecret='PRIVATE_CRASH_MEMORY_CANARY';setTimeout(()=>process.crash(),100);");
    fs.writeFileSync(path.join(fixture,'main.cjs'),`
      const {app,crashReporter,BrowserWindow}=require('electron'),fs=require('node:fs'),path=require('node:path');
      const {createNativeCrashDiagnostics}=require(${JSON.stringify(path.join(__dirname,'../installer/desktop/native-crash.js'))});
      const root=process.env.NORA_CRASH_FIXTURE;fs.mkdirSync(root+'/data',{recursive:true});app.setPath('userData',root+'/data');
      const collector=createNativeCrashDiagnostics({directory:root+'/dumps',diagnostic:code=>fs.appendFileSync(root+'/diagnostic.txt',code+'\\n'),
        onEvidence:async evidence=>fs.appendFileSync(root+'/evidence.jsonl',JSON.stringify(evidence)+'\\n')});
      const original=crashReporter.start.bind(crashReporter);crashReporter.start=options=>original({...options,ignoreSystemCrashHandler:true});
      if(!collector.start({app,crashReporter}))process.exit(3);
      app.whenReady().then(async()=>{
        const mode=process.env.NORA_CRASH_MODE;
        if(mode==='main'){global.fixtureSecret='PRIVATE_CRASH_MEMORY_CANARY';setTimeout(()=>process.crash(),100);}
        else if(mode==='renderer'){const window=new BrowserWindow({show:false,webPreferences:{nodeIntegration:true,contextIsolation:false,sandbox:false}});
          window.webContents.on('render-process-gone',()=>setTimeout(()=>app.exit(0),300));
          await window.loadURL('data:text/html,isolated');window.webContents.executeJavaScript('process.crash()').catch(()=>{});}
        else if(mode==='guard'){const child=require('node:child_process').spawn(process.execPath,[path.join(__dirname,'child.cjs')],
          {env:{...process.env,ELECTRON_RUN_AS_NODE:'1'},stdio:'ignore'});child.on('close',()=>setTimeout(()=>app.exit(0),300));}
        else {await collector.collect();app.exit(0);}
      });`);
    const {spawn}=require('node:child_process');
    const run=(mode,directory)=>new Promise((resolve,reject)=>{
      fs.mkdirSync(directory,{recursive:true});
      const env={...process.env,NORA_CRASH_MODE:mode,NORA_CRASH_FIXTURE:directory};delete env.ELECTRON_RUN_AS_NODE;
      const child=spawn(process.env.NORA_TEST_ELECTRON,[fixture],{env,stdio:'ignore'}),timer=setTimeout(()=>child.kill('SIGKILL'),8000);
      child.once('error',error=>{clearTimeout(timer);reject(error);});child.once('close',(code,signal)=>{clearTimeout(timer);resolve({code,signal});});
    });
    for(const mode of ['main','renderer','guard']){
      const directory=path.join(root,mode),crash=await run(mode,directory);
      if(mode==='main')assert.ok(crash.signal||crash.code!==0);else assert.equal(crash.code,0,JSON.stringify(crash));
      assert.equal((await run('replay',directory)).code,0);
      const evidence=fs.readFileSync(path.join(directory,'evidence.jsonl'),'utf8');
      const items=evidence.trim().split('\n').map(JSON.parse);assert.ok(items.length>0,mode);
      assert.ok(items.every(item=>item.evidenceStatus==='dump_collected'&&item.dumpUpload===false),mode+': '+JSON.stringify(items));
      assert.ok(items.some(item=>item.location!=='0x0'),mode+' must retain the native instruction location');
      assert.doesNotMatch(evidence,/PRIVATE_CRASH_MEMORY_CANARY/);
      assert.equal((await run('replay',directory)).code,0);assert.equal(fs.readFileSync(path.join(directory,'evidence.jsonl'),'utf8'),evidence);
    }
  });
