const assert=require('node:assert/strict');
const crypto=require('node:crypto');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const test=require('node:test');
const {spawnSync}=require('node:child_process');
const vm=require('node:vm');
const {PassThrough}=require('node:stream');
const {once}=require('node:events');
const {findBundledRuntime,initializeHome,relocateTextFiles,sha256File,validateRuntimeLinks}=require('../installer/desktop/runtime');
const {consumeLines}=require('../installer/desktop/process-output');
const componentFixture={componentProbe:'nora-clawchat-check.py',components:{clawchat:{revision:'a'.repeat(40)},liveware:{sha256:'b'.repeat(64)},files:{}}};

async function workerResult(result,{recover=false}={}) {
  const stream=new PassThrough(),messages=[],errors=[],writes=[];
  consumeLines(stream,line=>messages.push(JSON.parse(line)),error=>errors.push(error));
  let close;
  const closed=new Promise(resolve=>{close=resolve;});
  const runtime={installBundledHermes:async()=>result};
  const local={
    './runtime':runtime,'./diagnostics':{errorDetails:error=>({message:error.message})},
    './operation-delegate':{connect:async()=>({context:{operationId:'fixture',ownerEpoch:1},assertActive(){},close})},
    './retained-installation':{inspect:()=>null},'./runtime-transaction':{recover:async()=>result},
  };
  const file=path.resolve(__dirname,'../installer/desktop/runtime-worker.js');
  const processFixture={argv:['node',file,'payload','home','hermes',...(recover?['--recover-runtime']:[])],
    cwd:()=>path.dirname(file),env:{},stdout:{write(value){
      writes.push(value);
      const bytes=Buffer.from(value);for(let offset=0;offset<bytes.length;offset+=8191)stream.write(bytes.subarray(offset,offset+8191));
    }},stderr:{write(){}},exitCode:0};
  vm.runInNewContext(fs.readFileSync(file,'utf8'),{
    require:name=>Object.hasOwn(local,name)?local[name]:require(name),process:processFixture,console,
  },{filename:file});
  await closed;
  const ended=once(stream,'end');stream.end();await ended;
  return {messages,errors,output:writes.join(''),exitCode:processFixture.exitCode};
}

test('runtime worker carries a large Windows component inventory through the actual bounded launcher reader',async()=>{
  const files=Object.fromEntries(Array.from({length:9611},(_,index)=>[
    `hermes-agent/vendor/git/share/runtime-file-${index}.dll`,'a'.repeat(64)]));
  const result={schema:1,platform:'win32',arch:'x64',sha256:'b'.repeat(64),version:'Hermes Agent v0.21.1',
    journalReference:'installer/operations/fixture/runtime-bootstrap.json',
    components:{schema:1,clawchat:{revision:'c'.repeat(40)},terminal:{kind:'git-bash',command:'hermes-agent/vendor/git/bin/bash.exe'},files}};
  const before=JSON.stringify(result);
  assert.ok(Buffer.byteLength(before)>256*1024,'exercise the real production reader boundary');
  const observed=await workerResult(result);
  assert.equal(observed.exitCode,0);
  assert.deepEqual(observed.errors.map(error=>error.code),[]);
  assert.ok(Buffer.byteLength(observed.output)<128*1024,'also fit the unchanged native harness frame boundary');
  assert.equal(observed.messages.length,1);
  const message=observed.messages[0];
  assert.equal(message.event,'result');assert.equal(message.sha256,result.sha256);
  assert.equal(message.version,result.version);assert.equal(message.journalReference,result.journalReference);
  assert.deepEqual(message.components.terminal,result.components.terminal);
  assert.deepEqual(message.components.clawchat,result.components.clawchat);
  assert.equal(message.components.fileCount,9611);assert.equal(Object.hasOwn(message.components,'files'),false);
  assert.equal(JSON.stringify(result),before,'the full verification inventory must remain unchanged');
});

test('runtime worker preserves recovery facts without treating them as a runtime manifest',async()=>{
  const result={effectState:'restored',verification:'confirmed',recoveryOutcome:'restored-and-verified',
    journalReference:'installer/operations/fixture/runtime-bootstrap.json',canRecover:false};
  const observed=await workerResult(result,{recover:true});
  assert.equal(observed.exitCode,0);assert.equal(observed.errors.length,0);
  assert.deepEqual(observed.messages,[{event:'result',...result}]);
});

test('relocated Python entrypoints execute from long Unicode paths with spaces and shell punctuation',
 {skip:process.platform==='win32'||!process.env.NORA_TEST_PYTHON},()=>{
  const parent=fs.mkdtempSync(path.join(os.tmpdir(),'nora-python-entry-'));
  try{
    const home=path.join(parent,"中文 空格 ' $() ` ", 'long-directory-'.repeat(14));
    const python=path.join(home,'venv/bin/python'),entry=path.join(home,'venv/bin/hermes');
    fs.mkdirSync(path.dirname(python),{recursive:true});fs.symlinkSync(process.env.NORA_TEST_PYTHON,python);
    fs.writeFileSync(path.join(home,'finder.py'),"import json\nprint(json.dumps({'home': '@@NORA_HERMES_HOME@@'}))\n");
    fs.writeFileSync(path.join(home,'direct_url.json'),'{"home":"@@NORA_HERMES_HOME@@"}');
    fs.writeFileSync(entry,'#!@@NORA_VENV_PYTHON@@\nimport json,sys\nprint(json.dumps(sys.argv[1:]))\n',{mode:0o755});
    relocateTextFiles(home,{platform:'darwin',venvPython:'venv/bin/python',relocatableFiles:['venv/bin/hermes','finder.py','direct_url.json']});
    const result=spawnSync(entry,['argument with spaces',"quote'and$()"],{encoding:'utf8'});
    assert.equal(result.error,undefined,result.error?.message);assert.equal(result.status,0,result.stderr);
    assert.deepEqual(JSON.parse(result.stdout),['argument with spaces',"quote'and$()"]);
    const compiled=spawnSync(process.env.NORA_TEST_PYTHON,['-B','-c','import ast,sys;ast.parse(open(sys.argv[1]).read())',entry],{encoding:'utf8'});
    assert.equal(compiled.status,0,compiled.stderr);
    const found=spawnSync(python,['-B',path.join(home,'finder.py')],{encoding:'utf8'});
    assert.equal(found.status,0,found.stderr);assert.equal(JSON.parse(found.stdout).home,home);
    assert.equal(JSON.parse(fs.readFileSync(path.join(home,'direct_url.json'),'utf8')).home,home);
  }finally{fs.rmSync(parent,{recursive:true,force:true});}
});

test('a skill-copy failure retains its real filesystem error and concrete source/destination metadata',t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'nora-runtime-copy-'));
  try{
    const source=path.join(root,'hermes-agent/skills/apple');fs.mkdirSync(source,{recursive:true});fs.writeFileSync(path.join(source,'SKILL.md'),'fixture');
    const primary=Object.assign(new Error('original copy failure'),{code:'EPERM',syscall:'symlink'});
    t.mock.method(fs,'cpSync',()=>{throw primary;});
    assert.throws(()=>initializeHome(root,{nodeLinks:{}}),error=>{
      assert.equal(error,primary);assert.equal(error.context.operation,'copy-skill');
      assert.equal(error.context.sourceType,'directory');assert.equal(error.context.destinationType,'missing');
      assert.equal(error.context.sourcePathLength,error.context.source.length);assert.equal(error.context.destinationPathLength,error.context.destination.length);
      return true;
    });
  }finally{t.mock.restoreAll();fs.rmSync(root,{recursive:true,force:true});}
});
test('staging text uses the final runtime directory and home initialization preserves existing configuration',()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'nora-runtime-relocate-'));
  try{
    const file=path.join(root,'relocate-me');fs.writeFileSync(file,'@@NORA_HERMES_HOME@@\n@@NORA_PYTHON_HOME@@\n');
    const final=path.join(root,'final');relocateTextFiles(root,{platform:process.platform,venvPython:'hermes-agent/venv/bin/python',relocatableFiles:['relocate-me']},final);
    const normalize=value=>process.platform==='win32'?value.replaceAll('\\','/'):value;
    assert.equal(fs.readFileSync(file,'utf8'),`${normalize(final)}\n${normalize(path.join(final,'python'))}\n`);
    fs.writeFileSync(path.join(root,'.env'),'DUMMY=existing\n');initializeHome(root,{nodeLinks:{}});
    assert.equal(fs.readFileSync(path.join(root,'.env'),'utf8'),'DUMMY=existing\n');
  }finally{fs.rmSync(root,{recursive:true,force:true});}
});
test('skill initialization copies Unicode paths and binary bytes while retaining existing user skills and configuration',()=>{
  const parent=fs.mkdtempSync(path.join(os.tmpdir(),'nora-runtime-unicode-'));
  const root=path.join(parent,'中文安装位置');
  try{
    const source=path.join(root,'hermes-agent/skills/新增分类/子目录');
    fs.mkdirSync(source,{recursive:true});
    const bytes=Buffer.from([0,128,255,10,13,0,42]);
    fs.writeFileSync(path.join(source,'技能文件.bin'),bytes);
    fs.mkdirSync(path.join(root,'hermes-agent/skills/已有分类'),{recursive:true});
    fs.writeFileSync(path.join(root,'hermes-agent/skills/已有分类/SKILL.md'),'bundled default');
    fs.mkdirSync(path.join(root,'skills/已有分类'),{recursive:true});
    fs.writeFileSync(path.join(root,'skills/已有分类/SKILL.md'),'user retained content');
    fs.writeFileSync(path.join(root,'.env'),'EXISTING=preserve\n');
    fs.writeFileSync(path.join(root,'config.yaml'),'existing: preserve\n');
    initializeHome(root,{nodeLinks:{}});
    assert.deepEqual(fs.readFileSync(path.join(root,'skills/新增分类/子目录/技能文件.bin')),bytes);
    assert.deepEqual(fs.readFileSync(path.join(source,'技能文件.bin')),bytes);
    assert.equal(fs.readFileSync(path.join(root,'skills/已有分类/SKILL.md'),'utf8'),'user retained content');
    assert.equal(fs.readFileSync(path.join(root,'.env'),'utf8'),'EXISTING=preserve\n');
    assert.equal(fs.readFileSync(path.join(root,'config.yaml'),'utf8'),'existing: preserve\n');
  }finally{fs.rmSync(parent,{recursive:true,force:true});}
});
test('bundle lookup validates its platform and component contract without changing the archive',()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'nora-runtime-bundle-'));
  try{
    const archive=path.join(root,'runtime.tar.gz');fs.writeFileSync(archive,'fixture');
    const digest=crypto.createHash('sha256').update('fixture').digest('hex');
    const manifest={...componentFixture,schema:1,platform:process.platform,arch:process.arch,archive:'runtime.tar.gz',sha256:digest};
    fs.writeFileSync(path.join(root,'nora-hermes-runtime.json'),JSON.stringify(manifest));
    assert.equal(findBundledRuntime(root).manifest.sha256,digest);assert.equal(sha256File(archive),digest);
    assert.throws(()=>findBundledRuntime(root,'unsupported'),/不匹配/);
    assert.equal(fs.readFileSync(archive,'utf8'),'fixture');
  }finally{fs.rmSync(root,{recursive:true,force:true});}
});
test('runtime link validation rejects an external directory before the tree can become active',()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'nora-runtime-links-'));
  try{
    const home=path.join(root,'hermes'),outside=path.join(root,'outside');fs.mkdirSync(home);fs.mkdirSync(outside);
    fs.symlinkSync(outside,path.join(home,'escaped'),process.platform==='win32'?'junction':'dir');
    assert.throws(()=>validateRuntimeLinks(home),/目录之外/);
  }finally{fs.rmSync(root,{recursive:true,force:true});}
});

function retainedFixture(t){
  const top=fs.mkdtempSync(path.join(os.tmpdir(),'nora-retained-copy-'));
  t.after(()=>fs.rmSync(top,{recursive:true,force:true}));
  const previous=path.join(top,'previous'),stage=path.join(top,'stage');
  fs.mkdirSync(previous);fs.mkdirSync(stage);
  const write=(base,name,text)=>{const file=path.join(base,name);fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,text);return file;};
  return {top,previous,stage,write,copy:require('../installer/desktop/runtime-retained-data').copyUserData};
}
test('retained copying preserves private files and real .asar directories without restoring old managed programs',t=>{
  const f=retainedFixture(t),names=['config.yaml','.env','memories/USER.md','state/old-app/app.asar','AppData/Local/private-notes.txt'];
  for(const name of names)f.write(f.previous,name,'original '+name);
  f.write(f.previous,'hermes-agent/old.js','old program');f.write(f.stage,'hermes-agent/new.js','new program');
  f.write(f.previous,'state/plain.asar/note.txt','real directory');
  const result=f.copy(f.previous,f.stage);assert.equal(result.files,6);
  for(const name of names)assert.equal(fs.readFileSync(path.join(f.stage,name),'utf8'),'original '+name);
  assert.equal(fs.readFileSync(path.join(f.stage,'state/plain.asar/note.txt'),'utf8'),'real directory');
  assert.equal(fs.existsSync(path.join(f.stage,'hermes-agent/old.js')),false);
  assert.equal(fs.readFileSync(path.join(f.stage,'hermes-agent/new.js'),'utf8'),'new program');
  assert.equal(fs.readFileSync(path.join(f.previous,'hermes-agent/old.js'),'utf8'),'old program');
});
test('retained copying rejects staging redirects before changing their external target',t=>{
  const f=retainedFixture(t),outside=f.write(f.top,'outside/original.txt','must survive');
  f.write(f.previous,'notes/original.txt','retained content');
  fs.symlinkSync(path.dirname(outside),path.join(f.stage,'notes'),process.platform==='win32'?'junction':'dir');
  assert.throws(()=>f.copy(f.previous,f.stage),error=>error.code==='RUNTIME_RETAINED_PATH_INVALID');
  assert.equal(fs.readFileSync(outside,'utf8'),'must survive');
});
test('retained copying refuses external user links without following or changing them',t=>{
  const f=retainedFixture(t),outside=f.write(f.top,'outside/original.txt','must survive');
  fs.symlinkSync(path.dirname(outside),path.join(f.previous,'external'),process.platform==='win32'?'junction':'dir');
  assert.throws(()=>f.copy(f.previous,f.stage),error=>error.code==='RUNTIME_RETAINED_LINK_UNSUPPORTED');
  assert.equal(fs.readFileSync(outside,'utf8'),'must survive');
});
test('retained copying refuses a source changed during copying instead of reporting it preserved',t=>{
  const f=retainedFixture(t),file=f.write(f.previous,'config.yaml','before');
  const copy=fs.copyFileSync;t.mock.method(fs,'copyFileSync',(from,to,...args)=>{copy(from,to,...args);fs.appendFileSync(file,'external change');});
  assert.throws(()=>f.copy(f.previous,f.stage),error=>error.code==='RUNTIME_RETAINED_CHANGED');
  assert.equal(fs.readFileSync(file,'utf8'),'beforeexternal change');
});
