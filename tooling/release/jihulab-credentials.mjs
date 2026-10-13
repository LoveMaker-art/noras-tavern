import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {buildOwnedJihuSource} from './publish-release.mjs';

export function prepareJihuCredentials({temporary,githubEnv,privateToken,sourceRoot}={}) {
    assert.ok(typeof temporary==='string'&&path.isAbsolute(temporary)&&!/[\r\n]/.test(temporary),'RUNNER_TEMP must be an absolute directory');
    const stat=fs.lstatSync(temporary);assert.ok(stat.isDirectory()&&!stat.isSymbolicLink(),'Invalid runner temporary directory');
    assert.ok(typeof githubEnv==='string'&&path.isAbsolute(githubEnv),'GITHUB_ENV is required');
    assert.ok(typeof privateToken==='string'&&privateToken.length>0&&privateToken.length<=16384
        && !/[\s\x00-\x1f\x7f]/.test(privateToken),'Configure a valid JIHULAB_PRIVATE_TOKEN before publishing');
    const source=buildOwnedJihuSource(sourceRoot),root=fs.mkdtempSync(path.join(temporary,'nora-jihulab-'));
    fs.chmodSync(root,0o700);
    const identity=/\/projects\/([1-9][0-9]*)\/packages\/generic\/([^/]+)\/$/.exec(new URL(source.baseUrl).pathname);
    const channel=/^\/(.+)\/-\/raw\/([^/]+)\/$/.exec(new URL(source.channelBaseUrl).pathname);
    const tokenFile=path.join(root,'token'),configPath=path.join(root,'publisher.json');
    try {
        fs.writeFileSync(tokenFile,privateToken+'\n',{flag:'wx',mode:0o600});
        fs.writeFileSync(configPath,JSON.stringify({projectId:Number(identity[1]),projectPath:channel[1],packageName:identity[2],
            branch:channel[2],tokenFile,immutablePolicy:'inventory-single-publisher'})+'\n',{flag:'wx',mode:0o600});
        fs.appendFileSync(githubEnv,`NORA_JIHULAB_UPLOAD_CONFIG=${configPath}\n`);
        return configPath;
    }catch(error){fs.rmSync(root,{recursive:true,force:true});throw error;}
}
export function cleanupJihuCredentials({temporary,configPath}={}) {
    if(!configPath)return;
    assert.ok(temporary&&path.isAbsolute(temporary),'RUNNER_TEMP is required');
    const root=path.dirname(path.resolve(configPath));
    assert.ok(path.basename(configPath)==='publisher.json'&&path.dirname(root)===path.resolve(temporary)
        &&path.basename(root).startsWith('nora-jihulab-'),'Refusing to remove an unrelated credential directory');
    if(fs.existsSync(root))assert.ok(!fs.lstatSync(root).isSymbolicLink(),'Refusing linked credential directory');
    fs.rmSync(root,{recursive:true,force:true});
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
    if(process.argv[2]==='prepare')prepareJihuCredentials({temporary:process.env.RUNNER_TEMP,githubEnv:process.env.GITHUB_ENV,
        privateToken:process.env.NORA_JIHULAB_PRIVATE_TOKEN});
    else if(process.argv[2]==='cleanup')cleanupJihuCredentials({temporary:process.env.RUNNER_TEMP,configPath:process.env.NORA_JIHULAB_UPLOAD_CONFIG});
    else throw Error('Expected prepare or cleanup');
}
