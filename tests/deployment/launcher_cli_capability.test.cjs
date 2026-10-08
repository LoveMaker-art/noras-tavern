const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const os=require('node:os');
const {spawnSync}=require('node:child_process');
const capability=require('../installer/desktop/launcher-capability');

function fixture(t){
  const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'nora-cli-capability-')));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const noraHome=path.join(root,'home'),executable=process.platform==='darwin'?path.join(root,'app/Contents/MacOS/Nora'):path.join(root,'app','Nora.exe'),
    resourcesRoot=process.platform==='darwin'?path.join(root,'app/Contents/Resources'):path.join(root,'app','resources');
  fs.mkdirSync(noraHome,{recursive:true});
  function write(file,value='fixture'){fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,value,{mode:0o600});}
  write(executable);write(path.join(resourcesRoot,'app.asar'));
  write(path.join(resourcesRoot,'app.asar.unpacked',`node_modules/fs-native-extensions/prebuilds/${process.platform}-${process.arch}/fs-native-extensions.node`));
  for(const name of capability.RESOURCE_NAMES)write(path.join(resourcesRoot,name));
  const options={noraHome,executable,resourcesRoot,isPackaged:true,launcherVersion:'2.0.2',platform:process.platform,arch:process.arch,port:8799,channel:'stable'};
  return {root,options,write};
}

test('only a packaged, complete APP can register a privately saved CLI receipt',async t=>{
  const f=fixture(t);
  await assert.rejects(capability.register({...f.options,isPackaged:false}),{code:'OPERATION_CAPABILITY_REQUIRED'});
  const receipt=await capability.register(f.options);
  assert.equal(receipt.executorProtocol,'nora-operation-executor/1');
  assert.equal(receipt.noraHome,f.options.noraHome);
  assert.equal(receipt.port,8799);
  assert.equal(receipt.entry,path.join(f.options.resourcesRoot,'app.asar','operation-cli.js'));
  const checked=await capability.validate({receiptPath:capability.receiptPath(f.options.noraHome),noraHome:f.options.noraHome});
  assert.equal(checked.sourceHash,receipt.sourceHash);
});

test('missing or changed native dependency cannot authorize independent writes',async t=>{
  const f=fixture(t),receipt=await capability.register(f.options);
  fs.appendFileSync(receipt.native.path,'changed');
  await assert.rejects(capability.validate({receiptPath:capability.receiptPath(f.options.noraHome),noraHome:f.options.noraHome}),{code:'OPERATION_CAPABILITY_INVALID'});
});

test('physical maintenance delegate is sealed and a changed helper invalidates the receipt in both verifiers',async t=>{
  const f=fixture(t),file=path.join(f.options.resourcesRoot,'operation-delegate.js');f.write(file);
  const receipt=await capability.register(f.options);
  fs.appendFileSync(file,'changed helper');
  await assert.rejects(capability.validate({receiptPath:capability.receiptPath(f.options.noraHome),noraHome:f.options.noraHome}),{code:'OPERATION_CAPABILITY_INVALID'});
  const verifier=path.resolve(__dirname,'../installer/operation_cli.py');
  const source='import importlib.util,sys; s=importlib.util.spec_from_file_location("receipt",sys.argv[1]); m=importlib.util.module_from_spec(s); s.loader.exec_module(m); m.validate_receipt(sys.argv[2])';
  const result=spawnSync(process.env.NORA_PYTHON||'python3',['-B','-c',source,verifier,receipt.noraHome],{encoding:'utf8'});
  assert.notEqual(result.status,0);assert.match(result.stderr,/OperationCliError/);
});

test('changed shared budgets and replacement helpers invalidate the same receipt in JS and Python',async t=>{
  for(const name of ['operation-budget.json','replace-launcher.py']){
    const f=fixture(t),receipt=await capability.register(f.options);
    const resource=receipt.resources[name];assert.ok(resource);
    fs.appendFileSync(resource.path,'changed sealed helper');
    await assert.rejects(capability.validate({receiptPath:capability.receiptPath(f.options.noraHome),noraHome:f.options.noraHome}),{code:'OPERATION_CAPABILITY_INVALID'});
    const verifier=path.resolve(__dirname,'../installer/operation_cli.py');
    const source='import importlib.util,sys; s=importlib.util.spec_from_file_location("receipt",sys.argv[1]); m=importlib.util.module_from_spec(s); s.loader.exec_module(m); m.validate_receipt(sys.argv[2])';
    const result=spawnSync(process.env.NORA_PYTHON||'python3',['-B','-c',source,verifier,receipt.noraHome],{encoding:'utf8'});
    assert.notEqual(result.status,0);assert.match(result.stderr,/OperationCliError/);
  }
});

test('receipt cannot be reused for another installation or an altered APP/resource',async t=>{
  const f=fixture(t),receipt=await capability.register(f.options);
  await assert.rejects(capability.validate({receiptPath:capability.receiptPath(f.options.noraHome),noraHome:path.join(f.root,'other')}),{code:'OPERATION_CAPABILITY_INVALID'});
  fs.appendFileSync(receipt.resources['mcp_probe.mjs'].path,'changed');
  await assert.rejects(capability.validate({receiptPath:capability.receiptPath(f.options.noraHome),noraHome:f.options.noraHome}),{code:'OPERATION_CAPABILITY_INVALID'});
});

test('a linked installer path is rejected before receipt creation',async t=>{
  const f=fixture(t);fs.mkdirSync(path.join(f.root,'outside'));
  fs.symlinkSync(path.join(f.root,'outside'),path.join(f.options.noraHome,'installer'),'dir');
  await assert.rejects(capability.register(f.options),{code:'OPERATION_CAPABILITY_INVALID'});
  assert.equal(fs.existsSync(path.join(f.root,'outside','launcher-control.json')),false);
});

test('only sealed resource or fixed installed-manifest CLI scripts can be routed',async t=>{
  const f=fixture(t),receipt=await capability.register(f.options);
  const bridge=receipt.resources['launcher_bridge.py'].path;
  assert.equal(capability.authorizeTarget(receipt,bridge).type,'bridge');
  assert.equal(capability.authorizeTarget(receipt,receipt.resources['bootstrap.py'].path).type,'install-bootstrap');
  assert.throws(()=>capability.authorizeTarget(receipt,path.join(f.root,'arbitrary.py')),{code:'OPERATION_ENTRY_UNSUPPORTED'});
  assert.throws(()=>capability.authorizeTarget(receipt,'-c'),{code:'OPERATION_ENTRY_UNSUPPORTED'});
  assert.throws(()=>capability.authorizeTarget(receipt,receipt.resources['model_config.py'].path),{code:'OPERATION_ENTRY_UNSUPPORTED'});
});

test('a JS registered receipt passes the real Python verifier and tampering fails closed',async t=>{
  const f=fixture(t),receipt=await capability.register(f.options);
  const verifier=path.resolve(__dirname,'../installer/operation_cli.py');
  const source='import importlib.util,sys,json; s=importlib.util.spec_from_file_location("receipt",sys.argv[1]); m=importlib.util.module_from_spec(s); s.loader.exec_module(m); r=m.validate_receipt(sys.argv[2]); print(json.dumps({"schema":r["schema"],"sourceHash":r["sourceHash"]}))';
  const run=()=>spawnSync(process.env.NORA_PYTHON||'python3',['-B','-c',source,verifier,receipt.noraHome],{encoding:'utf8'});
  const accepted=run();assert.equal(accepted.status,0,accepted.stderr);assert.equal(JSON.parse(accepted.stdout).sourceHash,receipt.sourceHash);
  fs.appendFileSync(receipt.native.path,'tampered');
  const refused=run();assert.notEqual(refused.status,0);assert.match(refused.stderr,/OperationCliError/);
});

test('managed CLI script requires matching installed-manifest hashes and that receipt cannot survive installation changes',async t=>{
  const f=fixture(t),installRoot=path.join(f.options.noraHome,'tavern'),target=path.join(installRoot,'apps/tavern-ops/updater/update.py');
  const sha=require('node:crypto').createHash('sha256').update('trusted updater').digest('hex');
  f.write(target,'trusted updater');
  f.write(path.join(installRoot,'tavern-updates/installed-manifest.json'),JSON.stringify({schema:'tavern-release/v2',commit:'a'.repeat(40),versions:{tavern:'2.4.0'},artifacts:{'ops/updater/update.py':sha}}));
  f.write(path.join(installRoot,'tavern-updates/installed.json'),JSON.stringify({schema:1,version:'2.4.0',commit:'a'.repeat(40)}));
  const receipt=await capability.register(f.options);
  assert.equal(capability.authorizeTarget(receipt,target).type,'update');
  fs.appendFileSync(receipt.installedManifest.path,'\n');
  await assert.rejects(capability.validate({receiptPath:capability.receiptPath(receipt.noraHome),noraHome:receipt.noraHome}),{code:'OPERATION_CAPABILITY_INVALID'});
});
