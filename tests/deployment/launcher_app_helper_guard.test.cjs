const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const os=require('node:os');
const {resolveAppExecution}=require('../installer/desktop/managed-python');

function fixture(t){
  const home=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'nora-app-guard-')));
  t.after(()=>fs.rmSync(home,{recursive:true,force:true}));
  const directory=path.join(home,'installer'),imageSha256='a'.repeat(64),root=path.join(directory,'app-helper-runtime',imageSha256);
  const managedPythonRoot=path.join(root,'python'),command=path.join(managedPythonRoot,process.platform==='win32'?'python.exe':'bin/python3');
  fs.mkdirSync(path.dirname(command),{recursive:true});fs.writeFileSync(command,'isolated non-executed fixture');
  const runtime={root,managedPythonRoot,command,imageSha256,descriptorSha256:'b'.repeat(64),
    env:{PYTHONPATH:'/untrusted/modules',PYTHONHOME:'/untrusted/python',__PYVENV_LAUNCHER__:'/foreign/venv',PATH:'/usr/bin'}};
  return {directory,runtime};
}
test('APP guard binds a direct base interpreter to this home without a core venv',t=>{
  const f=fixture(t),actual=resolveAppExecution(f.runtime.command,f);
  const canonical=fs.realpathSync(f.runtime.command);
  assert.equal(actual.command,path.toNamespacedPath(canonical));
  assert.equal(actual.executionIdentity.executable,canonical);
  assert.equal(actual.executionIdentity.appHelperRuntime,f.runtime.root);
  assert.equal(actual.env.PYTHONPATH,undefined);assert.equal(actual.env.PYTHONHOME,undefined);
  assert.equal(actual.env.__PYVENV_LAUNCHER__,undefined);assert.equal(actual.env.PYTHONNOUSERSITE,'1');
});
test('APP guard refuses another installation and another cached image',t=>{
  const f=fixture(t),other=fixture(t);
  assert.throws(()=>resolveAppExecution(f.runtime.command,{...f,directory:other.directory}),{code:'LOCK_CHILD_IDENTITY'});
  assert.throws(()=>resolveAppExecution(f.runtime.command,{...f,runtime:{...f.runtime,imageSha256:'c'.repeat(64)}}),{code:'LOCK_CHILD_IDENTITY'});
  assert.throws(()=>resolveAppExecution(f.runtime.command,{...f,runtime:{...f.runtime,descriptorSha256:'invalid'}}),{code:'LOCK_CHILD_IDENTITY'});
});
test('APP guard cannot use an executable outside its verified Python root',t=>{
  const f=fixture(t),outside=path.join(f.directory,'python3');fs.writeFileSync(outside,'foreign');
  assert.throws(()=>resolveAppExecution(outside,{...f,runtime:{...f.runtime,command:outside}}),{code:'LOCK_CHILD_IDENTITY'});
});
