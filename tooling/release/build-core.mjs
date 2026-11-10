import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {prepareRuntime} from '../runtime/runtime-inputs.mjs';
import {verifyCoreDirectory,files,json,digest,nativeChecks,qualificationChecks} from './core-assets.mjs';

const root=fileURLToPath(new URL('../../',import.meta.url));
const args=process.argv.slice(2);assert.ok(args.length===2&&args[0]==='--output','Use build-core.mjs --output NEW_DIRECTORY');
const output=path.resolve(args[1]);assert.ok(!fs.existsSync(output),'Preserve the previous accepted core build');
const target=`${process.platform}-${process.arch}`,commit=execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim();
assert.equal(execFileSync('git',['status','--porcelain'],{cwd:root,encoding:'utf8'}).trim(),'','Core delivery requires committed clean source');
const qualification=json(path.join(root,'.cache/core-qualification.json')),source=json(path.join(root,'.cache/core-source-result.json'));
for(const proof of [qualification,source]){assert.equal(proof.passed,true,'Core source gates are not accepted');assert.equal(proof.commit,commit);assert.equal(proof.dirty,false);}
assert.deepEqual(qualification.checks.map(c=>c.name),qualificationChecks);
const runtime=await prepareRuntime({offline:true});
const releaseRoot=path.join(root,'release');fs.mkdirSync(releaseRoot,{recursive:true});const before=new Set(fs.readdirSync(releaseRoot));
execFileSync(process.execPath,[path.join(root,'tooling/release/package-release.mjs'),'--hermes-runtime-manifest',runtime.manifest],{cwd:root,stdio:'inherit'});
const created=fs.readdirSync(releaseRoot).filter(name=>!before.has(name));assert.equal(created.length,1);
const release=path.join(releaseRoot,created[0]);verifyCoreDirectory(release,{commit,target});
fs.mkdirSync(output,{recursive:true});const native=path.join(output,'native-smoke.json');
execFileSync(process.execPath,[path.join(root,'tooling/run.mjs'),'--timeout-ms','900000','node','tests/deployment/core_product_refactor_smoke.cjs','--payload',path.join(release,'core-payload'),'--report',native,'--keep'],{cwd:root,stdio:'inherit',timeout:930000});
const smoke=json(native);
for(const [key,value]of Object.entries(nativeChecks))assert.equal(smoke[key],value,`Unaccepted native outcome: ${key}`);
assert.equal(smoke.releaseManifestSha256,digest(fs.readFileSync(path.join(release,'core-payload/release-manifest.json'))));
// The actual sealed interpreter, rather than the small source-test venv, owns
// Hermes SDK/configuration and native executor acceptance. The fixture is stopped.
const runtimeMetadata=json(runtime.manifest),hermes=path.join(smoke.root,'hermes');
execFileSync(process.execPath,[path.join(root,'tooling/checks/verify-core.mjs'),'--native'],{cwd:root,stdio:'inherit',timeout:930000,env:{...process.env,NORA_TEST_PYTHON:path.join(hermes,runtimeMetadata.venvPython),NORA_TEST_HERMES:path.join(hermes,'hermes-agent')}});
const nativeGate=json(path.join(root,'.cache/core-native-result.json'));assert.equal(nativeGate.passed,true);assert.equal(nativeGate.commit,commit);assert.equal(nativeGate.dirty,false);
fs.copyFileSync(path.join(root,'.cache/core-native-result.json'),path.join(output,'native-actors.json'));
fs.rmSync(smoke.root,{recursive:true,force:true});
const assets=path.join(output,'assets');fs.mkdirSync(assets);
for(const entry of fs.readdirSync(release,{withFileTypes:true}))if(entry.isFile()||entry.name==='system-assets')fs.cpSync(path.join(release,entry.name),path.join(assets,entry.name),{recursive:entry.isDirectory(),errorOnExist:true});
const receipt={schema:'nora-core-platform-acceptance/1',commit,target,qualified:true,sourceGate:{checks:qualification.checks,sourceDigest:source.runs[0].run.identity.sourceDigest},inputs:{maintenance:source.inputLockSha256,runtime:digest(fs.readFileSync(path.join(root,'tooling/runtime/runtime-inputs.lock.json')))},native:{checks:Object.fromEntries(Object.keys(nativeChecks).map(k=>[k,smoke[k]])),actorGatePassed:nativeGate.passed,manifestSha256:smoke.releaseManifestSha256},files:files(assets)};
fs.writeFileSync(path.join(output,'acceptance.json'),JSON.stringify(receipt,null,2)+'\n',{flag:'wx'});console.log(`Accepted core target: ${target}; ${output}`);
