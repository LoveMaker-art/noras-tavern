import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import {buildCommand} from './build-commands.mjs';

const require=createRequire(import.meta.url);
const tools=require('../../launcher/desktop/app-helper-runtime.js');
const targets=new Set(['darwin-arm64','darwin-x64','win32-x64']);
const digest=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
const fail=message=>Object.assign(new Error(message),{code:'APP_HELPER_BUILD_INPUT_INVALID'});
const inside=(root,file)=>file===root||file.startsWith(root+path.sep);
const relativeName=name=>typeof name==='string'&&name.length>0&&name.length<1024&&!name.includes('\\')
  &&!name.includes('\0')&&!path.posix.isAbsolute(name)&&!name.split('/').some(part=>!part||part==='.'||part==='..'||part.includes(':'));
function directory(input,label){
  if(typeof input!=='string'||!path.isAbsolute(input))throw fail(`${label} must be an explicit absolute directory`);
  let stat;try{stat=fs.lstatSync(input);}catch{throw fail(`${label} is missing or unreadable`);}
  if(!stat.isDirectory()||stat.isSymbolicLink())throw fail(`${label} must be a regular directory`);
  return fs.realpathSync(input);
}
const finiteVersion=value=>typeof value==='string'&&value.length<=32&&/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/.test(value);
function version(value){if(!finiteVersion(value)||!value.startsWith('3.'))throw fail('An exact verified CPython version is required');return value;}
function target(platform,arch){if(!targets.has(`${platform}-${arch}`))throw fail('Unsupported APP helper platform or architecture');}
const excluded=relative=>relative.split('/').some(part=>['__pycache__','site-packages','dist-packages','.git','.env','tests','test','turtledemo'].includes(part)
  ||part==='pyvenv.cfg'||part.endsWith('.pth')||/^(?:sitecustomize|usercustomize)\.pyc?$/.test(part)||/\.py[co]$/.test(part));
function baseMember(relative,platform){
  if(excluded(relative))return false;
  const first=relative.split('/')[0];
  return platform==='win32'?['Lib','DLLs'].includes(first)||/^(?:python\.exe|python[\w.-]*\.dll|vcruntime[\w.-]*\.dll|LICENSE[\w.-]*|COPYING[\w.-]*)$/i.test(first)
    :relative==='bin'||/^bin\/python(?:3(?:\.\d+)?)?$/.test(relative)||['lib','licenses'].includes(first)||relative==='share'||relative.startsWith('share/licenses/')
      ||relative==='share/licenses'||/^(?:LICENSE|COPYING)[\w.-]*$/i.test(first);
}
function copySelected(source,targetRoot,allowed){
  const sourceRoot=directory(source,'Verified input'),before=fs.statSync(sourceRoot);
  const walk=(base,relative='')=>{
    for(const entry of fs.readdirSync(base,{withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name))){
      const name=relative?relative+'/'+entry.name:entry.name;
      if(!relativeName(name))throw fail('Unsafe helper source path');
      if(!allowed(name))continue;
      const from=path.join(base,entry.name),to=path.join(targetRoot,...name.split('/')),stat=fs.lstatSync(from);
      if(stat.isDirectory()){fs.mkdirSync(to,{recursive:true,mode:0o755});walk(from,name);}
      else if(stat.isFile()){
        fs.mkdirSync(path.dirname(to),{recursive:true});fs.copyFileSync(from,to);fs.chmodSync(to,stat.mode&0o777);
        const after=fs.lstatSync(from);
        if(after.dev!==stat.dev||after.ino!==stat.ino||after.size!==stat.size||after.mtimeMs!==stat.mtimeMs)
          throw fail('Helper input changed while copying');
      }else if(stat.isSymbolicLink()){
        const resolved=fs.realpathSync(from);if(!inside(sourceRoot,resolved))throw fail('Helper source link escapes its verified input');
        const selected=path.relative(sourceRoot,resolved).split(path.sep).join('/');
        if(!selected||!allowed(selected))throw fail('Helper source link targets an excluded dependency');
        fs.mkdirSync(path.dirname(to),{recursive:true});
        const destination=path.join(targetRoot,...selected.split('/'));
        fs.symlinkSync(path.relative(path.dirname(to),destination),to,fs.statSync(resolved).isDirectory()?'dir':'file');
      }else throw fail('Unsupported helper source file type');
    }
  };
  walk(sourceRoot);
  const after=fs.statSync(sourceRoot);if(after.dev!==before.dev||after.ino!==before.ino)throw fail('Helper source directory changed');
}
function psutilInput(sitePackages){
  const root=directory(sitePackages,'Verified psutil site-packages');
  const distributions=fs.readdirSync(root).filter(name=>/^psutil-.*\.dist-info$/i.test(name));
  if(distributions.length!==1)throw fail('Verified runtime must contain exactly one psutil distribution');
  const distribution=distributions[0],psutilVersion=/^psutil-(.+)\.dist-info$/.exec(distribution)?.[1];
  if(!finiteVersion(psutilVersion))throw fail('psutil must have one exact stable version');
  directory(path.join(root,distribution),'Locked psutil distribution');
  const metadata=path.join(root,distribution,'METADATA');
  const stat=fs.lstatSync(metadata);if(!stat.isFile()||stat.isSymbolicLink()||stat.size>1024*1024)throw fail('Missing locked psutil metadata');
  const text=fs.readFileSync(metadata,'utf8');
  const names=[...text.matchAll(/^Name:[ \t]*([^\r\n]+)$/gm)].map(match=>match[1].trim());
  const versions=[...text.matchAll(/^Version:[ \t]*([^\r\n]+)$/gm)].map(match=>match[1].trim());
  if(names.length!==1||names[0].toLowerCase()!=='psutil'||versions.length!==1||versions[0]!==psutilVersion)
    throw fail('psutil distribution directory and METADATA version disagree');
  directory(path.join(root,'psutil'),'Locked psutil package');
  const init=path.join(root,'psutil/__init__.py'),initStat=fs.lstatSync(init);
  if(!initStat.isFile()||initStat.isSymbolicLink()||initStat.size>1024*1024)throw fail('Missing psutil package version');
  const code=fs.readFileSync(init,'utf8'),declared=[...code.matchAll(/^__version__[ \t]*=[ \t]*['"]([^'"\r\n]+)['"]/gm)];
  if(declared.length!==1||declared[0][1]!==psutilVersion)throw fail('psutil package and distribution versions disagree');
  return {root,psutilVersion,distribution};
}
function psutilMember(name,distribution){
  const parts=name.split('/'),first=parts[0];
  if(parts.some(part=>['__pycache__','test','tests'].includes(part)||/\.py[co]$/.test(part)
    ||part.endsWith('.pth')||/^(?:sitecustomize|usercustomize)\.pyc?$/.test(part)))return false;
  if(first==='psutil'||first==='psutil.libs')return true;
  if(first!==distribution)return false;
  // Import metadata and notices are sufficient. Installer receipts and local
  // direct_url records are not an APP runtime dependency or public provenance.
  return parts.length===1||['METADATA','WHEEL'].includes(parts[1])||/^(?:LICENSE|COPYING|AUTHORS)/i.test(parts[1])
    ||['licenses','license_files'].includes(parts[1]);
}

// This constructor never discovers a Python installation or installs packages.
// Its caller supplies explicit verified build inputs; only their selected bytes
// and the fixed psutil package are copied into the APP-owned image.
export async function packageAppHelperRuntime({pythonRoot,sitePackages,resourcesRoot,pythonVersion,platform=process.platform,arch=process.arch}={}){
  target(platform,arch);version(pythonVersion);
  pythonRoot=directory(pythonRoot,'Verified CPython base');const psutil=psutilInput(sitePackages);sitePackages=psutil.root;
  resourcesRoot=directory(resourcesRoot,'APP resources staging');
  if([pythonRoot,sitePackages].some(input=>inside(input,resourcesRoot)||inside(resourcesRoot,input)))
    throw fail('APP resources staging must be separate from its verified inputs');
  const image=path.join(resourcesRoot,'app-helper-runtime'),descriptorFile=path.join(resourcesRoot,tools.DESCRIPTOR);
  if(fs.existsSync(image)||fs.existsSync(descriptorFile))throw fail('APP helper destination already exists');
  const temporary=fs.mkdtempSync(path.join(resourcesRoot,'.app-helper-build-'));
  try{
    const python=path.join(temporary,'python');fs.mkdirSync(python);
    copySelected(pythonRoot,python,name=>baseMember(name,platform));
    const minor=pythonVersion.split('.').slice(0,2).join('.');
    const packages=platform==='win32'?path.join(python,'Lib/site-packages'):path.join(python,'lib',`python${minor}`,'site-packages');
    if(!fs.existsSync(platform==='win32'?path.join(python,'Lib'):path.join(python,'lib',`python${minor}`)))
      throw fail('CPython standard library does not match its exact version');
    fs.mkdirSync(packages,{recursive:true});
    copySelected(sitePackages,packages,name=>psutilMember(name,psutil.distribution));
    const executable=platform==='win32'?'python/python.exe':`python/bin/python${minor}`;
    const candidate=path.join(temporary,...executable.split('/'));
    if(!fs.existsSync(candidate)||!fs.statSync(candidate).isFile())throw fail('Verified CPython input lacks its exact interpreter');
    const files=await tools.inventory(temporary);
    const native=platform==='win32'?/_psutil_windows[^/]*\.pyd$/:/_psutil_osx[^/]*\.so$/;
    if(!files.some(item=>native.test(item.path)))throw fail('Locked psutil lacks the target platform native extension');
    const descriptor={schema:tools.SCHEMA,platform,arch,root:'app-helper-runtime',pythonRoot:'python',executable,
      pythonVersion,psutilVersion:psutil.psutilVersion,files};
    descriptor.imageSha256=tools.imageDigest(descriptor);tools.validateDescriptor(descriptor,{platform,arch});
    const bytes=Buffer.from(JSON.stringify(descriptor,null,2)+'\n');
    if(bytes.length>8*1024*1024)throw fail('APP helper descriptor is too large');
    fs.renameSync(temporary,image);fs.writeFileSync(descriptorFile,bytes,{flag:'wx',mode:0o644});
    return {descriptor,descriptorSha256:digest(bytes),descriptorFile,image};
  }finally{if(fs.existsSync(temporary))fs.rmSync(temporary,{recursive:true,force:true});}
}

function archiveCommand(args){const selected=buildCommand('tar',args);return execFileSync(selected.command,selected.args,{encoding:'utf8',maxBuffer:64*1024*1024,timeout:120000});}
function archiveMembers(archive){
  const names=archiveCommand(['-tf',archive]).split(/\r?\n/).filter(Boolean);
  const details=archiveCommand(['-tvf',archive]).split(/\r?\n/).filter(Boolean);
  if(!names.length||names.length!==details.length||names.length>200000)throw fail('Runtime archive member listing is incomplete');
  const seen=new Set();
  return names.map((raw,index)=>{
    const name=raw.replace(/\/$/,''),key=name.toLowerCase();
    if(!relativeName(name)||!name.startsWith('hermes-runtime/')&&name!=='hermes-runtime'||seen.has(key))
      throw fail('Runtime archive contains unsafe or duplicate paths');
    seen.add(key);return {name,raw,type:details[index][0],detail:details[index]};
  });
}
function selectedMembers(members,platform){
  const selected=[],metadata=[];
  for(const member of members){
    let keep=false;
    if(member.name.startsWith('hermes-runtime/python/')){
      const relative=member.name.slice('hermes-runtime/python/'.length);keep=baseMember(relative,platform);
    }else if(/^hermes-runtime\/hermes-agent\/venv\/(?:lib\/python3\.\d+|Lib)\/site-packages\//.test(member.name)){
      const relative=member.name.split('/site-packages/')[1];
      const first=relative.split('/')[0];
      keep=['psutil','psutil.libs'].includes(first)||/^psutil-.+\.dist-info$/.test(first);
      if(keep&&/^psutil-[^/]+\.dist-info\/METADATA$/.test(relative))metadata.push(member.name);
    }
    if(!keep)continue;
    if(!['-','d','l'].includes(member.type))throw fail('Selected helper archive member has unsupported type');
    if(member.type==='l'){
      const marker=member.detail.lastIndexOf(' -> '),link=marker<0?'':member.detail.slice(marker+4);
      const resolved=path.posix.normalize(path.posix.join(path.posix.dirname(member.name),link));
      if(!link||path.posix.isAbsolute(link)||link.includes('\\')||!resolved.startsWith('hermes-runtime/python/'))
        throw fail('Selected helper archive link escapes CPython');
    }
    selected.push(member);
  }
  if(metadata.length!==1||!selected.some(member=>member.name.startsWith('hermes-runtime/python/')))throw fail('Verified runtime lacks CPython or one exact psutil input');
  const links=selected.filter(member=>member.type==='l').map(member=>member.name+'/');
  if(selected.some(member=>links.some(prefix=>member.name.startsWith(prefix))))throw fail('Archive writes through a selected directory link');
  return {selected,sitePackages:metadata[0].slice(0,metadata[0].lastIndexOf('/psutil-'))};
}

export async function packageAppHelperRuntimeFromArchive({manifest,archive,resourcesRoot,platform=process.platform,arch=process.arch}={}){
  target(platform,arch);
  if(!manifest||manifest.schema!==1||manifest.platform!==platform||manifest.arch!==arch
    ||!['tar.gz','zip'].includes(manifest.format)||!/^[a-f0-9]{64}$/.test(manifest.sha256||'')
    ||!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(manifest.archive||'')
    ||!Number.isSafeInteger(manifest.size)||manifest.size<1)throw fail('Verified same-platform runtime manifest is required');
  if(!path.isAbsolute(archive||''))throw fail('Verified runtime archive must be an explicit absolute path');
  const before=fs.lstatSync(archive);
  if(!before.isFile()||before.isSymbolicLink()||before.size!==manifest.size||digest(fs.readFileSync(archive))!==manifest.sha256)
    throw fail('Runtime archive does not match its verified manifest');
  const {selected,sitePackages}=selectedMembers(archiveMembers(archive),platform);
  const temporary=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'nora-app-helper-input-')));
  try{
    const list=path.join(temporary,'members.txt');fs.writeFileSync(list,selected.filter(item=>item.type!=='d').map(item=>item.raw).join('\n')+'\n');
    archiveCommand(['-xf',archive,'-C',temporary,'--no-recursion','-T',list]);
    const after=fs.lstatSync(archive);
    if(after.dev!==before.dev||after.ino!==before.ino||after.size!==before.size||after.mtimeMs!==before.mtimeMs)
      throw fail('Verified runtime archive changed during extraction');
    const pythonRoot=path.join(temporary,'hermes-runtime/python');
    let pythonVersion=manifest.pythonVersion;
    if(pythonVersion===undefined){
      // Only the selected, hash-verified CPython binary is executed. No site,
      // Hermes, model, pip, PATH discovery, or user profile participates.
      const executable=platform==='win32'?path.join(pythonRoot,'python.exe'):path.join(pythonRoot,'bin/python3');
      const profile=path.join(temporary,'profile');fs.mkdirSync(profile);
      const env={HOME:profile,USERPROFILE:profile,PYTHONDONTWRITEBYTECODE:'1',PYTHONNOUSERSITE:'1'};
      for(const name of ['SystemRoot','WINDIR','LANG','LC_ALL'])if(process.env[name])env[name]=process.env[name];
      try{pythonVersion=execFileSync(executable,['-I','-S','-B','-c','import sys;print(".".join(map(str,sys.version_info[:3])))'],
        {encoding:'utf8',env,cwd:profile,timeout:10000,maxBuffer:8192}).trim();}
      catch(error){throw fail('Verified CPython base cannot report its version without Hermes');}
    }
    return await packageAppHelperRuntime({pythonRoot,sitePackages:path.join(temporary,...sitePackages.split('/')),
      resourcesRoot,pythonVersion,platform,arch});
  }finally{fs.rmSync(temporary,{recursive:true,force:true});}
}

export function stampAppHelperRuntime(packageFile,result){
  if(!/^[a-f0-9]{64}$/.test(result?.descriptorSha256||'')||!result.descriptorFile
    ||digest(fs.readFileSync(result.descriptorFile))!==result.descriptorSha256)
    throw fail('APP helper descriptor must be sealed before stamping its package');
  const desktop=JSON.parse(fs.readFileSync(packageFile,'utf8'));
  desktop.noraAppHelperRuntimeSha256=result.descriptorSha256;
  fs.writeFileSync(packageFile,JSON.stringify(desktop,null,2)+'\n');
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const args=process.argv.slice(2),option=name=>{const i=args.indexOf(name);return i<0?undefined:args[i+1];};
  const resourcesRoot=option('--resources-root'),manifestFile=option('--runtime-manifest');
  const result=manifestFile?await packageAppHelperRuntimeFromArchive({manifest:JSON.parse(fs.readFileSync(manifestFile,'utf8')),
    archive:path.resolve(path.dirname(manifestFile),JSON.parse(fs.readFileSync(manifestFile,'utf8')).archive),resourcesRoot})
    :await packageAppHelperRuntime({pythonRoot:option('--python-root'),sitePackages:option('--site-packages'),
      pythonVersion:option('--python-version'),resourcesRoot});
  if(option('--package-file'))stampAppHelperRuntime(option('--package-file'),result);
  process.stdout.write(JSON.stringify({descriptorSha256:result.descriptorSha256,imageSha256:result.descriptor.imageSha256})+'\n');
}
