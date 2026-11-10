import fs from 'node:fs';
import path from 'node:path';
import {spawnSync,execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {checkCoreTestEnvironment} from './core-test-environment.mjs';
const root=fileURLToPath(new URL('../../',import.meta.url));
const {environment,facts}=checkCoreTestEnvironment(root);
const commands=[
 ['backup-safety',['tooling/checks/verify-backup-safety.mjs']],
 ['repository-and-delivery',['--test','--test-concurrency=1',...fs.readdirSync(path.join(root,'tests')).filter(name=>name.endsWith('.test.mjs')).sort().map(name=>'tests/'+name),...fs.readdirSync(path.join(root,'tests/core')).filter(name=>name.endsWith('.test.mjs')).sort().map(name=>'tests/core/'+name)]],
 ['core-consumers',['tooling/checks/verify-core.mjs']],
 ['tavern-workflows',['tooling/run.mjs','npm','--prefix','app/engine/sillytavern','run','test:nora']],
];
const record={schema:'nora-core-qualification/1',commit:execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim(),dirty:Boolean(execFileSync('git',['status','--porcelain'],{cwd:root,encoding:'utf8'}).trim()),facts,checks:[]};
for(const [name,args]of commands){const result=spawnSync(process.execPath,args,{cwd:root,env:environment,stdio:'inherit',timeout:1800000});record.checks.push({name,status:result.status,signal:result.signal,error:result.error?.code||null});if(result.status!==0||result.error||result.signal){process.exitCode=1;break;}}
record.passed=!process.exitCode;fs.mkdirSync(path.join(root,'.cache'),{recursive:true});fs.writeFileSync(path.join(root,'.cache/core-qualification.json'),JSON.stringify(record,null,2)+'\n');
