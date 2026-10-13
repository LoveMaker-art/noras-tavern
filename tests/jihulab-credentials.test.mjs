import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {test} from 'node:test';
import {prepareJihuCredentials,cleanupJihuCredentials} from '../tooling/release/jihulab-credentials.mjs';
function fixture(t){const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'nora-jihu-credentials-test-'));
    t.after(()=>fs.rmSync(temporary,{recursive:true,force:true}));const githubEnv=path.join(temporary,'github-env');fs.writeFileSync(githubEnv,'');return {temporary,githubEnv};}
test('CI credentials expose only a protected configuration path and remove only their owned files',t=>{
    const f=fixture(t),secret='fake-private-test-token',configPath=prepareJihuCredentials({...f,privateToken:secret});
    const config=JSON.parse(fs.readFileSync(configPath)),exposed=fs.readFileSync(f.githubEnv,'utf8');
    assert.equal(config.projectId,378185);assert.equal(config.projectPath,'LoveMaker-art/nora-tavern');
    assert.equal(config.immutablePolicy,'inventory-single-publisher');assert.equal(fs.statSync(configPath).mode&0o777,0o600);
    assert.equal(fs.statSync(config.tokenFile).mode&0o777,0o600);assert.equal(fs.statSync(path.dirname(configPath)).mode&0o777,0o700);
    assert.ok(!exposed.includes(secret));assert.ok(!fs.readFileSync(configPath,'utf8').includes(secret));
    cleanupJihuCredentials({temporary:f.temporary,configPath});assert.equal(fs.existsSync(path.dirname(configPath)),false);
});
test('missing or malformed secret fails before any credential directory is created',t=>{
    const f=fixture(t),before=fs.readdirSync(f.temporary);
    for(const privateToken of [undefined,'','secret\nline',' secret'])
        assert.throws(()=>prepareJihuCredentials({...f,privateToken}),/JIHULAB_PRIVATE_TOKEN/);
    assert.deepEqual(fs.readdirSync(f.temporary),before);
});
test('cleanup cannot remove another directory or follow a linked credential root',t=>{
    const f=fixture(t),outside=path.join(f.temporary,'other');fs.mkdirSync(outside);
    assert.throws(()=>cleanupJihuCredentials({temporary:f.temporary,configPath:path.join(outside,'publisher.json')}),/unrelated/);
    const link=path.join(f.temporary,'nora-jihulab-linked');fs.symlinkSync(outside,link);
    assert.throws(()=>cleanupJihuCredentials({temporary:f.temporary,configPath:path.join(link,'publisher.json')}),/linked/);
    assert.ok(fs.existsSync(outside));
});
