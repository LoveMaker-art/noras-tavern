const test=require('node:test'),assert=require('node:assert/strict');
const fs=process.versions.electron?require('original-fs'):require('node:fs');
const path=require('node:path'),os=require('node:os'),crypto=require('node:crypto');
const {createRequire}=require('node:module');
const desktop=process.env.NORA_PACKED_DESKTOP||path.resolve(__dirname,'../installer/desktop');
const digest=file=>crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
function fixture(t){
  const root=fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(),'nora-retained-native-')));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const previous=path.join(root,'previous'),stage=path.join(root,'stage');
  fs.mkdirSync(previous);fs.mkdirSync(stage);
  fs.writeFileSync(path.join(previous,'config.yaml'),'model: retained-test-model\n');
  // Use the same module interface as the real runtime transaction, including
  // its actual Electron filesystem; do not extract private source functions.
  const copy=createRequire(path.join(desktop,'package.json'))('./runtime-retained-data').copyUserData;
  return {previous,stage,copy};
}
test('Electron retained copying and recovery sealing preserve a physical ASAR as one file',
  {skip:!process.versions.electron},t=>{
    const f=fixture(t),resources=process.resourcesPath||path.resolve(path.dirname(process.execPath),process.platform==='darwin'?'../Resources':'resources');
    const archive=process.env.NORA_RETAINED_COPY_ARCHIVE
      ||['app.asar','default_app.asar'].map(name=>path.join(resources,name)).find(file=>fs.existsSync(file));
    assert.ok(archive&&fs.statSync(archive).isFile(),'An actual Electron ASAR input is required');
    const relative='state/old-launcher/app.asar',original=path.join(f.previous,relative);
    fs.mkdirSync(path.dirname(original),{recursive:true});fs.copyFileSync(archive,original);
    const before=digest(original),evidence=f.copy(f.previous,f.stage);
    assert.equal(digest(path.join(f.stage,relative)),before);
    assert.equal(digest(original),before);
    assert.equal(evidence.files,2);
    assert.equal(fs.readFileSync(path.join(f.stage,'config.yaml'),'utf8'),'model: retained-test-model\n');
    const requireDesktop=createRequire(path.join(desktop,'package.json'));
    assert.equal(requireDesktop('./tree-integrity').treeSeal(f.previous).files,2,'ASAR internals are not physical backup files');
    requireDesktop('./runtime').validateRuntimeLinks(f.previous);
  });
test('Windows cache junctions stay in the old tree without privileged recreation; ordinary cache bytes copy',
  {skip:!process.versions.electron||process.platform!=='win32'},t=>{
    const f=fixture(t),relative='AppData/Local/Microsoft/Windows/INetCache';
    const cache=path.join(f.previous,relative),content=path.join(cache,'IE/cache.txt');
    fs.mkdirSync(path.dirname(content),{recursive:true});fs.writeFileSync(content,'original cache bytes');
    const link=path.join(cache,'Content.IE5');fs.symlinkSync(path.dirname(content),link,'junction');
    const target=fs.readlinkSync(link),evidence=f.copy(f.previous,f.stage);
    assert.equal(fs.readFileSync(path.join(f.stage,relative,'IE/cache.txt'),'utf8'),'original cache bytes');
    assert.equal(fs.readFileSync(path.join(f.stage,'config.yaml'),'utf8'),'model: retained-test-model\n');
    assert.equal(fs.existsSync(path.join(f.stage,relative,'Content.IE5')),false,'Do not recreate a Windows cache compatibility link');
    assert.equal(evidence.retainedCacheLinks.length,1);
    assert.ok(fs.lstatSync(link).isSymbolicLink());assert.equal(fs.readlinkSync(link),target);
  });
