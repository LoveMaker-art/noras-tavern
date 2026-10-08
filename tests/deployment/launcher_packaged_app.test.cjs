const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto');
const {spawnSync}=require('node:child_process');
// Explicit artifact inputs: running ordinary source tests cannot certify packaging.
const desktop=process.env.NORA_PACKED_DESKTOP,resources=desktop&&path.dirname(desktop);
const artifactProvided=Boolean(desktop&&process.env.NORA_CANDIDATE_LAUNCHER&&process.env.NORA_TEST_PYTHON);
const cap=artifactProvided&&require(path.join(desktop,'launcher-capability.js')),cli=artifactProvided&&require(path.join(desktop,'operation-cli.js'));
const sha=file=>crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
test('fresh actual APP seals native and all flat CLI resources; JS/Python agree and arbitrary maintenance is refused',{skip:!artifactProvided},async t=>{
 assert.ok(process.versions.electron);assert.equal(process.env.ELECTRON_RUN_AS_NODE,'1');
 const home=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'nora-fresh-app-capability-')));
 t.after(()=>fs.rmSync(home,{recursive:true,force:true}));
 const packaged=JSON.parse(fs.readFileSync(path.join(desktop,'package.json'),'utf8'));
 const receipt=await cap.register({noraHome:home,executable:fs.realpathSync(process.execPath),resourcesRoot:fs.realpathSync(resources),isPackaged:true,launcherVersion:packaged.version,port:19879,channel:'stable'});
 const checked=await cap.validate({receiptPath:cap.receiptPath(home),noraHome:home,currentExecutable:fs.realpathSync(process.execPath)});
 assert.equal(checked.sourceHash,receipt.sourceHash);assert.equal(sha(receipt.native.path),receipt.native.sha256);
 const expectedPackage=JSON.parse(fs.readFileSync(path.join(process.env.NORA_CANDIDATE_LAUNCHER,'desktop/package.json'),'utf8'));
 for(const name of cap.RESOURCE_NAMES){
  const definition=expectedPackage.build.extraResources.find(item=>item.to===name);
  assert.ok(definition&&typeof definition.from==='string',name+' must have an explicit candidate resource mapping');
  const input=path.resolve(process.env.NORA_CANDIDATE_LAUNCHER,'desktop',definition.from);
  const relative=path.relative(path.resolve(process.env.NORA_CANDIDATE_LAUNCHER),input);
  assert.ok(relative&&!relative.startsWith('..'+path.sep)&&!path.isAbsolute(relative),name+' must remain in the exact candidate');
  assert.equal(sha(input),receipt.resources[name].sha256,name+' must use exact candidate resource');
 }
 assert.equal(packaged.version,expectedPackage.version);
 const moduleHashes={};
 for(const name of expectedPackage.build.files){
  assert.equal(fs.existsSync(path.join(desktop,name)),true,name+' ASAR module missing');
  const actual=sha(path.join(desktop,name));
  assert.equal(actual,sha(path.join(process.env.NORA_CANDIDATE_LAUNCHER,'desktop',name)),name+' must use exact candidate module');
  moduleHashes[name]=actual;
 }
 assert.equal(sha(path.join(desktop,'operation-delegate.js')),sha(path.join(resources,'operation-delegate.js')),'ASAR and physical delegate must have the same source');
 const source='import importlib.util,sys,json; s=importlib.util.spec_from_file_location("receipt",sys.argv[1]); m=importlib.util.module_from_spec(s); s.loader.exec_module(m); r=m.validate_receipt(sys.argv[2]); print(json.dumps({"schema":r["schema"],"sourceHash":r["sourceHash"]}))';
 const verified=spawnSync(process.env.NORA_TEST_PYTHON,['-B','-c',source,receipt.resources['operation_cli.py'].path,home],{encoding:'utf8'});
 assert.equal(verified.status,0,verified.stderr);assert.equal(JSON.parse(verified.stdout).sourceHash,receipt.sourceHash);
 await assert.rejects(cli.execute({receiptPath:cap.receiptPath(home),request:{schema:'nora-cli-request/1',kind:'stop',argv:[path.join(home,'arbitrary.py'),'stop'],stdin:''}}),{code:'OPERATION_ENTRY_UNSUPPORTED'});
 assert.equal(fs.existsSync(path.join(home,'installer/operations')),false,'invalid CLI must not begin a maintenance operation');
 const asarFs=require('node:fs');
 const dependencyNames=new Set();
 function collectDependencies(directory){
  if(!asarFs.existsSync(directory))return;
  for(const name of asarFs.readdirSync(directory).filter(x=>!x.startsWith('.'))){
   const item=path.join(directory,name),manifest=path.join(item,'package.json');
   if(!asarFs.existsSync(manifest))continue;
   dependencyNames.add(JSON.parse(asarFs.readFileSync(manifest,'utf8')).name);
   collectDependencies(path.join(item,'node_modules'));
  }
 }
 collectDependencies(path.join(desktop,'node_modules'));
 const actualDeps=[...dependencyNames].sort();
 assert.deepEqual(actualDeps,['bare-addon-resolve','bare-module-resolve','bare-semver','fs-native-extensions','require-addon','semver','which-runtime']);
 const packedLock=require(path.join(desktop,'operation-lock.js'));
 const lease=await packedLock.acquire({directory:path.join(home,'installer'),operationId:crypto.randomUUID(),ownerEpoch:1});
 try{assert.equal((await lease.snapshot()).jobs.length,0);}finally{await lease.release();}
 assert.equal((await packedLock.probe({directory:path.join(home,'installer')})).busy,false,'The real packaged native lock must release');
 const identityFile=path.join(resources,'launcher-update-info.json');
 const identity=fs.existsSync(identityFile)?JSON.parse(fs.readFileSync(identityFile,'utf8')):null;
 const manifest=JSON.parse(fs.readFileSync(path.join(resources,'payload/nora-system.json'),'utf8'));
 if(identity){assert.equal(identity.commit,manifest.commit);assert.equal(identity.version,packaged.version);assert.equal(identity.platform,process.platform);assert.equal(identity.arch,process.arch);}
 const report={schema:'nora-app-candidate-gate/1',candidateLabel:process.env.NORA_CANDIDATE_LABEL||'isolated-artifact-gate',platform:process.platform,arch:process.arch,versions:process.versions,
  executable:receipt.executable,asar:receipt.asar,native:receipt.native,sourceHash:receipt.sourceHash,resources:receipt.resources,moduleHashes,actualProductionDependencies:actualDeps,
  payloadManifestSha256:sha(path.join(resources,'payload/nora-system.json')),packageLockSha256:sha(path.join(process.env.NORA_CANDIDATE_LAUNCHER,'desktop/package-lock.json')),
  assertions:{actualElectron:true,nativeDependencyComplete:true,allFlatResourceHashesMatchCandidate:true,jsPythonReceiptAgree:true,arbitraryCliRefusedBeforeOperation:true},identity};
 if(process.env.NORA_GATE_REPORT)fs.writeFileSync(process.env.NORA_GATE_REPORT,JSON.stringify(report,null,2)+'\n');
});
