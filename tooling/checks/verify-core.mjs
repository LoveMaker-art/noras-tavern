import fs from 'node:fs';import path from 'node:path';import crypto from 'node:crypto';import {fileURLToPath} from 'node:url';import {spawnSync,execFileSync} from 'node:child_process';import {checkCoreTestEnvironment} from './core-test-environment.mjs';
const root=fileURLToPath(new URL('../../',import.meta.url));const {environment,facts}=checkCoreTestEnvironment(root);const native=process.argv.includes('--native');
const deployment=fs.readdirSync(path.join(root,'tests/deployment')).sort();
if(native&&!environment.NORA_TEST_HERMES)throw Error('Native acceptance requires a read-only restored Hermes checkout and its actual NORA_TEST_PYTHON');
const javascript=native?['core_operation_lock']:deployment.filter(name=>name.endsWith('.test.cjs')&&name!=='core_operation_lock.test.cjs').map(name=>name.slice(0,-9));
// This profile qualifies the shared executor with the actual sealed interpreter.
// Optional provider SDK suites have independent dependency/account prerequisites.
const python=native?['test_operation_control']:deployment.filter(name=>/^test_.*\.py$/.test(name)).map(name=>name.slice(0,-3));
const report={schema:'nora-core-source-result/1',commit:execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim(),dirty:Boolean(execFileSync('git',['status','--porcelain'],{cwd:root,encoding:'utf8'}).trim()),facts,inputLockSha256:crypto.createHash('sha256').update(fs.readFileSync(path.join(root,'tooling/maintenance-input.lock.json'))).digest('hex'),runs:[]};
const commands=[['node','--test','--test-concurrency=1',...javascript.map(name=>'tests/deployment/'+name+'.test.cjs')],['python','-B','-m','unittest','-v',...python.map(name=>'tests.deployment.'+name)]];
const evidence=fs.mkdtempSync(path.join(root,'.cache/core-gate-'));
for(const [index,args]of commands.entries()){const record=path.join(evidence,index+'.json');const r=spawnSync(process.execPath,[path.join(root,'tooling/run.mjs'),'--report',record,'--timeout-ms','840000',...args],{cwd:root,env:environment,stdio:'inherit',timeout:860000});report.runs.push({tests:args,status:r.status,signal:r.signal,error:r.error?.code||null,run:fs.existsSync(record)?JSON.parse(fs.readFileSync(record)):null});if(r.error||r.status!==0||r.signal){process.exitCode=1;break;}}
if(report.runs.some(r=>!r.run)||new Set(report.runs.map(r=>r.run?.identity.sourceDigest)).size!==1){report.mixedOrMissingInputs=true;process.exitCode=1;}
report.passed=!process.exitCode;fs.mkdirSync(path.join(root,'.cache'),{recursive:true});fs.writeFileSync(path.join(root,'.cache/core-'+(native?'native':'source')+'-result.json'),JSON.stringify(report,null,2)+'\n');
