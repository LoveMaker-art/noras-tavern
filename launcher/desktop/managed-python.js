// Windows venv executables redirect to a second process. Own the real writer.
const fs=require('node:fs');
const path=require('node:path');
const invalid=message=>Object.assign(new Error(message),{code:'LOCK_CHILD_IDENTITY'});

function appHelperDirectoryName(imageSha256,platform=process.platform){
  return platform==='win32'?imageSha256.slice(0,20):imageSha256;
}

function resolveExecution(command,{managedPythonRoot,venvHome,env=process.env}={},platform=process.platform) {
  const environment={...env};
  if(platform!=='win32')return {command,env:environment,executionIdentity:{executable:fs.realpathSync(command)}};
  if(!path.isAbsolute(managedPythonRoot || '') || !path.isAbsolute(venvHome || '') || !path.isAbsolute(command || ''))
    throw invalid('Managed Python and virtual environment paths are required');
  const root=fs.realpathSync(managedPythonRoot),venv=fs.realpathSync(venvHome);
  const virtualExecutable=fs.realpathSync(path.join(venv,'Scripts','python.exe'));
  if(fs.realpathSync(command).toLowerCase()!==virtualExecutable.toLowerCase())
    throw invalid('Python command is not the requested virtual environment');
  const cfg=fs.readFileSync(path.join(venv,'pyvenv.cfg'),'utf8');
  const home=cfg.split(/\r?\n/).map(line=>/^home\s*=\s*(.+)$/i.exec(line.trim())).find(Boolean)?.[1];
  if(!path.isAbsolute(home || '') || fs.realpathSync(home).toLowerCase()!==root.toLowerCase())
    throw invalid('Virtual environment does not belong to managed Python');
  const executable=fs.realpathSync(path.join(root,'python.exe'));
  environment.__PYVENV_LAUNCHER__=virtualExecutable;
  return {command:executable,env:environment,
    executionIdentity:{executable,venvExecutable:virtualExecutable,venvHome:venv,managedPythonRoot:root}};
}
function resolveAppExecution(command,{runtime,directory}={}){
  if(!runtime||!/^[a-f0-9]{64}$/.test(runtime.imageSha256||'')||!/^[a-f0-9]{64}$/.test(runtime.descriptorSha256||'')
    ||!path.isAbsolute(directory||'')||!path.isAbsolute(command||''))throw invalid('APP helper execution identity is missing');
  const base=path.join(fs.realpathSync(directory),'app-helper-runtime');
  const expected=path.join(base,appHelperDirectoryName(runtime.imageSha256));
  const root=fs.realpathSync(runtime.root),pythonRoot=fs.realpathSync(runtime.managedPythonRoot),executable=fs.realpathSync(command);
  const equal=(a,b)=>process.platform==='win32'?a.toLowerCase()===b.toLowerCase():a===b;
  const owned=equal(root,expected)||process.platform==='win32'&&equal(root,path.join(base,runtime.imageSha256));
  if(!owned||!equal(pythonRoot,path.join(root,'python'))||!equal(executable,fs.realpathSync(runtime.command))
    ||!executable.startsWith(pythonRoot+path.sep)||!/^python[\d.]*(?:\.exe)?$/i.test(path.basename(executable)))
    throw invalid('APP helper does not belong to this installation');
  for(const file of [base,root,pythonRoot])if(fs.lstatSync(file).isSymbolicLink())throw invalid('APP helper path is redirected');
  const environment={...runtime.env};
  for(const name of ['PYTHONHOME','PYTHONPATH','__PYVENV_LAUNCHER__','VIRTUAL_ENV','NODE_OPTIONS','NODE_PATH'])delete environment[name];
  environment.PYTHONNOUSERSITE='1';environment.PYTHONDONTWRITEBYTECODE='1';
  return {command:path.toNamespacedPath(executable),env:environment,executionIdentity:{executable,managedPythonRoot:pythonRoot,
    appHelperRuntime:root,imageSha256:runtime.imageSha256,descriptorSha256:runtime.descriptorSha256}};
}
module.exports={resolveExecution,resolveAppExecution,appHelperDirectoryName};
