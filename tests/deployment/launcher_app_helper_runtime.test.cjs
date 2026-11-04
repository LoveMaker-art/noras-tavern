const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto');
const {EventEmitter}=require('node:events');
const runtime=require('../installer/desktop/app-helper-runtime');
const hash=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
async function fixture(t){
  const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'nora-app-helper-unit-')));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const resourcesRoot=path.join(root,'app','resources'),home=path.join(root,'data'),image=path.join(resourcesRoot,'app-helper-runtime');
  fs.mkdirSync(home);fs.mkdirSync(image,{recursive:true});
  const executable=process.platform==='darwin'?path.join(root,'app/Contents/MacOS/launcher'):path.join(root,'app/launcher.exe');
  const python=process.platform==='win32'?'python/python.exe':'python/bin/python3';
  const write=(relative,bytes)=>{const file=path.join(image,relative);fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,bytes,{mode:0o755});};
  // These bytes are a protocol adapter, not a claim that a real Python image
  // was packaged. The package builder separately verifies an actual closure.
  write(python,'synthetic interpreter adapter');
  write('python/lib/python3.11/site-packages/psutil/__init__.py','synthetic psutil adapter');
  const descriptor={schema:runtime.SCHEMA,platform:process.platform,arch:process.arch,root:'app-helper-runtime',
    executable:python,pythonRoot:'python',pythonVersion:'3.11.15',psutilVersion:'7.0.0',files:await runtime.inventory(image)};
  descriptor.imageSha256=runtime.imageDigest(descriptor);
  const save=()=>{const bytes=Buffer.from(JSON.stringify(descriptor));fs.writeFileSync(path.join(resourcesRoot,runtime.DESCRIPTOR),bytes);return hash(bytes);};
  let descriptorSha256=save();const probes=[];
  const spawnProbe=(command,args,options)=>{
    probes.push({command,args,options});const child=new EventEmitter();child.stdout=new EventEmitter();child.stderr=new EventEmitter();child.kill=()=>true;
    queueMicrotask(()=>{
      const pythonRoot=path.resolve(command,process.platform==='win32'?'..':'../..');
      child.stdout.emit('data',JSON.stringify({pythonVersion:descriptor.pythonVersion,psutilVersion:descriptor.psutilVersion,
        basePrefix:pythonRoot,prefix:pythonRoot,requiredApis:true,processExecutable:command.replace(/^\\\\\?\\/, ''),
        psutilFile:path.join(pythonRoot,'lib/python3.11/site-packages/psutil/__init__.py')}));child.emit('close',0);});
    return child;
  };
  const options=()=>({home,executable,resourcesRoot,descriptorSha256,spawnProbe,
    env:{...process.env,SYNTHETIC_PRIVATE_KEY:'fixture-never-forwarded',PYTHONPATH:'/foreign/user-site',PYTHONHOME:'/foreign/python',NODE_OPTIONS:'--require malicious'}});
  return {root,home,image,descriptor,resourcesRoot,executable,probes,options,save:()=>descriptorSha256=save(),write};
}
test('APP-owned closure is copied outside the APP and uses a private environment without Hermes',async t=>{
  const f=await fixture(t),before=await runtime.inventory(f.image),execution=await runtime.resolve(f.options());
  assert.equal(runtime.isVerified(execution),true);assert.equal(Object.isFrozen(execution),true);
  assert.equal(Object.isFrozen(execution.env),true);
  assert.equal(execution.root,path.join(f.home,'installer/app-helper-runtime',f.descriptor.imageSha256));
  assert.equal(execution.command.startsWith(execution.root+path.sep),true);
  assert.equal(execution.launchCommand,path.toNamespacedPath(execution.command));
  assert.equal(f.probes[0].command,execution.launchCommand);
  assert.equal(fs.existsSync(path.join(f.home,'hermes')),false);
  assert.deepEqual(await runtime.inventory(f.image),before);
  for(const name of ['SYNTHETIC_PRIVATE_KEY','PYTHONPATH','PYTHONHOME','NODE_OPTIONS','NODE_PATH','__PYVENV_LAUNCHER__'])assert.equal(execution.env[name],undefined,name);
  assert.equal(execution.env.PYTHONNOUSERSITE,'1');assert.equal(execution.env.PYTHONSAFEPATH,'1');
  assert.deepEqual(f.probes[0].args.slice(0,3),['-I','-B','-c']);
  assert.equal(runtime.isVerified({...execution}),false,'a copied object is not module-verified execution authority');
  assert.equal((await runtime.resolve(f.options())).command,execution.command);
});
test('APP helper can verify and probe the shipped image without creating a cache or profile',async t=>{
  const f=await fixture(t),before=await runtime.inventory(f.image);
  const execution=await runtime.resolve({...f.options(),materialize:false});
  assert.equal(runtime.isVerified(execution),true);
  assert.equal(execution.materialized,false);
  assert.equal(execution.root,f.image);
  assert.equal(execution.descriptorFile,path.join(f.resourcesRoot,runtime.DESCRIPTOR));
  assert.deepEqual(fs.readdirSync(f.home),[]);
  assert.deepEqual(await runtime.inventory(f.image),before);
  assert.equal(f.probes.length,1);
  assert.deepEqual(f.probes[0].args.slice(0,3),['-I','-B','-c']);
});
test('missing APP descriptor trust and changed image fail before running an interpreter',async t=>{
  const f=await fixture(t);
  await assert.rejects(runtime.resolve({...f.options(),descriptorSha256:undefined}),{code:'APP_HELPER_RUNTIME_UNTRUSTED'});
  f.write(f.descriptor.executable,'changed source');
  await assert.rejects(runtime.resolve(f.options()),{code:'APP_HELPER_RUNTIME_INVALID'});
  assert.equal(f.probes.length,0);
});
test('unknown cached bytes remain in place and cannot become a trusted interpreter',async t=>{
  const f=await fixture(t),execution=await runtime.resolve(f.options());
  fs.writeFileSync(execution.command,'unknown cached program');
  await assert.rejects(runtime.resolve(f.options()),{code:'APP_HELPER_RUNTIME_INVALID'});
  assert.equal(fs.readFileSync(execution.command,'utf8'),'unknown cached program');
  assert.equal(f.probes.length,1);
});
test('unlisted files, executable escape and external links do not broaden the closure',async t=>{
  for(const mutation of ['extra-file','escape-link']){
    const f=await fixture(t);
    if(mutation==='extra-file')f.write('python/lib/python3.11/sitecustomize.py','unknown startup code');
    else{
      const external=path.join(f.root,'external-module');fs.writeFileSync(external,'foreign');
      fs.symlinkSync(external,path.join(f.image,'foreign'),process.platform==='win32'?'file':undefined);
    }
    await assert.rejects(runtime.resolve(f.options()),{code:'APP_HELPER_RUNTIME_INVALID'});assert.equal(f.probes.length,0);
  }
});
test('typed manifest rejects forged digest, unsafe paths and Python startup path injection',async t=>{
  const f=await fixture(t);
  for(const name of ['forged-digest','escape-path','pth']){
    const value=JSON.parse(JSON.stringify(f.descriptor));
    if(name==='forged-digest')value.imageSha256='0'.repeat(64);
    else {value.files[0].path=name==='pth'?'python/lib/site-packages/escape.pth':'../foreign';value.imageSha256=runtime.imageDigest(value);}
    assert.throws(()=>runtime.validateDescriptor(value),{code:'APP_HELPER_RUNTIME_INVALID'});
  }
});
test('a probe loading psutil from outside the verified image is rejected',async t=>{
  const f=await fixture(t);
  const foreign=(command,args,options)=>{
    const child=f.options().spawnProbe(command,args,options),emit=child.stdout.emit.bind(child.stdout);
    child.stdout.emit=(event,bytes)=>{if(event==='data'){const value=JSON.parse(bytes);value.psutilFile=path.join(f.root,'foreign/psutil.py');bytes=JSON.stringify(value);}return emit(event,bytes);};
    return child;
  };
  await assert.rejects(runtime.resolve({...f.options(),spawnProbe:foreign}),{code:'APP_HELPER_RUNTIME_INVALID'});
});
test('an import-only adapter without the required process API proof is rejected',async t=>{
  const f=await fixture(t);
  const incomplete=(command,args,options)=>{
    const child=f.options().spawnProbe(command,args,options),emit=child.stdout.emit.bind(child.stdout);
    child.stdout.emit=(event,bytes)=>{if(event==='data'){const value=JSON.parse(bytes);delete value.requiredApis;bytes=JSON.stringify(value);}return emit(event,bytes);};
    return child;
  };
  await assert.rejects(runtime.resolve({...f.options(),spawnProbe:incomplete}),{code:'APP_HELPER_RUNTIME_INVALID'});
});
test('a read-only probe that never closes returns an explicit unconfirmed result without APP mutation',async t=>{
  const f=await fixture(t),kills=[];let unref=false;
  t.mock.timers.enable({apis:['setTimeout']});
  const stalled=()=>{
    const child=new EventEmitter();child.pid=123;child.stdout=new EventEmitter();child.stderr=new EventEmitter();
    child.kill=signal=>{kills.push(signal||'SIGTERM');return true;};child.unref=()=>{unref=true;};
    queueMicrotask(()=>{t.mock.timers.tick(10000);t.mock.timers.tick(2000);t.mock.timers.tick(1000);});return child;
  };
  await assert.rejects(runtime.resolve({...f.options(),spawnProbe:stalled}),error=>
    error.code==='APP_HELPER_RUNTIME_EXECUTOR_UNCONFIRMED'&&error.probeTerminationConfirmed===false&&error.probePid===123);
  assert.deepEqual(kills,['SIGTERM','SIGKILL']);assert.equal(unref,true);
  assert.equal(fs.existsSync(path.join(f.home,'installer/launcher-update')),false);
  assert.deepEqual(await runtime.inventory(f.image),f.descriptor.files);
});
