import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';

export const windowsGit = JSON.parse(fs.readFileSync(new URL('./windows-git.lock.json',import.meta.url),'utf8'));
const hash=file=>createHash('sha256').update(fs.readFileSync(file)).digest('hex');
export function verifyWindowsGitArchive(file){
    const stat=fs.lstatSync(file);
    assert.ok(stat.isFile()&&!stat.isSymbolicLink()&&stat.size===windowsGit.size,'Portable Git archive size/type differs');
    assert.equal(hash(file),windowsGit.sha256,'Portable Git archive SHA-256 differs');
    return file;
}
export async function windowsGitArchive(directory, supplied){
    if(supplied)return verifyWindowsGitArchive(path.resolve(supplied));
    fs.mkdirSync(directory,{recursive:true});
    const file=path.join(directory,windowsGit.asset);
    if(fs.existsSync(file))return verifyWindowsGitArchive(file);
    const temporary=file+'.'+randomUUID()+'.tmp';
    try{
        const response=await fetch(windowsGit.url,{signal:AbortSignal.timeout(180000)});
        assert.ok(response.ok,'Cannot download the pinned official Portable Git');
        const fd=fs.openSync(temporary,'wx',0o600);let bytes=0;
        try{for await(const chunk of response.body){bytes+=chunk.length;assert.ok(bytes<=windowsGit.size,'Portable Git download exceeds its sealed size');fs.writeSync(fd,chunk);}}
        finally{fs.closeSync(fd);}
        verifyWindowsGitArchive(temporary);fs.renameSync(temporary,file);return file;
    }finally{fs.rmSync(temporary,{force:true});}
}
export function installWindowsGit(archive,runtime,{platform=process.platform,execute=spawnSync}={}){
    assert.equal(platform,'win32','Portable Git is only bundled on Windows');verifyWindowsGitArchive(archive);
    const relative='hermes-agent/vendor/git',destination=path.join(runtime,relative);
    // This is the disposable runtime builder's tree, never an installed home.
    assert.ok(!fs.existsSync(destination),'Portable Git output must be a new build directory');
    fs.mkdirSync(path.dirname(destination),{recursive:true});
    const result=execute(archive,['-y','-o'+destination],{encoding:'utf8',timeout:180000,windowsHide:true});
    assert.equal(result.status,0,'Cannot extract the verified official Portable Git');
    for(const name of ['bin/bash.exe','usr/bin/bash.exe','usr/bin/msys-2.0.dll','cmd/git.exe','LICENSE.txt'])
        assert.ok(fs.statSync(path.join(destination,name)).isFile(),'Portable Git lacks '+name);
    const files={};
    function inventory(directory){for(const entry of fs.readdirSync(directory,{withFileTypes:true})){
        const file=path.join(directory,entry.name);assert.ok(!entry.isSymbolicLink(),'Portable Git has an unexpected symbolic link');
        if(entry.isDirectory())inventory(file);else if(entry.isFile())files[path.relative(runtime,file).split(path.sep).join('/')]=hash(file);
    }}
    inventory(destination);
    return {schema:1,kind:'git-bash',command:relative+'/bin/bash.exe',version:windowsGit.version,
        source:{url:windowsGit.url,sha256:windowsGit.sha256,size:windowsGit.size},files};
}
