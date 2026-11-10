import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {checkCoreTestEnvironment} from './core-test-environment.mjs';
import {createReleaseSource} from '../release/release-source.mjs';
const root=fileURLToPath(new URL('../../',import.meta.url));
const {environment,facts}=checkCoreTestEnvironment(root);
function snapshot(){const source=createReleaseSource(root,{candidate:true});try{return source.identity;}finally{fs.rmSync(source.stage,{recursive:true,force:true});}}
const initial=snapshot();
const commands=[
 ['backup-safety',['tooling/checks/verify-backup-safety.mjs']],
 ['repository-and-delivery',['--test','--test-concurrency=1',...fs.readdirSync(path.join(root,'tests')).filter(name=>name.endsWith('.test.mjs')).sort().map(name=>'tests/'+name),...fs.readdirSync(path.join(root,'tests/core')).filter(name=>name.endsWith('.test.mjs')).sort().map(name=>'tests/core/'+name)]],
 ['core-consumers',['tooling/checks/verify-core.mjs']],
 ['tavern-workflows',['tooling/run.mjs','--report',path.join(root,'.cache','core-tavern-'+Date.now()+'.json'),'npm','--prefix','app/engine/sillytavern','run','test:nora']],
];
const record={schema:'nora-core-qualification/1',commit:initial.commit,dirty:initial.dirty,sourceDigest:initial.sourceDigest,facts,checks:[]};
for(const [name,args]of commands){const result=spawnSync(process.execPath,args,{cwd:root,env:environment,stdio:'inherit',timeout:1800000});record.checks.push({name,status:result.status,signal:result.signal,error:result.error?.code||null});if(result.status!==0||result.error||result.signal){process.exitCode=1;break;}}
const final=snapshot();
if(final.commit!==initial.commit||final.dirty!==initial.dirty||final.sourceDigest!==initial.sourceDigest){record.sourceChanged=true;process.exitCode=1;}
if(!process.exitCode){
 const core=JSON.parse(fs.readFileSync(path.join(root,'.cache/core-source-result.json'))),tavern=JSON.parse(fs.readFileSync(commands.at(-1)[1][2]));
 const identities=[...core.runs.map(run=>run.run?.identity),tavern.identity];
 if(identities.some(identity=>identity?.sourceDigest!==initial.sourceDigest||identity?.commit!==initial.commit)){record.mixedInputs=true;process.exitCode=1;}
}
record.passed=!process.exitCode;fs.mkdirSync(path.join(root,'.cache'),{recursive:true});fs.writeFileSync(path.join(root,'.cache/core-qualification.json'),JSON.stringify(record,null,2)+'\n');
