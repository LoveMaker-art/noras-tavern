const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  modelCredential, normalizeCustomBaseUrl, readVerifiedModel, requireProvider,
  writeVerifiedModel, configurationFingerprint,
} = require('../installer/desktop/model-config');

test('provider selection comes from the installed Hermes catalog, including native custom identities', () => {
  const providers = [{id:'opencode-go',label:'OpenCode Go'}, {id:'custom:existing',custom:true},
    {id:'external-provider',available:false,reason:'请先安装外部依赖。'}];
  assert.equal(requireProvider('opencode-go',providers),providers[0]);
  assert.equal(requireProvider('custom:existing',providers),providers[1]);
  assert.throws(()=>requireProvider('invented',providers),/当前 Hermes 不支持/);
  assert.throws(()=>requireProvider('external-provider',providers),/外部依赖/);
});

test('invalid API keys fail with actionable redacted input errors', () => {
  const {failureResult}=require('../installer/desktop/operation-result');
  for(const key of ['', 'fake-密钥', 'fake-\u0001-key', 'fake-\r\n-key']) {
    assert.throws(()=>modelCredential({id:'api-provider'}, {key}), error=>{
      assert.equal(error.userCode,'MODEL_KEY_INVALID');
      const result=failureResult(error,{action:'model'});
      assert.match(result.error.guidance.title,/API Key/);
      assert.match(result.error.guidance.next,/重新复制/);
      assert.doesNotMatch(JSON.stringify(result),/fake-|ERR_INVALID_CHAR|原因尚未确认/);
      return true;
    });
  }
});

test('native authentication and saved credentials do not require pasting a second API key', () => {
  assert.equal(modelCredential({id:'oauth-provider'}, {authMode:'oauth'}),'');
  assert.equal(modelCredential({id:'sdk-provider',keyless:true}, {authMode:'external'}),'');
  assert.equal(modelCredential({id:'api-provider',authenticated:true}, {}),'');
  assert.equal(modelCredential({id:'custom',custom:true}, {authMode:'none'}),'');
  assert.throws(()=>modelCredential({id:'api-provider'}, {}),/API Key/);
  assert.equal(modelCredential({id:'api-provider',authenticated:true}, {key:'rotated-key'}),'rotated-key');
});

test('custom endpoint syntax validation preserves existing endpoint protection', () => {
  assert.equal(normalizeCustomBaseUrl('https://relay.example/v1///'), 'https://relay.example/v1');
  assert.equal(normalizeCustomBaseUrl('https://relay.example/v1/chat/completions'), 'https://relay.example/v1');
  for(const invalid of ['ftp://relay.example/v1','https://user:pass@relay.example/v1','https://relay.example/v1?key=x','https://relay.example/v1#part'])
    assert.throws(()=>normalizeCustomBaseUrl(invalid));
});

for(const provider of ['deepseek','opencode-go','custom','custom:existing']) test(`${provider} checkpoint supports the native identity without credentials`, t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nora-model-marker-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  writeVerifiedModel(root,{provider,model:'selected-model',key:'must-not-be-written',
    baseUrl:provider.startsWith('custom')?'https://relay.example/v1/':'',authMode:'oauth',
    credentialRef:{provider,authMode:'oauth'},tavernSyncUnsupported:true});
  const serialized=fs.readFileSync(path.join(root,'installer/model.json'),'utf8');
  assert.doesNotMatch(serialized,/must-not-be-written/);
  const saved=readVerifiedModel(root);
  assert.equal(saved.provider,provider);assert.equal(saved.model,'selected-model');
  assert.equal(saved.authMode,'oauth');assert.equal(saved.tavernSyncUnsupported,true);
  assert.deepEqual(saved.credentialRef,{provider,authMode:'oauth'});
});

test('legacy checkpoints remain readable while malformed checkpoints are rejected', t => {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'nora-old-model-marker-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  fs.mkdirSync(path.join(root,'installer'));
  const file=path.join(root,'installer/model.json');
  const old={schema:1,provider:'custom:local-(127.0.0.1:8080)',model:'old-model',baseUrl:'http://127.0.0.1:8080/v1',authMode:'none',credentialSha256:'a'.repeat(64)};
  fs.writeFileSync(file,JSON.stringify(old));assert.deepEqual(readVerifiedModel(root),old);
  for(const value of [{...old,provider:''},{...old,provider:'x\ny'},{...old,model:[]},{...old,baseUrl:'https://user:secret@bad.example'}]) {
    fs.writeFileSync(file,JSON.stringify(value));assert.equal(readVerifiedModel(root),null);
  }
});

test('conditions are secret-keyed per installation and include native authentication mode', () => {
  const input={provider:'opencode-go',model:'fixture',key:'private-fixture',authMode:'key'};
  const first=configurationFingerprint(input,'isolated-installation-identity');
  assert.match(first,/^[a-f0-9]{64}$/);assert.ok(!first.includes(input.key));
  assert.notEqual(first,configurationFingerprint({...input,authMode:'oauth'},'isolated-installation-identity'));
  assert.notEqual(first,configurationFingerprint(input,'another-isolated-installation'));
});
