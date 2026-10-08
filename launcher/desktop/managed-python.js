// Windows venv executables redirect to a second process. Own the real writer.
const fs=require('node:fs');
const path=require('node:path');
const invalid=message=>Object.assign(new Error(message),{code:'LOCK_CHILD_IDENTITY'});

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
module.exports={resolveExecution};
