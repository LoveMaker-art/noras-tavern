import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {createRequire} from 'node:module';
import {packageAppHelperRuntime,packageAppHelperRuntimeFromArchive,stampAppHelperRuntime}
  from '../tooling/release/package-app-helper-runtime.mjs';
import {buildCommand} from '../tooling/release/build-commands.mjs';

const require=createRequire(import.meta.url),runtime=require('../launcher/desktop/app-helper-runtime.js');
const PSUTIL_VERSION='7.0.0';
const sha=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
test('macOS signing seals the APP without rewriting its already sealed helper binaries',()=>{
  const {build}=require('../launcher/desktop/package.json');
  const filter=build.mac.signIgnore.map(pattern=>new RegExp(pattern));
  assert.ok(filter.some(pattern=>pattern.test('/Build/Nora.app/Contents/Resources/app-helper-runtime/python/bin/python3.11')));
  assert.ok(filter.every(pattern=>!pattern.test('/Build/Nora.app/Contents/MacOS/Nora')));
});
function fixture(t,platform='darwin',arch='arm64'){
  const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'nora-app-helper-package-')));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const pythonRoot=path.join(root,'base'),sitePackages=path.join(root,'site-packages'),resourcesRoot=path.join(root,'resources');
  for(const directory of [pythonRoot,sitePackages,resourcesRoot])fs.mkdirSync(directory);
  const write=(base,name,text)=>{const file=path.join(base,name);fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,text);return file;};
  const lib=platform==='win32'?'Lib':'lib/python3.11';
  const executable=write(pythonRoot,platform==='win32'?'python.exe':'bin/python3.11','synthetic CPython executable; never run');
  fs.chmodSync(executable,0o755);
  if(platform!=='win32')fs.symlinkSync('python3.11',path.join(pythonRoot,'bin/python3'));
  write(pythonRoot,lib+'/os.py','synthetic standard library');write(pythonRoot,'LICENSE','CPython license');
  write(pythonRoot,lib+'/site-packages/hermes_cli/__init__.py','unrelated Hermes business package');
  write(pythonRoot,lib+'/sitecustomize.py','unrelated Python injection');
  write(pythonRoot,lib+'/active.pth','unrelated Python injection');
  write(sitePackages,'psutil/__init__.py',`__version__ = '${PSUTIL_VERSION}'\n`);
  write(sitePackages,'psutil/'+(platform==='win32'?'_psutil_windows.cp311-win_amd64.pyd':'_psutil_osx.abi3.so'),'synthetic platform extension; never run');
  write(sitePackages,`psutil-${PSUTIL_VERSION}.dist-info/METADATA`,`Name: psutil\nVersion: ${PSUTIL_VERSION}\nLicense-File: LICENSE\n`);
  write(sitePackages,`psutil-${PSUTIL_VERSION}.dist-info/LICENSE`,'psutil BSD license');
  write(sitePackages,`psutil-${PSUTIL_VERSION}.dist-info/direct_url.json`,'{"url":"file:///private/synthetic-build-source"}');
  write(sitePackages,'psutil/tests/test_fixture.py','unneeded distribution tests');
  write(sitePackages,'hermes_cli/__init__.py','unrelated business package');
  return {root,pythonRoot,sitePackages,resourcesRoot,platform,arch,pythonVersion:'3.11.9',write};
}
for(const [platform,arch] of [['darwin','arm64'],['darwin','x64'],['win32','x64']])
  test(`${platform}-${arch}: only CPython and locked psutil enter the APP resources`,async t=>{
    const f=fixture(t,platform,arch),result=await packageAppHelperRuntime(f);
    assert.equal(runtime.validateDescriptor(result.descriptor,{platform,arch}),result.descriptor);
    assert.deepEqual(await runtime.inventory(result.image),result.descriptor.files);
    assert.equal(sha(fs.readFileSync(result.descriptorFile)),result.descriptorSha256);
    assert.equal(result.descriptor.psutilVersion,PSUTIL_VERSION);
    assert.ok(result.descriptor.files.some(file=>file.path.endsWith('LICENSE')));
    assert.ok(result.descriptor.files.every(file=>!file.path.includes('hermes_cli')&&!file.path.endsWith('.pth')
      &&!file.path.includes('sitecustomize')&&!file.path.endsWith('direct_url.json')&&!file.path.includes('/tests/')));
    const packageFile=f.write(f.root,'package.json',JSON.stringify({name:'fixture',build:{files:['main.js']}}));
    stampAppHelperRuntime(packageFile,result);
    assert.equal(JSON.parse(fs.readFileSync(packageFile)).noraAppHelperRuntimeSha256,result.descriptorSha256);
    fs.appendFileSync(result.descriptorFile,' ');
    assert.throws(()=>stampAppHelperRuntime(packageFile,result),{code:'APP_HELPER_BUILD_INPUT_INVALID'});
  });

test('missing, unlocked or externally redirected source inputs are refused',async t=>{
  const f=fixture(t);
  await assert.rejects(packageAppHelperRuntime({...f,pythonRoot:undefined}),{code:'APP_HELPER_BUILD_INPUT_INVALID'});
  fs.writeFileSync(path.join(f.sitePackages,`psutil-${PSUTIL_VERSION}.dist-info/METADATA`),'Name: psutil\nVersion: 9.9.9\n');
  await assert.rejects(packageAppHelperRuntime(f),/versions? disagree/);
  fs.writeFileSync(path.join(f.sitePackages,`psutil-${PSUTIL_VERSION}.dist-info/METADATA`),`Name: psutil\nVersion: ${PSUTIL_VERSION}\n`);
  fs.symlinkSync('../../site-packages/psutil/__init__.py',path.join(f.pythonRoot,'bin/python'));
  await assert.rejects(packageAppHelperRuntime(f),/link escapes/);
  assert.equal(fs.existsSync(path.join(f.resourcesRoot,'app-helper-runtime')),false);
});

function archiveFixture(f,format='tar.gz'){
  const stage=path.join(f.root,'archive-source'),base=path.join(stage,'hermes-runtime');fs.mkdirSync(base,{recursive:true});
  fs.cpSync(f.pythonRoot,path.join(base,'python'),{recursive:true,dereference:false,verbatimSymlinks:true});
  const packages=path.join(base,'hermes-agent/venv',f.platform==='win32'?'Lib/site-packages':'lib/python3.11/site-packages');
  fs.cpSync(f.sitePackages,packages,{recursive:true,dereference:false,verbatimSymlinks:true});
  f.write(base,'config.yaml','synthetic current personal configuration; never selected');
  f.write(base,'sessions/story.json','synthetic current story; never selected');
  const archive=path.join(f.root,'verified-runtime.'+format);
  const command=format==='zip'?buildCommand('zip',['-qry',archive,'hermes-runtime'])
    :buildCommand('tar',['-czf',archive,'-C',stage,'hermes-runtime']);
  execFileSync(command.command,command.args,{cwd:stage});
  const bytes=fs.readFileSync(archive);
  return {archive,manifest:{schema:1,platform:f.platform,arch:f.arch,format,archive:path.basename(archive),
    pythonVersion:f.pythonVersion,sha256:sha(bytes),size:bytes.length}};
}

test('a verified runtime archive yields the same selected closure without extracting Hermes or user data',async t=>{
  const f=fixture(t),input=archiveFixture(f);
  const result=await packageAppHelperRuntimeFromArchive({...input,resourcesRoot:f.resourcesRoot,platform:f.platform,arch:f.arch});
  assert.ok(result.descriptor.files.every(file=>file.path.startsWith('python/')));
  assert.equal(fs.existsSync(path.join(f.resourcesRoot,'hermes-agent')),false);
  assert.equal(fs.existsSync(path.join(f.resourcesRoot,'config.yaml')),false);
  assert.equal(fs.existsSync(path.join(f.resourcesRoot,'sessions')),false);
  assert.equal(fs.existsSync(path.join(result.image,'python/lib/python3.11/site-packages/psutil/__init__.py')),true);
});

test('the existing Windows ZIP runtime layout supplies its private interpreter and psutil extension',async t=>{
  const f=fixture(t,'win32','x64'),input=archiveFixture(f,'zip');
  const result=await packageAppHelperRuntimeFromArchive({...input,resourcesRoot:f.resourcesRoot,platform:f.platform,arch:f.arch});
  assert.equal(result.descriptor.executable,'python/python.exe');
  assert.ok(result.descriptor.files.some(file=>file.path.endsWith('_psutil_windows.cp311-win_amd64.pyd')));
  assert.equal(result.descriptor.platform,'win32');
});

test('an existing helper image is never replaced or merged while constructing another image',async t=>{
  const f=fixture(t),file=f.write(f.resourcesRoot,'app-helper-runtime/preserved.txt','existing helper evidence');
  await assert.rejects(packageAppHelperRuntime(f),/destination already exists/);
  assert.equal(fs.readFileSync(file,'utf8'),'existing helper evidence');
});

test('archive size, digest and target identity are verified before any helper output',async t=>{
  const f=fixture(t),input=archiveFixture(f);
  for(const change of [{size:input.manifest.size+1},{sha256:'a'.repeat(64)},{platform:'win32'},{archive:'../unowned.tar.gz'}])
    await assert.rejects(packageAppHelperRuntimeFromArchive({...input,manifest:{...input.manifest,...change},
      resourcesRoot:f.resourcesRoot,platform:f.platform,arch:f.arch}),{code:'APP_HELPER_BUILD_INPUT_INVALID'});
  assert.deepEqual(fs.readdirSync(f.resourcesRoot),[]);
});

test('a selected archive link cannot escape the private CPython closure',async t=>{
  const f=fixture(t);
  fs.symlinkSync('../../hermes-agent/venv/lib/python3.11/site-packages/psutil/__init__.py',path.join(f.pythonRoot,'bin/python'));
  const input=archiveFixture(f);
  await assert.rejects(packageAppHelperRuntimeFromArchive({...input,resourcesRoot:f.resourcesRoot,platform:f.platform,arch:f.arch}),/link escapes CPython/);
  assert.deepEqual(fs.readdirSync(f.resourcesRoot),[]);
});

test('an immutable source locks its actual exact psutil version rather than the source-test prerequisite',async t=>{
  const f=fixture(t),actual='7.2.1';
  fs.renameSync(path.join(f.sitePackages,`psutil-${PSUTIL_VERSION}.dist-info`),path.join(f.sitePackages,`psutil-${actual}.dist-info`));
  fs.writeFileSync(path.join(f.sitePackages,`psutil-${actual}.dist-info/METADATA`),`Name: psutil\nVersion: ${actual}\n`);
  fs.writeFileSync(path.join(f.sitePackages,'psutil/__init__.py'),`__version__ = '${actual}'\n`);
  const input=archiveFixture(f);
  const result=await packageAppHelperRuntimeFromArchive({...input,resourcesRoot:f.resourcesRoot,platform:f.platform,arch:f.arch});
  assert.equal(result.descriptor.psutilVersion,actual);
  assert.ok(result.descriptor.files.some(file=>file.path.includes(`psutil-${actual}.dist-info/METADATA`)));
});

test('ambiguous distributions and package/metadata version mismatches cannot be sealed',async t=>{
  const f=fixture(t);
  f.write(f.sitePackages,'psutil-7.2.1.dist-info/METADATA','Name: psutil\nVersion: 7.2.1\n');
  await assert.rejects(packageAppHelperRuntime(f),/exactly one psutil/);
  fs.rmSync(path.join(f.sitePackages,'psutil-7.2.1.dist-info'),{recursive:true});
  fs.writeFileSync(path.join(f.sitePackages,'psutil/__init__.py'),"__version__ = '7.2.1'\n");
  await assert.rejects(packageAppHelperRuntime(f),/package and distribution versions disagree/);
  assert.deepEqual(fs.readdirSync(f.resourcesRoot),[]);
});
