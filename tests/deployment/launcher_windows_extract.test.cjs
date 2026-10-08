const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {createRequire} = require('node:module');
const filename = path.join(__dirname,'../installer/desktop/runtime.js');
const realRequire = createRequire(filename);
function extractor(run) {
  const module = {exports:{}};
  const context = vm.createContext({module,exports:module.exports,
    process:{...process,platform:'win32',env:{...process.env,SystemRoot:'D:\\Windows'}},
    require:realRequire});
  vm.runInContext(fs.readFileSync(filename,'utf8'),context);
  const delegate={assertActive(){},run:async (file,args,options)=>{assert.equal(options.kind,'runtime-helper');return run(file,args,options);}};
  return (bundle,destination)=>module.exports.extractArchiveAsync(bundle,destination,delegate);
}
const bundle={archive:'C:\\Users\\测试 用户\\runtime.zip',manifest:{platform:'win32',format:'zip'}};
test('missing Windows tar falls back to system PowerShell without interpolating user paths',async()=>{
  const calls=[];
  await extractor((file,args,options)=>{
    calls.push({file,args,options});
    return calls.length===1?{status:null,error:Object.assign(new Error('tar missing'),{code:'ENOENT'})}:{status:0};
  })(bundle,'C:\\用户目录\\.runtime-123');
  assert.equal(calls.length,2);
  assert.equal(calls[0].file,'D:\\Windows\\System32\\tar.exe');
  assert.equal(calls[1].file,'D:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
  assert.ok(calls[1].args.includes('-NoProfile'));
  assert.match(calls[1].args.at(-1),/ZipFile/);
  assert.equal(calls[1].options.env.NORA_RUNTIME_ARCHIVE,bundle.archive);
  assert.equal(calls[1].options.env.NORA_RUNTIME_DESTINATION,'C:\\用户目录\\.runtime-123');
  assert.doesNotMatch(calls[1].args.join(' '),/测试 用户|用户目录/);
});
test('native extraction succeeds without starting PowerShell',async()=>{
  let calls=0;await extractor(()=>{calls++;return {status:0};})(bundle,'destination');assert.equal(calls,1);
});
test('corruption, access errors and timeout do not retry with another extractor',async()=>{
  for(const result of [{status:2,stderr:'corrupt zip'},
    {status:null,error:Object.assign(new Error('denied'),{code:'EACCES'})},
    {status:null,error:Object.assign(new Error('timeout'),{code:'ETIMEDOUT'})}]){
    let calls=0;
    await assert.rejects(()=>extractor(()=>{calls++;return result;})(bundle,'destination'),/无法释放/);
    assert.equal(calls,1);
  }
});
test('failed fallback preserves native and fallback causes with actionable guidance',async()=>{
  let calls=0;
  await assert.rejects(()=>extractor(()=>{calls++;return {status:null,error:Object.assign(new Error('missing'),{code:'ENOENT'})};})(bundle,'destination'),error=>{
    assert.equal(calls,2);
    assert.equal(error.userCode,'RUNTIME_EXTRACTOR_UNAVAILABLE');
    assert.equal(error.cause.code,'ENOENT');
    assert.equal(error.secondaryErrors[0].error.cause.code,'ENOENT');
    return true;
  });
});
test('a non-ZIP archive cannot enter the Windows ZIP fallback',async()=>{
  let calls=0;
  await assert.rejects(()=>extractor(()=>{calls++;return {status:null,error:Object.assign(new Error('missing'),{code:'ENOENT'})};})
    ({...bundle,manifest:{platform:'win32',format:'tar.gz'}},'destination'),/无法释放/);
  assert.equal(calls,1);
});
