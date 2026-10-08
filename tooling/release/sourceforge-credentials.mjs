import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

// Shared by full and component publication. Never print credential contents.
const env=process.env;
const temporary=path.resolve(env.RUNNER_TEMP || '');
assert.ok(env.RUNNER_TEMP && fs.statSync(temporary).isDirectory(),'RUNNER_TEMP is required');
if(process.argv[2]==='prepare'){
    assert.match(env.NORA_SF_USERNAME || '',/^[a-z0-9][a-z0-9-]{2,29}$/,'Configure SOURCEFORGE_USERNAME before publishing');
    assert.ok(env.NORA_SF_PRIVATE_KEY && env.NORA_SF_KNOWN_HOSTS,'Configure the SourceForge upload key and verified host keys before publishing');
    assert.ok(env.GITHUB_ENV,'GITHUB_ENV is required');
    const root=fs.mkdtempSync(path.join(temporary,'nora-sourceforge-'));
    fs.chmodSync(root,0o700);
    const identity=path.join(root,'identity'),hosts=path.join(root,'known_hosts'),config=path.join(root,'publisher.json');
    try {
        fs.writeFileSync(identity,env.NORA_SF_PRIVATE_KEY.trimEnd()+'\n',{mode:0o600});
        fs.writeFileSync(hosts,env.NORA_SF_KNOWN_HOSTS.trimEnd()+'\n',{mode:0o600});
        fs.writeFileSync(config,JSON.stringify({project:'nora-tavern',username:env.NORA_SF_USERNAME,identityFile:identity,knownHostsFile:hosts}),{mode:0o600});
        assert.ok(!/[\r\n]/.test(config),'Invalid runner temporary path');
        fs.appendFileSync(env.GITHUB_ENV,`NORA_SOURCEFORGE_UPLOAD_CONFIG=${config}\n`);
    } catch(error){fs.rmSync(root,{recursive:true,force:true});throw error;}
} else if(process.argv[2]==='cleanup'){
    const config=env.NORA_SOURCEFORGE_UPLOAD_CONFIG;
    if(config){
        const root=path.dirname(path.resolve(config));
        assert.ok(path.basename(config)==='publisher.json' && path.dirname(root)===temporary && path.basename(root).startsWith('nora-sourceforge-'),'Refusing to remove an unrelated directory');
        if(fs.existsSync(root))assert.ok(!fs.lstatSync(root).isSymbolicLink(),'Refusing linked publisher directory');
        fs.rmSync(root,{recursive:true,force:true});
    }
} else {throw Error('Expected prepare or cleanup');}
