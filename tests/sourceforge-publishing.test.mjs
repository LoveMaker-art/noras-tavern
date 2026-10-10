import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {test} from 'node:test';

const root=path.resolve(import.meta.dirname,'..');
const helper='tooling/release/sourceforge-credentials.mjs';
test('only the independent publication job handles credentials, locks formal channels and always cleans up',()=>{
  for(const file of ['publish-accepted-release.yml']){
    const text=fs.readFileSync(path.join(root,'.github/workflows',file),'utf8');
    assert.match(text,/group: nora-sourceforge-release-channels/,file);
    const prepare=text.indexOf(`node ${helper} prepare`),publish=text.indexOf('node tooling/release/publish-release.mjs',prepare),cleanup=text.indexOf(`node ${helper} cleanup`);
    assert.ok(prepare>=0 && prepare<publish && cleanup>publish,`${file}: credentials must bracket the actual publisher`);
    for(const name of ['SOURCEFORGE_USERNAME','SOURCEFORGE_SSH_PRIVATE_KEY','SOURCEFORGE_KNOWN_HOSTS'])assert.ok(text.includes(name),`${file}: missing ${name}`);
    assert.match(text.slice(publish,cleanup),/if: always\(\)/,`${file}: cleanup must run on failure`);
  }
  for(const file of ['build-integrated-launcher.yml','publish-component-update.yml']){
    const text=fs.readFileSync(path.join(root,'.github/workflows',file),'utf8');
    assert.ok(!text.includes('SOURCEFORGE_SSH_PRIVATE_KEY'),`${file}: build job must not receive publisher secrets`);
  }
});
test('CI credential preparation produces a usable private config and cleanup cannot remove an unrelated directory',t=>{
  const temp=fs.mkdtempSync(path.join(os.tmpdir(),'nora-sf-ci-'));t.after(()=>fs.rmSync(temp,{recursive:true,force:true}));
  const environment=path.join(temp,'github-env'),env={...process.env,RUNNER_TEMP:temp,GITHUB_ENV:environment,NORA_SF_USERNAME:'sorrymakerx',NORA_SF_PRIVATE_KEY:'isolated fixture key',NORA_SF_KNOWN_HOSTS:'frs.sourceforge.net ssh-ed25519 isolated-fixture'};
  const run=(command,overrides={})=>spawnSync(process.execPath,[path.join(root,helper),command],{env:{...env,...overrides},encoding:'utf8'});
  const prepared=run('prepare');assert.equal(prepared.status,0,prepared.stderr);
  const config=fs.readFileSync(environment,'utf8').trim().split('=').slice(1).join('=');
  const value=JSON.parse(fs.readFileSync(config,'utf8'));assert.equal(value.project,'nora-tavern');assert.equal(value.username,'sorrymakerx');
  for(const file of [config,value.identityFile,value.knownHostsFile])assert.equal(fs.statSync(file).mode&0o777,0o600);
  assert.equal(run('cleanup',{NORA_SOURCEFORGE_UPLOAD_CONFIG:config}).status,0);assert.equal(fs.existsSync(path.dirname(config)),false);
  const unrelated=path.join(temp,'keep');fs.mkdirSync(unrelated);fs.writeFileSync(path.join(unrelated,'publisher.json'),'{}');
  assert.notEqual(run('cleanup',{NORA_SOURCEFORGE_UPLOAD_CONFIG:path.join(unrelated,'publisher.json')}).status,0);assert.equal(fs.existsSync(unrelated),true);
});
test('missing credentials fail before publishing a configuration path',t=>{
  const temp=fs.mkdtempSync(path.join(os.tmpdir(),'nora-sf-missing-'));t.after(()=>fs.rmSync(temp,{recursive:true,force:true}));
  const environment=path.join(temp,'github-env');const run=spawnSync(process.execPath,[path.join(root,helper),'prepare'],{env:{...process.env,RUNNER_TEMP:temp,GITHUB_ENV:environment,NORA_SF_USERNAME:'sorrymakerx',NORA_SF_PRIVATE_KEY:'',NORA_SF_KNOWN_HOSTS:''},encoding:'utf8'});
  assert.notEqual(run.status,0);assert.equal(fs.existsSync(environment),false);assert.deepEqual(fs.readdirSync(temp),[]);
});
