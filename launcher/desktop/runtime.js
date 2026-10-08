const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { launcherError } = require('./launcher-errors');

const RUNTIME_MANIFEST = 'nora-hermes-runtime.json';
const TOKENS = {
  '@@NORA_HERMES_HOME@@': (home) => home,
  '@@NORA_PYTHON_HOME@@': (home) => path.join(home, 'python'),
  '@@NORA_VENV_PYTHON@@': (home, manifest) => path.join(home, manifest.venvPython),
};

function sha256File(file) {
  const hash = crypto.createHash('sha256');
  hash.update(fs.readFileSync(file));
  return hash.digest('hex');
}

function contained(root, relative) {
  const target = path.resolve(root, relative);
  const base = path.resolve(root);
  if (target !== base && !target.startsWith(`${base}${path.sep}`)) {
    throw new Error(`运行时清单包含非法路径：${relative}`);
  }
  return target;
}

function findBundledRuntime(payloadRoot, platform = process.platform, arch = process.arch) {
  const manifestPath = path.join(payloadRoot, RUNTIME_MANIFEST);
  if (!fs.existsSync(manifestPath)) return null;
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  if (manifest.schema !== 1 || manifest.platform !== platform || manifest.arch !== arch) {
    throw launcherError('内置运行时与当前系统或架构不匹配，请下载对应的安装包。',{code:'VERIFICATION_FAILED'});
  }
  if (!manifest.components?.clawchat?.revision || !manifest.components?.liveware?.sha256 ||
      !manifest.components?.files || manifest.componentProbe !== 'nora-clawchat-check.py') {
    throw new Error('安装包缺少完整 ClawChat / Liveware 组件，请使用新版完整安装包。');
  }
  const archive = contained(payloadRoot, manifest.archive);
  if (!fs.existsSync(archive)) throw launcherError('整合包缺少 Hermes 运行时文件。',{code:'ENOENT'});
  return { manifest, manifestPath, archive };
}

function extractionCommand(archive, destination, platform = process.platform, systemRoot = process.env.SystemRoot) {
  // Native bsdtar handles both ZIP and gzip; bypass PowerShell's per-file overhead.
  return {
    file: platform === 'win32' ? path.win32.join(systemRoot || 'C:\\Windows', 'System32', 'tar.exe') : 'tar',
    args: ['-xf', archive, '-C', destination],
  };
}

function commandFailure(message, result, command) {
  return Object.assign(new Error(message, { cause: result.error }), {
    exitCode: result.status, signal: result.signal,
    context: { command, stdout: result.stdout, stderr: result.stderr },
  });
}

function relocateText(text, home, manifest) {
  for (const [token, resolve] of Object.entries(TOKENS)) {
    const native = resolve(home, manifest);
    // Forward slashes also work in Windows Python literals, unlike unescaped C:\\Users.
    text = text.split(token).join(manifest.platform === 'win32' ? native.replaceAll('\\', '/') : native);
  }
  return text;
}

function relocateTextFiles(home, manifest, targetHome=home) {
  for (const relative of manifest.relocatableFiles || []) {
    const target = contained(home, relative);
    if (!fs.existsSync(target)) throw new Error(`运行时缺少可迁移文件：${relative}`);
    const text = relocateText(fs.readFileSync(target, 'utf8'), targetHome, manifest);
    fs.writeFileSync(target, text);
  }
}

function relocateFiles(home, manifest) {
  relocateTextFiles(home,manifest);
  if (manifest.platform === 'win32') {
    // uv's Windows trampoline embeds the build interpreter path. Recreate only
    // venv launchers/config from bundled CPython, retaining all site-packages.
    const basePython = contained(home, 'python/python.exe');
    const venv = path.dirname(path.dirname(contained(home, manifest.venvPython)));
    const rebuilt = spawnSync(basePython, ['-I', '-m', 'venv', '--without-pip', '--copies', venv], {
      encoding: 'utf8', timeout: 60000, windowsHide: true,
    });
    if (rebuilt.error || rebuilt.status !== 0) {
      throw commandFailure(`无法重建 Windows Python 环境：${rebuilt.error?.message || rebuilt.stderr}`, rebuilt, [basePython, '-I', '-m', 'venv', '--without-pip', '--copies', venv]);
    }
    const python = contained(home, manifest.venvPython);
    const result = spawnSync(python, ['-I', '-c', [
      'import sys',
      'from pathlib import Path',
      'from importlib.metadata import distributions',
      'from pip._vendor.distlib.scripts import ScriptMaker',
      'maker = ScriptMaker(None, str(Path(sys.executable).parent))',
      'maker.executable = sys.executable',
      'maker.clobber = True',
      'maker.variants = {""}',
      'for distribution in distributions():',
      '    for entry in distribution.entry_points:',
      '        if entry.group == "console_scripts":',
      '            maker.make(entry.name + " = " + entry.value)',
    ].join('\n')], { encoding: 'utf8', timeout: 60000, windowsHide: true });
    if (result.status !== 0) throw commandFailure(`无法重建 Windows 本地命令入口：${result.stderr || result.error?.message}`, result, [python, '-I', '-c', '<rebuild-console-scripts>']);
  }
}

function initializeHome(home, manifest) {
  for (const relative of ['audio_cache', 'cron', 'hooks', 'image_cache', 'logs', 'memories', 'pairing', 'sessions', 'skills']) {
    fs.mkdirSync(path.join(home, relative), { recursive: true });
  }
  const envFile = path.join(home, '.env');
  const configFile = path.join(home, 'config.yaml');
  if (!fs.existsSync(envFile)) fs.writeFileSync(envFile, '', { mode: 0o600 });
  if (!fs.existsSync(configFile)) fs.writeFileSync(configFile, '{}\n', { mode: 0o600 });

  const sourceSkills = path.join(home, 'hermes-agent', 'skills');
  if (fs.existsSync(sourceSkills)) {
    for (const entry of fs.readdirSync(sourceSkills, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const target = path.join(home, 'skills', entry.name);
      if (!fs.existsSync(target)) {
        const source = path.join(sourceSkills, entry.name);
        try { fs.cpSync(source, target, { recursive: true }); }
        catch (error) {
          const describePath = file => {
            if (typeof file !== 'string') return {type:'unknown',length:0};
            try {
              const info=fs.lstatSync(file);
              return {type:info.isSymbolicLink()?'symbolic-link':info.isDirectory()?'directory':info.isFile()?'file':'other',length:file.length};
            } catch (inspectionError) { return {type:inspectionError.code==='ENOENT'?'missing':'unknown',length:file.length}; }
          };
          const from=describePath(source),to=describePath(target),failed=describePath(error.path);
          error.context = { operation: 'copy-skill', source, destination: target,
            sourceType:from.type,destinationType:to.type,failingPathType:failed.type,
            sourcePathLength:from.length,destinationPathLength:to.length,failingPathLength:failed.length };
          throw error;
        }
      }
    }
  }

  if (process.platform !== 'win32') {
    const bin = path.join(home, '.local', 'bin');
    fs.mkdirSync(bin, { recursive: true });
    const links = manifest.nodeLinks || {};
    for (const [name, relative] of Object.entries(links)) {
      const target = path.join(bin, name);
      fs.rmSync(target, { force: true });
      fs.symlinkSync(path.relative(bin, path.join(home, relative)), target);
    }
  }
}

function validateRuntime(home, manifest) {
  validateRuntimeLinks(home);
  const node = contained(home, path.join(manifest.nodeBin, process.platform === 'win32' ? 'node.exe' : 'node'));
  const npm = contained(home, process.platform === 'win32' ? 'node/node_modules/npm/bin/npm-cli.js' : 'node/lib/node_modules/npm/bin/npm-cli.js');
  const npmCheck = spawnSync(node, [npm, '--version'], { encoding: 'utf8', timeout: 15000, windowsHide: true });
  if (npmCheck.error || npmCheck.status !== 0) throw commandFailure('内置 Node.js / npm 不完整或无法执行。', npmCheck, [node, npm, '--version']);
  const command = contained(home, manifest.probe.command);
  const result = spawnSync(command, manifest.probe.args || ['--version'], {
    encoding: 'utf8',
    timeout: 30000,
    windowsHide: true,
    env: {
      ...process.env,
      HOME: home,
      HERMES_HOME: home,
      PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8',
      PATH: [
        path.dirname(command),
        path.join(home, manifest.nodeBin),
        process.env.PATH || '',
      ].join(path.delimiter),
    },
  });
  if (result.error || result.status !== 0) {
    throw commandFailure(`Hermes 运行时校验失败：${result.error?.message || result.stderr || result.stdout || '未知错误'}`, result, [command, ...(manifest.probe.args || ['--version'])]);
  }
  const check = spawnSync(contained(home, manifest.venvPython), ['-B', contained(home, manifest.componentProbe)], {
    encoding: 'utf8', timeout: 60000, windowsHide: true,
    env: {
      // Do not inherit developer credentials, Python paths, or external Liveware binaries.
      SystemRoot: process.env.SystemRoot || '', WINDIR: process.env.WINDIR || '',
      HOME: home, USERPROFILE: home, HERMES_HOME: home,
      APPDATA: path.join(home, 'appdata'), LOCALAPPDATA: path.join(home, 'localappdata'),
      TMPDIR: home, TMP: home, TEMP: home, XDG_CACHE_HOME: path.join(home, '.cache'),
      PYTHONPATH: path.join(home, 'hermes-agent'), PYTHONDONTWRITEBYTECODE: '1', PYTHONNOUSERSITE: '1',
      PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8',
      PATH: [path.dirname(command), path.join(home, manifest.nodeBin)].join(path.delimiter),
    },
  });
  if (check.error || check.status !== 0) {
    throw commandFailure(`ClawChat / Liveware 离线加载检查失败：${check.error?.message || check.stderr || check.stdout}`, check, [contained(home, manifest.venvPython), '-B', contained(home, manifest.componentProbe)]);
  }
  return (result.stdout || result.stderr || '').trim();
}

function validateRuntimeLinks(home) {
  const base = fs.realpathSync(home);
  const walk = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        const target = fs.realpathSync(file);
        if (target !== base && !target.startsWith(`${base}${path.sep}`)) {
          throw new Error(`运行时链接指向安装目录之外：${path.relative(home, file)}`);
        }
      } else if (entry.isDirectory()) walk(file);
    }
  };
  walk(home);
}

// Production maintenance is asynchronous and every executable belongs to the
// operation guard. Synchronous relocation/validation above are build tools.
async function checkedRun(delegate,command,args,options,message) {
  delegate.assertActive();
  const result=await delegate.run(command,args,{kind:'runtime-helper',windowsHide:true,...options});
  delegate.assertActive();
  if(result.error||result.status!==0)throw commandFailure(`${message}：${result.error?.message||result.stderr||result.stdout||'进程退出但未成功'}`,result,[command,...args]);
  return result;
}
async function extractArchiveAsync(bundle,destination,delegate,onEvent=()=>{}) {
  const spec=extractionCommand(bundle.archive,destination);
  const command=process.platform==='darwin'?'/usr/bin/tar':spec.file;
  try{await checkedRun(delegate,command,spec.args,{purpose:'extract',timeoutMs:600000},'无法释放 Hermes 运行时');return;}
  catch(error){
    if(process.platform!=='win32'||(error.cause?.code||error.code)!=='ENOENT'||bundle.manifest.format!=='zip')throw error;
    onEvent({event:'task',stage_id:'runtime_extract',milestone:0,current:1,total:3,task:'使用 Windows 内置 ZIP 工具释放 Nora 核心'});
    const powershell=path.win32.join(process.env.SystemRoot||'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe');
    const script=["$ErrorActionPreference = 'Stop'",'Add-Type -AssemblyName System.IO.Compression.FileSystem',
      '$archive=$env:NORA_RUNTIME_ARCHIVE','$destination=[System.IO.Path]::GetFullPath($env:NORA_RUNTIME_DESTINATION)',
      '$prefix=$destination.TrimEnd([System.IO.Path]::DirectorySeparatorChar)+[System.IO.Path]::DirectorySeparatorChar',
      '$zip=[System.IO.Compression.ZipFile]::OpenRead($archive)',
      'try { foreach($entry in $zip.Entries){',
      '$target=[System.IO.Path]::GetFullPath([System.IO.Path]::Combine($destination,$entry.FullName))',
      'if(!$target.StartsWith($prefix,[System.StringComparison]::OrdinalIgnoreCase)){throw "ZIP entry escapes extraction directory"}',
      'if((($entry.ExternalAttributes -shr 16) -band 61440) -eq 40960){throw "ZIP symbolic links are not supported"}',
      '} } finally {$zip.Dispose()}',
      '[System.IO.Compression.ZipFile]::ExtractToDirectory($archive,$destination)'].join('\n');
    try{await checkedRun(delegate,powershell,['-NoLogo','-NoProfile','-NonInteractive','-Command',script],
      {purpose:'extract',timeoutMs:600000,env:{...process.env,NORA_RUNTIME_ARCHIVE:bundle.archive,NORA_RUNTIME_DESTINATION:destination}},'无法释放 Hermes 运行时');}
    catch(fallbackError){
      if((fallbackError.cause?.code||fallbackError.code)==='ENOENT'){
        error.userCode='RUNTIME_EXTRACTOR_UNAVAILABLE';
        error.secondaryErrors=[{operation:'fallback-extractor',error:fallbackError}];
        throw error;
      }
      fallbackError.secondaryErrors=[{operation:'native-extractor',error}];throw fallbackError;
    }
  }
}
function runtimePython(home,manifest){return contained(home,manifest.venvPython);}
function pythonOptions(home,manifest){return {purpose:'python',runtimeRoot:home,managedPythonRoot:path.join(home,'python'),
  venvHome:path.dirname(path.dirname(runtimePython(home,manifest)))};}
async function repairRuntimeAsync(home,manifest,delegate){
  if(manifest.platform!=='win32')return;
  const base=contained(home,'python/python.exe'),venv=path.dirname(path.dirname(runtimePython(home,manifest)));
  await checkedRun(delegate,base,['-I','-m','venv','--without-pip','--copies',venv],
    {purpose:'python',runtimeRoot:home,timeoutMs:60000},'无法重建 Windows Python 环境');
  const source=['import sys','from pathlib import Path','from importlib.metadata import distributions',
    'from pip._vendor.distlib.scripts import ScriptMaker','maker = ScriptMaker(None, str(Path(sys.executable).parent))',
    'maker.executable = sys.executable','maker.clobber = True','maker.variants = {""}',
    'for distribution in distributions():','    for entry in distribution.entry_points:',
    '        if entry.group == "console_scripts":','            maker.make(entry.name + " = " + entry.value)'].join('\n');
  await checkedRun(delegate,runtimePython(home,manifest),['-I','-c',source],
    {...pythonOptions(home,manifest),timeoutMs:60000},'无法重建 Windows 本地命令入口');
}
async function validateRuntimeAsync(home,manifest,delegate){
  validateRuntimeLinks(home);
  const node=contained(home,path.join(manifest.nodeBin,process.platform==='win32'?'node.exe':'node'));
  const npm=contained(home,process.platform==='win32'?'node/node_modules/npm/bin/npm-cli.js':'node/lib/node_modules/npm/bin/npm-cli.js');
  await checkedRun(delegate,node,[npm,'--version'],{purpose:'node',runtimeRoot:home,timeoutMs:15000},'内置 Node.js / npm 不完整或无法执行');
  const environment={...process.env,HOME:home,HERMES_HOME:home,PYTHONUTF8:'1',PYTHONIOENCODING:'utf-8',
    PYTHONPATH:path.join(home,'hermes-agent'),PYTHONNOUSERSITE:'1',PYTHONDONTWRITEBYTECODE:'1',
    PATH:[path.dirname(runtimePython(home,manifest)),path.join(home,manifest.nodeBin),process.env.PATH||''].join(path.delimiter)};
  // The console-script Windows trampoline can outlive its handle. Run the real
  // interpreter instead, and keep the component probe completely offline.
  const result=await checkedRun(delegate,runtimePython(home,manifest),['-B','-c',
    'from hermes_cli._startup_fast import print_fast_version_info;print_fast_version_info(check_updates=False)'],
    {...pythonOptions(home,manifest),env:environment,timeoutMs:30000},'Hermes 运行时校验失败');
  await checkedRun(delegate,runtimePython(home,manifest),['-B',contained(home,manifest.componentProbe)],
    {...pythonOptions(home,manifest),timeoutMs:60000,env:{SystemRoot:process.env.SystemRoot||'',WINDIR:process.env.WINDIR||'',
      HOME:home,USERPROFILE:home,HERMES_HOME:home,APPDATA:path.join(home,'appdata'),LOCALAPPDATA:path.join(home,'localappdata'),
      TMPDIR:home,TMP:home,TEMP:home,XDG_CACHE_HOME:path.join(home,'.cache'),PYTHONPATH:path.join(home,'hermes-agent'),
      PYTHONDONTWRITEBYTECODE:'1',PYTHONNOUSERSITE:'1',PYTHONUTF8:'1',PYTHONIOENCODING:'utf-8',
      PATH:[path.dirname(runtimePython(home,manifest)),path.join(home,manifest.nodeBin)].join(path.delimiter)}},'ClawChat / Liveware 离线加载检查失败');
  return (result.stdout||result.stderr||'').trim();
}
function installBundledHermes(options){return require('./runtime-transaction').install(options);}

module.exports = {
  extractionCommand,
  RUNTIME_MANIFEST,
  findBundledRuntime,
  installBundledHermes,
  initializeHome,
  relocateFiles,
  relocateTextFiles,
  extractArchiveAsync,
  repairRuntimeAsync,
  validateRuntimeAsync,
  relocateText,
  sha256File,
  validateRuntime,
  validateRuntimeLinks,
};
