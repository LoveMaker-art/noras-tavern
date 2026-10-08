const assert=require('node:assert/strict');
const crypto=require('node:crypto');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const test=require('node:test');
const {findBundledRuntime,initializeHome,relocateTextFiles,sha256File,validateRuntimeLinks}=require('../installer/desktop/runtime');
const componentFixture={componentProbe:'nora-clawchat-check.py',components:{clawchat:{revision:'a'.repeat(40)},liveware:{sha256:'b'.repeat(64)},files:{}}};

test('a skill-copy failure retains its real filesystem error and concrete source/destination metadata',t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'nora-runtime-copy-'));
  try{
    const source=path.join(root,'hermes-agent/skills/apple');fs.mkdirSync(source,{recursive:true});fs.writeFileSync(path.join(source,'SKILL.md'),'fixture');
    const primary=Object.assign(new Error('original copy failure'),{code:'EPERM',syscall:'symlink'});
    t.mock.method(fs,'cpSync',()=>{throw primary;});
    assert.throws(()=>initializeHome(root,{nodeLinks:{}}),error=>{
      assert.equal(error,primary);assert.equal(error.context.operation,'copy-skill');
      assert.equal(error.context.sourceType,'directory');assert.equal(error.context.destinationType,'missing');
      assert.equal(error.context.sourcePathLength,error.context.source.length);assert.equal(error.context.destinationPathLength,error.context.destination.length);
      return true;
    });
  }finally{t.mock.restoreAll();fs.rmSync(root,{recursive:true,force:true});}
});
test('staging text uses the final runtime directory and home initialization preserves existing configuration',()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'nora-runtime-relocate-'));
  try{
    const file=path.join(root,'relocate-me');fs.writeFileSync(file,'@@NORA_HERMES_HOME@@\n@@NORA_PYTHON_HOME@@\n');
    const final=path.join(root,'final');relocateTextFiles(root,{platform:process.platform,venvPython:'hermes-agent/venv/bin/python',relocatableFiles:['relocate-me']},final);
    const normalize=value=>process.platform==='win32'?value.replaceAll('\\','/'):value;
    assert.equal(fs.readFileSync(file,'utf8'),`${normalize(final)}\n${normalize(path.join(final,'python'))}\n`);
    fs.writeFileSync(path.join(root,'.env'),'DUMMY=existing\n');initializeHome(root,{nodeLinks:{}});
    assert.equal(fs.readFileSync(path.join(root,'.env'),'utf8'),'DUMMY=existing\n');
  }finally{fs.rmSync(root,{recursive:true,force:true});}
});
test('bundle lookup validates its platform and component contract without changing the archive',()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'nora-runtime-bundle-'));
  try{
    const archive=path.join(root,'runtime.tar.gz');fs.writeFileSync(archive,'fixture');
    const digest=crypto.createHash('sha256').update('fixture').digest('hex');
    const manifest={...componentFixture,schema:1,platform:process.platform,arch:process.arch,archive:'runtime.tar.gz',sha256:digest};
    fs.writeFileSync(path.join(root,'nora-hermes-runtime.json'),JSON.stringify(manifest));
    assert.equal(findBundledRuntime(root).manifest.sha256,digest);assert.equal(sha256File(archive),digest);
    assert.throws(()=>findBundledRuntime(root,'unsupported'),/不匹配/);
    assert.equal(fs.readFileSync(archive,'utf8'),'fixture');
  }finally{fs.rmSync(root,{recursive:true,force:true});}
});
test('runtime link validation rejects an external directory before the tree can become active',()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'nora-runtime-links-'));
  try{
    const home=path.join(root,'hermes'),outside=path.join(root,'outside');fs.mkdirSync(home);fs.mkdirSync(outside);
    fs.symlinkSync(outside,path.join(home,'escaped'),process.platform==='win32'?'junction':'dir');
    assert.throws(()=>validateRuntimeLinks(home),/目录之外/);
  }finally{fs.rmSync(root,{recursive:true,force:true});}
});
