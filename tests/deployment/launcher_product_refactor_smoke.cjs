// Real guarded actors in a disposable installation. No model or remote account.
// Run through tooling/run.mjs so every actor uses the current source projection.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const net = require('node:net');
const http = require('node:http');
const crypto = require('node:crypto');
const {execFile} = require('node:child_process');
const lock = require('../installer/desktop/operation-lock');
const {createOperationController} = require('../installer/desktop/operation-state');
const {createEvidenceStore} = require('../installer/desktop/evidence-store');
const {createFaultPackets} = require('../installer/desktop/fault-packet');
const {validateRuntimeLinks} = require('../installer/desktop/runtime');
const {testCustomModel} = require('../installer/desktop/model-config');

const installer = path.resolve(__dirname, '../installer');
const projection = path.resolve(__dirname, '../..');
const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
function options(argv) {
  const result = {};
  for (let index=0;index<argv.length;index++) {
    const name=argv[index];
    if (['--runtime-only','--keep','--missing-system-receipt','--interrupt-first-install','--interrupt-update'].includes(name)) result[name.slice(2)]=true;
    else if (['--payload','--runtime-payload','--update-release','--baseline-release','--scratch-base','--start-state'].includes(name)) {
      const value=argv[++index];
      if(!value || value.startsWith('--')) throw new Error(`Missing ${name} value`);
      result[name.slice(2)]=name==='--start-state'?value:path.resolve(value);
    } else throw new Error(`Unsupported harness option ${name}`);
  }
  if(!result.payload && !result['runtime-payload']) throw new Error('Pass --payload or --runtime-payload');
  if(!result['runtime-only'] && !result.payload) throw new Error('A complete --payload is required for first installation');
  for(const key of ['payload','update-release','baseline-release'])if(result[key] && !fs.existsSync(path.join(result[key],'release-manifest.json'))
      && fs.existsSync(path.join(result[key],'payload/release-manifest.json')))result[key]=path.join(result[key],'payload');
  if(result['start-state']&&!['running','stopped'].includes(result['start-state']))throw new Error('--start-state must be running or stopped');
  if(result['baseline-release']&&!result['update-release'])throw new Error('A legacy baseline requires --update-release');
  if(result['missing-system-receipt']&&!result['update-release'])throw new Error('--missing-system-receipt requires --update-release');
  if(result['interrupt-first-install']&&(result['runtime-only']||result['baseline-release']||result['update-release']))
    throw new Error('--interrupt-first-install requires a new full installation without a baseline/update');
  if(result['interrupt-update']&&(!result['baseline-release']||!result['update-release']))
    throw new Error('--interrupt-update requires an actual baseline and update target');
  return result;
}
function read(file) {return JSON.parse(fs.readFileSync(file,'utf8'));}
function sha(file) {return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');}
async function freePort() {
  const server=net.createServer();
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  const port=server.address().port;await new Promise(resolve=>server.close(resolve));return port;
}
async function portOpen(port) {
  return new Promise(resolve=>{
    const socket=net.createConnection({port,host:'127.0.0.1'});
    const done=value=>{socket.destroy();resolve(value);};
    socket.once('connect',()=>done(true));socket.once('error',()=>done(false));socket.setTimeout(1000,()=>done(true));
  });
}
function runtimePayload(source, root) {
  const flat=path.join(source,'nora-hermes-runtime.json');
  if(fs.existsSync(flat)) return source;
  const name=fs.readdirSync(source).find(name=>name.endsWith('-nora-hermes-runtime.json')
    && read(path.join(source,name)).platform===process.platform && read(path.join(source,name)).arch===process.arch);
  assert.ok(name,'No matching published runtime manifest');
  const manifest=read(path.join(source,name));
  const archive=[manifest.archive,`${process.platform}-${process.arch}-${manifest.archive}`]
    .map(name=>path.join(source,name)).find(fs.existsSync);
  assert.ok(archive,'Published runtime archive is missing');
  const destination=path.join(root,'runtime-payload');fs.mkdirSync(destination,{mode:0o700});
  fs.copyFileSync(path.join(source,name),path.join(destination,'nora-hermes-runtime.json'));
  // Link immutable local input bytes; runtime verifies their published SHA-256.
  fs.linkSync(archive,path.join(destination,manifest.archive));
  return destination;
}
function environment(root, hermes, tavern, payload) {
  const temporary=path.join(root,'tmp');fs.mkdirSync(temporary,{mode:0o700});
  const bins=[path.join(hermes,'node/bin'),path.join(hermes,'node'),
    path.join(hermes,'hermes-agent/venv/bin'),path.join(hermes,'hermes-agent/venv/Scripts')];
  return {
    HOME:hermes,USERPROFILE:hermes,HERMES_HOME:hermes,NORA_HERMES_HOME:hermes,
    NORA_TAVERN_HOME:root,TAVERN_DATA_ROOT:tavern,NORA_INSTALLER_DIRECTORY:path.join(root,'installer'),
    NORA_RELEASE_CHANNEL:payload?.channel||'stable',
    XDG_CACHE_HOME:path.join(root,'cache'),XDG_DATA_HOME:path.join(root,'data'),
    APPDATA:path.join(root,'appdata'),LOCALAPPDATA:path.join(root,'localappdata'),
    TMP:temporary,TEMP:temporary,TMPDIR:temporary,
    PYTHONPATH:[projection,path.join(hermes,'hermes-agent')].join(path.delimiter),
    PYTHONNOUSERSITE:'1',PYTHONDONTWRITEBYTECODE:'1',PYTHONUTF8:'1',PYTHONIOENCODING:'utf-8',
    SystemRoot:process.env.SystemRoot||'',WINDIR:process.env.WINDIR||'',COMSPEC:process.env.COMSPEC||'',
    PATH:[...bins,process.platform==='win32'?process.env.PATH||'':'/usr/bin:/bin:/usr/sbin:/sbin'].join(path.delimiter),
  };
}
async function actor(context, command, args, settings={}) {
  const {label,timeout=240000,input,env,onSpawn,...spawnSettings}=settings;
  const child=context.lease.spawn(command,args,{env,windowsHide:true,...spawnSettings});
  const collector=createFaultPackets().collector(true,{output:false,components:['bridge','installer','updater','native','runtime']});
  let stdout='',stderr='',frame='',truncated=false,reportedError;
  const maximum=4*1024*1024;
  const append=(stream,value)=>{
    const current=stream==='stdout'?stdout:stderr,available=maximum-Buffer.byteLength(current);
    if(value.length>available) truncated=true;
    const text=value.subarray(0,Math.max(0,available)).toString('utf8');
    if(stream==='stdout')stdout+=text;else stderr+=text;
  };
  child.stdout.on('data',value=>{
    append('stdout',value);frame+=value.toString('utf8');
    while(frame.includes('\n')) {
      const split=frame.indexOf('\n'),line=frame.slice(0,split);frame=frame.slice(split+1);
      if(line.length>128*1024){truncated=true;continue;}
      try {
        const message=JSON.parse(line);collector.observe(message);context.observe(message);
        if(message.event==='task'||message.event==='milestone') console.log(`${label||'actor'}: ${message.task||message.stage_id||message.state}`);
        if(message.event==='error')reportedError=message;
        if(message.status==='failed'&&typeof message.error==='string')reportedError={message:message.error};
        if(label?.startsWith('model-')&&message.ok===false) {
          reportedError={message:message.error,code:message.diagnostic?.code};
          if(message.diagnostic)collector.observe({event:'diagnostic',component:'installer',error:message.diagnostic});
        }
      } catch {}
    }
    if(frame.length>128*1024){frame='';truncated=true;}
  });
  child.stderr.on('data',value=>append('stderr',value));
  child.on('error',error=>{reportedError={message:error.message,code:error.code};});
  const closed=new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>{child.kill('SIGKILL');},timeout);timer.unref();
    child.once('guard-lost',()=>{clearTimeout(timer);reject(new Error('Guard lost before actual actor close'));});
    child.once('error',error=>{
      // A guard refusal has no native handle and never emits close. A started
      // actor still must reach actual close before its ownership is accepted.
      if(child.pid===undefined){clearTimeout(timer);reject(collector.attach(error));}
    });
    child.once('close',(status,signal)=>{clearTimeout(timer);resolve({status,signal});});
  });
  const observed=onSpawn?Promise.resolve(onSpawn(child)):Promise.resolve();
  observed.catch(()=>{}); // Await after the actual handle closes.
  child.stdin.end(input);
  let end;
  try{end=await closed;}catch(error){
    const file=path.join(env.NORA_TAVERN_HOME,`harness-${label||'actor'}.log`);
    fs.writeFileSync(file,stdout+'\n'+stderr,{mode:0o600});error.fixtureLog=file;throw error;
  }
  let observationError;
  try{await observed;}catch(error){observationError=error;}
  const facts=await context.lease.snapshot();
  const job=facts.jobs.find(job=>job.jobId===child.jobId);
  assert.ok(job?.closedAt,`${label}: actual child close was not recorded`);
  assert.equal(job.pid,child.pid,`${label}: guard did not own the actual actor PID`);
  assert.equal(job.delegation.identityStatus,'reported',`${label}: actor did not receive a real ACK`);
  assert.ok(job.creationIdentity?.creationTime>0,`${label}: missing actor birth identity`);
  if(end.status!==0||reportedError||observationError) {
    const error=end.status!==0||reportedError
      ?Object.assign(new Error(reportedError?.message||`${label} exited ${end.signal||end.status}`),
        {code:reportedError?.code||(end.signal?'MAINTENANCE_INTERRUPTED':undefined)})
      :observationError;
    if(observationError&&error!==observationError)
      error.secondaryErrors=[...(error.secondaryErrors||[]),{operation:'checkpoint-observation',error:observationError}];
    collector.attach(error);
    // The isolated fixture contains no credentials. Keep bounded raw output in
    // this test directory for diagnosing failed gates, never send it anywhere.
    const file=path.join(env.NORA_TAVERN_HOME,`harness-${label||'actor'}.log`);
    fs.writeFileSync(file,stdout+'\n'+stderr,{mode:0o600});error.fixtureLog=file;throw error;
  }
  assert.equal(truncated,false,`${label}: harness output collection exceeded its budget`);
  return {stdout,stderr,jobId:job.jobId,pid:job.pid};
}

async function interruptActivatedFirstInstall(context,child,{root,tavern,report}) {
  const journal=path.join(root,'installer/operations',context.operationId,'first-install/transaction.json');
  const deadline=Date.now()+180000;
  while(Date.now()<deadline&&child.exitCode===null&&child.signalCode===null) {
    let record;
    try {record=read(journal);}catch(error){if(error.code!=='ENOENT')throw error;}
    const item=record?.targets?.find(item=>item.namespace==='tavern'&&item.path==='apps/tavern-runtime');
    const exchange=item?.exchanges?.at(-1);
    if(exchange?.phase==='new-rename-result') {
      assert.equal(record.operationId,context.operationId);assert.equal(record.roots.tavern,tavern);
      assert.equal(item.codeDigestPolicy,'nora-first-install-code/1');
      const directory=fs.lstatSync(path.join(tavern,item.path),{bigint:true});
      assert.equal(String(directory.dev),String(exchange.newIdentity[0]));assert.equal(String(directory.ino),String(exchange.newIdentity[1]));
      assert.equal(fs.existsSync(path.join(tavern,'tavern-state/native-runtime/runs/production')),false,
        'The interruption must occur before a runtime owner can start');
      const facts=await context.lease.snapshot(),job=facts.jobs.find(job=>job.jobId===child.jobId);
      assert.equal(job.delegation.identityStatus,'reported');assert.equal(job.pid,child.pid);
      assert.equal(job.creationIdentity.pid,child.pid);assert.ok(job.creationIdentity.creationTime>0);assert.equal(Boolean(job.closedAt),false);
      assert.equal(child.kill('SIGKILL'),true,'Only the actual guard-owned child handle may be interrupted');
      report.interruption={checkpoint:'apps/tavern-runtime:new-rename-result',jobId:child.jobId,pid:child.pid,
        creationTime:job.creationIdentity.creationTime,signal:'SIGKILL',journalPath:journal,targetDigest:record.targetDigest};
      return;
    }
    await delay(20);
  }
  throw new Error('The installer did not reach the sealed activation checkpoint before closing');
}
async function interruptAppliedUpdate(context,child,{tavern,report}) {
  const journal=path.join(tavern,'tavern-updates/transaction.json');
  // Match the full local update actor budget; archive validation and local
  // file replacement are not the network's three-minute no-progress limit.
  const deadline=Date.now()+600000;
  while(Date.now()<deadline&&child.exitCode===null&&child.signalCode===null){
    let record;try{record=read(journal);}catch(error){if(error.code!=='ENOENT')throw error;}
    const item=record?.recoveryPlan?.targets?.find(item=>item.phase==='applied'&&item.newIdentity);
    if(record?.status==='prepared'&&item){
      assert.equal(record.operationId,context.operationId);assert.equal(record.recoveryPlan.installRoot,tavern);
      const target=path.join(item.namespace==='install'?tavern:record.recoveryPlan.hermesHome,item.relative);
      const actual=fs.lstatSync(target,{bigint:true});
      assert.equal(String(actual.dev),String(item.newIdentity[0]));assert.equal(String(actual.ino),String(item.newIdentity[1]));
      const job=(await context.lease.snapshot()).jobs.find(job=>job.jobId===child.jobId);
      assert.equal(job.pid,child.pid);assert.equal(job.delegation.identityStatus,'reported');assert.equal(Boolean(job.closedAt),false);
      // The command wrapper delegates to a separate updater handle. Interrupt
      // the whole owned actor tree; killing only the wrapper is not a crash of
      // the actual writer and can let that updater finish normally.
      await context.lease.cancel({signal:'SIGKILL'});
      report.interruption={kind:'update',checkpoint:`${item.name}:applied`,jobId:child.jobId,pid:child.pid,
        creationTime:job.creationIdentity.creationTime,signal:'SIGKILL',journalPath:journal};return;
    }
    await delay(20);
  }
  throw new Error('The real updater did not expose its applied checkpoint before closing');
}
async function verifyProduct(context, run, fixture) {
  const {root,hermes,tavern,port}=fixture;
  const status=JSON.parse((await run('bridge-status',[path.join(installer,'launcher_bridge.py'),
    '--nora-home',root,'--hermes-home',hermes,'--install-root',tavern,'--port',String(port),'status'])).stdout.trim());
  assert.equal(status.systemReady,true,JSON.stringify(status.systemProblems));assert.equal(status.noraInstalled,true);
  assert.equal(status.setupCompleted,false,'A fresh no-model/no-account installation must remain pending setup');
  assert.equal(status.running,true,'Installed Tavern must be healthy without a model');
  const receipt=read(path.join(tavern,'tavern-updates/nora-system.json'));
  for(const proof of ['hermesContext','mcpInstanceRead','managedConfiguration','clawchatRegistration'])assert.equal(receipt.proof[proof],true,proof);
  const get=async route=>{
    const response=await fetch(`http://127.0.0.1:${port}${route}`,{signal:AbortSignal.timeout(15000)});
    assert.equal(response.status,200,route);return response;
  };
  await get('/');
  const user=path.join(tavern,'tavern-state/native/default-user');
  const welcomeFile=path.join(user,'nora-world-core/builtin-welcome.json');
  await (await get('/api/nora-boot/bootstrap')).json();
  assert.equal(fs.existsSync(welcomeFile),false,'A health probe must not initialize welcome data');
  const shell=await (await get('/api/nora-boot/shell?lang=zh-cn')).json();
  const bootstrap=await (await get('/api/nora-boot/bootstrap?lang=zh-cn')).json();
  const welcome=read(welcomeFile);assert.equal(welcome.status,'complete');assert.equal(bootstrap.lastWorldId,welcome.worldId);
  assert.equal(shell.worlds.length,1);
  const worlds=path.join(user,'nora-world-core/worlds');
  const worldFiles=fs.readdirSync(worlds).map(name=>path.join(worlds,name));
  const world=worldFiles.map(read).find(world=>world.world_id===welcome.worldId);assert.equal(world.name,'新手引导');
  const session=world.sessions.items.find(item=>item.session_id===world.sessions.default_session_id);
  const chat=path.join(user,'chats',path.parse(session.binding.avatar).name,`${session.binding.chat_id}.jsonl`);
  const messages=fs.readFileSync(chat,'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(messages.length,2);assert.ok(messages[1].mes.includes('欢迎来到酒馆。'));
  for(const [target,source] of [['SOUL.md','installer/templates/SOUL.md'],['AGENTS.md','skills/agents-tavern.md']])
    assert.equal(fs.readFileSync(path.join(hermes,target),'utf8'),fs.readFileSync(path.join(tavern,'apps/tavern-ops',source),'utf8'));
  await context.stage('verifying');
  return {status,protectedFiles:[path.join(hermes,'.env'),path.join(hermes,'SOUL.md'),path.join(hermes,'nora-instance.json'),chat,...worldFiles]};
}
async function configurationFixture(run,hermes,write=false) {
  const result=await run(write?'fixture-configuration-write':'fixture-configuration-read',['-c',
    `import hashlib,json,sys\nfrom pathlib import Path\nimport yaml\nhome=Path(sys.argv[1]);config=home/'config.yaml'\nvalue=yaml.safe_load(config.read_text(encoding='utf-8')) or {}\npreference={'locale':'zh-cn','storyTheme':'fixture-library'}\nsettings=home.parent/'tavern/tavern-state/native/default-user/settings.json'\ntavern=json.loads(settings.read_text(encoding='utf-8'))\nif sys.argv[2]=='write':\n value['fixture_user_preferences']=preference\n config.write_text(yaml.safe_dump(value,allow_unicode=True,sort_keys=False),encoding='utf-8');config.chmod(0o600)\n with (home/'.env').open('a',encoding='utf-8') as stream:stream.write('\\nNORA_FIXTURE_USER_PREFERENCE=preserve-fixture\\n')\n tavern['username']='fixture-library-user';tavern['power_user']['avatar_style']=1\n settings.write_text(json.dumps(tavern,ensure_ascii=False,indent=2)+'\\n',encoding='utf-8');settings.chmod(0o600)\nassert value.get('fixture_user_preferences')==preference,'Hermes user configuration preference was lost'\nassert tavern.get('username')=='fixture-library-user' and tavern['power_user'].get('avatar_style')==1,'Tavern user preferences were lost'\nproof={'hermes':preference,'tavern':{'username':tavern['username'],'avatar_style':tavern['power_user']['avatar_style']}}\nprint(json.dumps({'sha256':hashlib.sha256(json.dumps(proof,sort_keys=True).encode()).hexdigest()}))`,
    hermes,write?'write':'read']);
  return JSON.parse(result.stdout.trim()).sha256;
}
async function modelConfigurationFixture(run,hermes,root) {
  const requests=[];
  const server=http.createServer((request,response)=>{
    let body='';request.setEncoding('utf8');
    request.on('data',chunk=>{body+=chunk;if(body.length>64*1024)request.destroy();});
    request.on('end',()=>{
      try {
        const payload=JSON.parse(body),selected=/^\/([AB])\/v1\/chat\/completions$/.exec(request.url)?.[1];
        assert.ok(selected,'A model request escaped the local fixture route');assert.equal(request.method,'POST');
        assert.equal(request.headers.authorization,`Bearer fixture-only-credential-${selected}`);
        assert.equal(payload.model,`fixture-model-${selected}`);
        requests.push({selected,url:request.url,credentialSha256:crypto.createHash('sha256').update(request.headers.authorization).digest('hex'),
          model:payload.model,client:request.headers['user-agent']||''});
        response.writeHead(200,{'Content-Type':'application/json'});response.end(JSON.stringify({id:'fixture-completion',object:'chat.completion',
          created:Math.floor(Date.now()/1000),model:payload.model,choices:[{index:0,message:{role:'assistant',content:'NORA_OK'},finish_reason:'stop'}],
          usage:{prompt_tokens:1,completion_tokens:1,total_tokens:2}}));
      } catch(error) {response.writeHead(400,{'Content-Type':'application/json'});response.end(JSON.stringify({error:{message:error.message}}));}
    });
  });
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  const base=`http://127.0.0.1:${server.address().port}`;
  try {for(const selected of ['A','B']) {
    const body={action:'save-local',provider:'custom',model:`fixture-model-${selected}`,keyEnv:'',
      key:`fixture-only-credential-${selected}`,baseUrl:`${base}/${selected}/v1`};
    const before=requests.length;
    // Exercise the same real HTTP credential test used by model-save-test.
    // Persistence remains a genuine ACKed Python actor inside this operation.
    assert.equal((await testCustomModel(body.baseUrl,body.key,body.model)).ok,true);
    assert.equal(requests.length,before+1,'The launcher credential test did not reach the fixture');
    const result=JSON.parse((await run(`model-config-${selected}`,[path.join(installer,'model_config.py')],
      {input:JSON.stringify(body)})).stdout.trim());
    assert.equal(result.ok,true);assert.equal(result.model,body.model);assert.equal(result.validation,'configuration-only');
    const verified=JSON.parse((await run(`model-runtime-${selected}`,[path.join(installer,'model_config.py')],
      {input:JSON.stringify({action:'verify-runtime'})})).stdout.trim());
    assert.equal(verified.ok,true,'The actual Hermes provider resolver must use the saved selection');
    const marker=read(path.join(root,'installer/model.json'));
    assert.equal(marker.model,body.model);assert.equal(marker.baseUrl,body.baseUrl);
    assert.equal(JSON.stringify(marker).includes(body.key),false,'Model selection receipt must omit credentials');
    const connected=await run(`model-connector-${selected}`,['-c',
      `import json,sys\nfrom urllib.parse import urlparse\nfrom hermes_cli.runtime_provider import resolve_runtime_provider\nfrom agent.auxiliary_client import resolve_provider_client,shutdown_cached_clients\nexpected=json.load(sys.stdin);runtime=resolve_runtime_provider()\nassert runtime['base_url']==expected['baseUrl'] and runtime['model']==expected['model'],'Saved model runtime changed'\nassert urlparse(runtime['base_url']).hostname=='127.0.0.1','Fixture must never contact an external model service'\nclient,model=resolve_provider_client(runtime['provider'],model=runtime['model'],api_mode=runtime['api_mode'],main_runtime=runtime)\nassert client is not None and model==expected['model'],'Hermes did not build its actual configured connector'\ntry:\n response=client.chat.completions.create(model=model,messages=[{'role':'user','content':'Reply with exactly: NORA_OK'}],stream=False)\n assert response.choices[0].message.content=='NORA_OK'\n print(json.dumps({'ok':True,'model':model,'connector':type(client).__name__}))\nfinally:\n client.close();shutdown_cached_clients()`],{input:JSON.stringify({baseUrl:body.baseUrl,model:body.model})});
    assert.equal(JSON.parse(connected.stdout.trim()).ok,true);
    assert.equal(requests.length,before+2,'The actual Hermes connector did not reach the local fixture');
    assert.deepEqual(requests.slice(before).map(request=>[request.selected,request.url,request.model]),
      Array.from({length:2},()=>[selected,`/${selected}/v1/chat/completions`,body.model]));
  }} finally {server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
  return {requests,verification:'launcher-http-test-and-guarded-hermes-connector'};
}
async function main() {
  const opts=options(process.argv.slice(2));
  const base=opts['scratch-base']||path.join(os.tmpdir(),'nora-launcher-refactor-products-20261004');
  fs.mkdirSync(base,{recursive:true,mode:0o700});
  const root=fs.realpathSync(fs.mkdtempSync(path.join(base,'products-smoke-'))),hermes=path.join(root,'hermes'),tavern=path.join(root,'tavern');
  const payload=opts.payload;const runtime=runtimePayload(opts['runtime-payload']||payload,root);
  const manifest=read(path.join(runtime,'nora-hermes-runtime.json'));
  const env=environment(root,hermes,tavern,payload?read(path.join(payload,'nora-system.json')):null);
  const port=await freePort();const directory=path.join(root,'installer');
  const observeEffects=opts['interrupt-first-install']||opts['interrupt-update']?record=>new Promise((resolve,reject)=>{
    const python=path.join(hermes,manifest.venvPython);
    if(!fs.existsSync(python)){resolve({effectState:'unknown',canRecover:false,reason:'fixture_runtime_absent'});return;}
    // operation-effects is a read-only public query. Every fixture writer is
    // still spawned through the held lease and acknowledges its actual handle.
    execFile(python,['-B',path.join(installer,'launcher_bridge.py'),'--nora-home',root,'--hermes-home',hermes,
      '--install-root',tavern,'--port',String(port),'operation-effects','--operation-id',record.operationId,'--kind',record.kind==='install'?'install':'update'],
      {env,cwd:projection,timeout:30000,maxBuffer:256*1024},(error,stdout)=>{
        if(error){reject(error);return;}
        try {
          const result=stdout.split(/\r?\n/).filter(line=>line.startsWith('{')).map(line=>JSON.parse(line))
            .findLast(value=>value.event==='result'&&value.effects);
          assert.ok(result?.effects,'The read-only bridge did not return operation effects');resolve(result.effects);
        } catch(error){reject(error);}
      });
  }):undefined;
  const controller=createOperationController({directory,lock,evidence:createEvidenceStore({directory}),observeEffects,projectResult:value=>value.value});
  let operation,stopConfirmed=false,rootFailure,initialManifest,proof,configurationDigest;
  const report={schema:'nora-launcher-products-smoke/1',root,platform:process.platform,arch:process.arch,port,
    releaseManifestSha256:payload?sha(path.join(payload,'release-manifest.json')):null,runtimeSha256:manifest.sha256,
    actorSourceFiles:Object.fromEntries(['first_install.py','launcher_bridge.py','operation_control.py','operation_cli.py','model_config.py',
      'nora_system.py','nora_profile.py','error_diagnostics.py','operation_evidence.py','operation-budget.json','update_recovery.py','operation_node.mjs','mcp_probe.mjs',
      ...['runtime-worker','runtime','runtime-transaction','operation-delegate','operation-lock','operation-lock-worker','operation-state',
        'operation-policy','operation-result','evidence-store','fault-packet','diagnostics','model-config','managed-python','os-lock','launcher-errors','error-presentation']
        .map(name=>`desktop/${name}.js`)].map(name=>[name,sha(path.join(installer,name))])),
    phases:[],jobs:0,nestedJobs:0,remoteModel:'pending-not-exercised',remoteClawChat:'pending-no-account',gui:'pending-not-exercised'};
  if(payload) {
    const selected=read(path.join(payload,'release-manifest.json'));
    for(const [name,hash] of Object.entries(report.actorSourceFiles))
      assert.equal(hash,selected.artifacts[`ops/installer/${name}`],`Current actor differs from the selected candidate: ${name}`);
    report.actorSourceBinding='verified-selected-candidate-manifest';
  }
  console.log(`Isolated product fixture: ${root}; port ${port}`);
  const executePhase=async phase=>controller.start(phase,{target:{request:{mode:'isolated-source-smoke',phase,action:phase,port},
      runtimeSha256:manifest.sha256,releaseManifestSha256:payload?sha(path.join(payload,'release-manifest.json')):null,
      baselineManifestSha256:opts['baseline-release']?sha(path.join(opts['baseline-release'],'release-manifest.json')):null,
      updateManifestSha256:opts['update-release']?sha(path.join(opts['update-release'],'release-manifest.json')):null,
      initialService:opts['start-state']||'running'},
      execute:async context=>{
        const python=path.join(hermes,manifest.venvPython);
        const run=(label,args,settings={})=>actor(context,python,['-B','-u',path.join(installer,'operation_control.py'),'--delegate-exec',...args],
          {label,kind:'python-maintenance',env,cwd:projection,managedPythonRoot:path.join(hermes,'python'),
            venvHome:path.join(hermes,'hermes-agent/venv'),...settings});
        if(phase==='install'&&opts['interrupt-first-install']) {
          const metadata=read(path.join(path.dirname(payload),'desktop/package.json')).noraLocalTest;
          const systemManifest=read(path.join(payload,'release-manifest.json'));
          const systemManifestSha256=sha(path.join(payload,'nora-system.json'));
          if(metadata)assert.equal(metadata.systemManifestSha256,systemManifestSha256);
          await context.plan({...context.target,request:{action:'install',port},releasePlan:{schema:'nora-local-test-plan/1',mode:'install',
            tag:`v${systemManifest.versions.tavern}`,buildId:metadata?.buildId||`product-fixture-${context.operationId}`,systemManifestSha256,
            commit:systemManifest.commit,platform:process.platform,arch:process.arch,channel:env.NORA_RELEASE_CHANNEL}});
        } else await context.plan(context.target);
        await context.stage('applying');await context.effect('changed');
        try {
          if(phase==='install'){
          await actor(context,process.execPath,[path.join(installer,'desktop/runtime-worker.js'),runtime,root,hermes],
            {label:'runtime-bootstrap',kind:'runtime-bootstrap',env,cwd:projection,timeout:600000});
          validateRuntimeLinks(hermes);
          const component=await run('component-probe',[path.join(hermes,manifest.componentProbe)]);
          assert.equal(JSON.parse(component.stdout.trim().split('\n').pop()).ok,true);
          report.runtime='verified';
          env.TAVERN_NODE_EXECUTABLE=path.join(hermes,manifest.nodeBin,process.platform==='win32'?'node.exe':'node');
          if(!opts['runtime-only']) {
            const initial=opts['baseline-release']||payload;
            let firstInstaller=path.join(installer,'first_install.py');
            if(opts['baseline-release']) {
              const historical=path.join(root,'historical-source');
              await run('baseline-extract',['-c',
                'from pathlib import Path; import sys; from ops.updater import bundle; release=Path(sys.argv[1]); manifest=bundle.read_bundle(release,sys.argv[2],candidate=False); bundle.extract_bundle(release,Path(sys.argv[3]),manifest)',
                initial,sha(path.join(initial,'release-manifest.json')),historical]);
              firstInstaller=path.join(historical,'ops/installer/first_install.py');
              assert.equal(sha(firstInstaller),read(path.join(initial,'release-manifest.json')).artifacts['ops/installer/first_install.py']);
              report.baselinePreparation='published-legacy-helper-top-level-ACK-only';
              report.baselineNestedACK='not-supported-by-historical-helper';
            }
            initialManifest=read(path.join(initial,'release-manifest.json'));
            await run(opts['baseline-release']?'baseline-first-install':'first-install',[firstInstaller,'--nora-home',root,'--hermes-home',hermes,
              '--install-root',tavern,'--port',String(port),'--release-dir',initial,...(initialManifest.candidate?['--allow-candidate']:[]),
              '--skip-liveware','--dedicated-nora','--apply','--confirm'],{timeout:600000,...(opts['interrupt-first-install']?
                {onSpawn:child=>interruptActivatedFirstInstall(context,child,{root,tavern,report})}:{})});
            proof=await verifyProduct(context,run,{root,hermes,tavern,port});
            report.firstInstall='verified';report.http='verified';report.hermesSkills='verified';report.mcp='verified';report.noModelSetup='pending-as-expected';
            configurationDigest=await configurationFixture(run,hermes,true);
            report.userConfigurationDigest=configurationDigest;
            if(!opts['baseline-release']) {
              const committed=await run('first-install-committed-inspect',['-c',
                'import json,sys; from pathlib import Path; from ops.installer import first_install; print(json.dumps(first_install.inspect_first_install(Path(sys.argv[1]))))',
                path.join(directory,'operations',context.operationId,'first-install/transaction.json')]);
              const state=JSON.parse(committed.stdout.trim());
              assert.equal(state.status,'committed');assert.equal(state.operationId,context.operationId);assert.equal(state.canResume,true);
              assert.equal(state.targetDigest,read(path.join(directory,'operations',context.operationId,'first-install/transaction.json')).targetDigest);
              report.committedFirstInstall='verified-sealed-target-resume-eligibility';
              const bound=[path.join(tavern,'apps/tavern-runtime/native_lifecycle.py'),
                path.join(tavern,'apps/tavern-ops/installer/first_install.py'),
                ...['installed.json','installed-manifest.json'].map(name=>path.join(tavern,'tavern-updates',name)),
                path.join(directory,'operations',context.operationId,'first-install/transaction.json')];
              const frozen=bound.map(file=>({file,sha256:sha(file),inode:String(fs.statSync(file,{bigint:true}).ino)}));
              await run('bridge-stop-before-resume',[path.join(installer,'launcher_bridge.py'),'--nora-home',root,'--hermes-home',hermes,
                '--install-root',tavern,'--port',String(port),'stop'],{timeout:60000});
              assert.equal(await portOpen(port),false);
              const resumed=await run('resume-committed-install',[path.join(installer,'launcher_bridge.py'),'--nora-home',root,'--hermes-home',hermes,
                '--install-root',tavern,'--port',String(port),'resume-committed-install','--operation-id',context.operationId],{timeout:180000});
              const accepted=resumed.stdout.split(/\r?\n/).filter(line=>line.startsWith('{')).map(line=>{
                try{return JSON.parse(line);}catch{return {};}
              }).findLast(item=>item.event==='result');
              assert.equal(accepted?.firstInstallVerified,true);assert.equal(accepted?.operationVerified,true);
              for(const sealed of frozen) {
                assert.equal(sha(sealed.file),sealed.sha256,`Acceptance rewrote ${path.basename(sealed.file)}`);
                assert.equal(String(fs.statSync(sealed.file,{bigint:true}).ino),sealed.inode,'Acceptance must preserve the original installed file identity');
              }
              assert.equal(await configurationFixture(run,hermes),configurationDigest);
              assert.equal((await fetch(`http://127.0.0.1:${port}/`,{signal:AbortSignal.timeout(15000)})).status,200);
              report.committedFirstInstall='verified-real-resume-without-reinstall';
            }
          }
          }
            if(phase==='update') {
              if(opts['start-state']==='stopped') {
                await run('bridge-stop-before-update',[path.join(installer,'launcher_bridge.py'),'--nora-home',root,'--hermes-home',hermes,
                  '--install-root',tavern,'--port',String(port),'stop'],{timeout:60000});
                assert.equal(await portOpen(port),false);
              }
              if(opts['missing-system-receipt']) {
                await run('remove-fixture-system-receipt',['-c',
                  'import sys; from pathlib import Path; Path(sys.argv[1]).unlink()',
                  path.join(tavern,'tavern-updates/nora-system.json')]);
                report.missingSystemReceipt='removed-for-isolated-recovery-acceptance';
              }
              const beforeState=JSON.parse((await run('bridge-before-update-status',[path.join(installer,'launcher_bridge.py'),
                '--nora-home',root,'--hermes-home',hermes,'--install-root',tavern,'--port',String(port),'status'])).stdout.trim());
              assert.equal(beforeState.running,opts['start-state']!=='stopped');
              report.updateInitialService=beforeState.running?'running':'stopped';
              const before=proof.protectedFiles.map(file=>[file,sha(file)]);
              const selected=opts['update-release'];
              const target=read(path.join(selected,'release-manifest.json'));
              const lifecycle={bridge:path.join(installer,'launcher_bridge.py'),noraHome:root,hermesHome:hermes,installRoot:tavern,port,
                before:Object.fromEntries(['version','systemReady','systemProblems','running','gatewayRunning','clawchatConnected']
                  .map(key=>[key,beforeState[key]]))};
              if(opts['missing-system-receipt']) {
                assert.equal(beforeState.systemReady,false,'Missing acceptance must remain unconfirmed before repair');
                lifecycle.receiptRecovery=JSON.parse((await run('bound-missing-receipt-snapshot',['-c',
                  'import json,sys; from pathlib import Path; from types import SimpleNamespace; from ops.installer.launcher_bridge import missing_receipt_snapshot; print(json.dumps(missing_receipt_snapshot(SimpleNamespace(nora_home=Path(sys.argv[1]),hermes_home=Path(sys.argv[2]),install_root=Path(sys.argv[3]),port=int(sys.argv[4])))))',
                  root,hermes,tavern,String(port)])).stdout.trim());
              }
              const changed=Object.keys(target.artifacts).filter(name=>target.artifacts[name]!==initialManifest.artifacts[name]);
              report.changedSourceArtifacts=changed.length;
              if(opts['baseline-release'])assert.ok(changed.length>0,'The candidate must differ from the actual published baseline');
              // Candidate validation remains explicit and local to this fixture.
              const updated=await run('update',[path.join(selected,'tavern-updater-bootstrap.py'),'--hermes-home',hermes,'--install-root',tavern,
                '--managed-home',root,'--release-dir',selected,...(target.candidate?['--allow-candidate']:[]),'--apply','--confirm'],
                {timeout:600000,env:{...env,NORA_UPDATE_LIFECYCLE:JSON.stringify(lifecycle)},...(opts['interrupt-update']?
                  {timeout:600000,onSpawn:child=>interruptAppliedUpdate(context,child,{tavern,report})}:{})});
              const updateResult=updated.stdout.split(/\r?\n/).filter(line=>line.startsWith('{')).map(line=>{
                try{return JSON.parse(line);}catch{return {};}
              }).findLast(item=>item.event==='result');
              assert.equal(updateResult?.updateVerified,true,'The real update must finish its product acceptance');
              for(const [file,hash] of before)assert.equal(sha(file),hash,`Update changed protected fixture ${path.basename(file)}`);
              assert.equal(await configurationFixture(run,hermes),configurationDigest);
              report.userConfigurationDigest=configurationDigest;
              await verifyProductAfterUpdate(run,{root,hermes,tavern,port},beforeState.running,target);
              if(opts['missing-system-receipt']) {
                assert.ok(fs.existsSync(path.join(tavern,'tavern-updates/nora-system.json')));
                report.missingSystemReceipt='verified-bound-repair-and-preserved-user-data';
              }
              report.update=changed.length?'verified-content-transition':'verified-noop';report.userData='retained';
              report.releaseAcceptance=initialManifest.versions.tavern===target.versions.tavern?'isolated-same-version-repair':'isolated-version-transition';
            }
          if(phase==='model'){
            report.modelRequests=await modelConfigurationFixture(run,hermes,root);
            assert.equal(await configurationFixture(run,hermes),configurationDigest);
            report.modelConfiguration='verified-local-A-to-B-model-requests';
          }
          await context.stage('verifying');
        } catch(error) {
          rootFailure=error;
          if((opts['interrupt-first-install']||opts['interrupt-update'])&&report.interruption) {
            const effects=opts['interrupt-update']?await observeEffects(context.snapshot)
              :JSON.parse((await run('inspect-interrupted-install',['-c',
                'import json,sys; from ops.installer.first_install import inspect_first_install; print(json.dumps(inspect_first_install(sys.argv[1])))',
                report.interruption.journalPath])).stdout.trim());
            assert.equal(effects.effectState,'changed');assert.equal(effects.canRecover,true);
            report.interruption.effects=effects;report.interruption.journalSha256=sha(report.interruption.journalPath);
            assert.equal(await portOpen(port),false);stopConfirmed=true;report.stop='interrupted-instance-confirmed-offline';
          }
          throw error;
        }
        finally {
          if((phase==='stop'||rootFailure)&&!report.interruption&&fs.existsSync(path.join(tavern,'apps/tavern-runtime/native_lifecycle.py'))) {
            try {
              await run('bridge-stop',[path.join(installer,'launcher_bridge.py'),'--nora-home',root,'--hermes-home',hermes,
                '--install-root',tavern,'--port',String(port),'stop'],{timeout:60000});
              assert.equal(await portOpen(port),false,'Fixture listener remains after positively owned stop');
              stopConfirmed=true;report.stop='verified';
            } catch(error) {if(rootFailure)rootFailure.secondaryErrors=[...(rootFailure.secondaryErrors||[]),{operation:'fixture-stop',error}];else throw error;}
          } else if((phase==='stop'||rootFailure)&&!report.interruption) {stopConfirmed=!(await portOpen(port));report.stop=stopConfirmed?'no-service-started':'unknown';}
          try {
            const facts=await context.lease.snapshot();const nested=facts.jobs.filter(job=>job.parentJobId);
            report.jobs+=facts.jobs.length;report.nestedJobs+=nested.length;
            report.phases.push({kind:phase,operationId:context.operationId,jobs:facts.jobs.length,nestedJobs:nested.length});
            if(phase==='install')report.operationId=context.operationId;
            assert.ok(facts.jobs.every(job=>job.closedAt||job.spawnFailedAt),'A maintenance actor is not actually closed');
            if(phase==='install'&&report.runtime==='verified')assert.ok(nested.length>0,'The real runtime helpers must be guard-owned nested actors');
            if(report.interruption)report.interruptedUnacknowledgedJobs=nested.filter(job=>job.kind!=='runtime-helper'
              &&job.delegation.identityStatus!=='reported').map(job=>({jobId:job.jobId,pid:job.pid,closedAt:job.closedAt,
                birthRecorded:Boolean(job.creationIdentity?.creationTime),identityStatus:job.delegation.identityStatus}));
            else assert.ok(nested.filter(job=>job.kind!=='runtime-helper').every(job=>job.delegation.identityStatus==='reported'),
              'A nested maintenance actor did not ACK its actual handle');
            report.executorHandles='verified-closed';
          } catch(error) {
            report.executorHandles='unconfirmed';
            if(rootFailure)rootFailure.secondaryErrors=[...(rootFailure.secondaryErrors||[]),{operation:'fixture-handles',error}];else throw error;
          }
        }
        return {verification:'confirmed',value:{runtime:report.runtime,firstInstall:report.firstInstall||'not-requested',stop:report.stop}};
      }},crypto.randomUUID());
  try {
    const phases=['install',...(opts['update-release']?['update']:[]),...(!opts['runtime-only']?['model']:[]),'stop'];
    if(!opts['update-release'])report.update='pending-no-target-provided';
    for(const phase of phases){
      operation=await executePhase(phase);
      if((opts['interrupt-first-install']||opts['interrupt-update'])&&report.interruption)break;
      if(operation.state!=='succeeded'&&rootFailure)throw rootFailure;
      assert.equal(operation.state,'succeeded',JSON.stringify(operation.currentFailure||operation.primaryFailure));
      assert.equal((await lock.probe({directory})).busy,false,`The ${phase} owner was not released`);
    }
    if((opts['interrupt-first-install']||opts['interrupt-update'])&&report.interruption?.effects?.canRecover===true) {
      assert.equal(operation.state,'failed');assert.equal(report.executorHandles,'verified-closed');
      assert.equal((await lock.probe({directory})).busy,false);
      const frozen=await controller.snapshot(operation.operationId);
      assert.equal(frozen.planDigest,operation.planDigest);assert.ok(frozen.primaryFailure);assert.equal(frozen.effectState,'changed');
      report.originalSnapshotPath=path.join(root,'original-operation-snapshot.json');
      fs.writeFileSync(report.originalSnapshotPath,JSON.stringify(frozen,null,2)+'\n',{mode:0o600});
      report.operation='verified-failed-and-released';report.outcome='interrupted-for-recovery';return report;
    }
    if(operation.state!=='succeeded'&&rootFailure)throw rootFailure;
    assert.equal(operation.state,'succeeded',JSON.stringify(operation.currentFailure||operation.primaryFailure));
    assert.equal((await lock.probe({directory})).busy,false,'The fixture native owner was not released');
    report.operation='verified';report.outcome='passed';
  } catch(error) {report.outcome='failed';report.error={name:error.name,message:error.message,code:error.code,fixtureLog:error.fixtureLog};throw error;}
  finally {
    report.retained=Boolean(opts.keep||report.outcome!=='passed'||!stopConfirmed);
    fs.writeFileSync(path.join(root,'harness-result.json'),JSON.stringify(report,null,2)+'\n',{mode:0o600});
    console.log(JSON.stringify(report));
    // Keep every failed or unconfirmed-stop fixture for safe diagnosis/recovery.
    if(!report.retained)fs.rmSync(root,{recursive:true,force:true});
  }
}
async function verifyProductAfterUpdate(run,{root,hermes,tavern,port},expectedRunning,target) {
  const state=JSON.parse((await run('bridge-update-status',[path.join(installer,'launcher_bridge.py'),'--nora-home',root,
    '--hermes-home',hermes,'--install-root',tavern,'--port',String(port),'status'])).stdout.trim());
  assert.equal(state.systemReady,true,JSON.stringify(state.systemProblems));assert.equal(state.running,expectedRunning);assert.equal(state.setupCompleted,false);
  const receipt=read(path.join(tavern,'tavern-updates/installed.json'));
  assert.equal(receipt.sourceDigest,target.sourceDigest,'The actual installed source must match the selected target');
  assert.equal(receipt.version,target.versions.tavern);
  if(expectedRunning)assert.equal((await fetch(`http://127.0.0.1:${port}/`,{signal:AbortSignal.timeout(15000)})).status,200);
  else assert.equal(await portOpen(port),false);
}
if(require.main===module)main().catch(error=>{console.error(error);process.exitCode=1;});
module.exports={main,options,actor,modelConfigurationFixture};

module.exports={actor};
