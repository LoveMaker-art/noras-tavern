import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {files,json,qualificationChecks,verifyCoreDirectory} from './core-assets.mjs';
import {copyLegacyDelivery,prepareLegacyInputs} from './legacy-app-delivery.mjs';
import {verifyBatch} from './assemble-core.mjs';

const root=fileURLToPath(new URL('../../',import.meta.url));
const args=process.argv.slice(2);assert.ok(args.length===2&&args[0]==='--output','Use build-core-components.mjs --output NEW_DIRECTORY');
const output=path.resolve(args[1]);assert.ok(!fs.existsSync(output),'Preserve the previous accepted component build');
const commit=execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim();
assert.equal(execFileSync('git',['status','--porcelain'],{cwd:root,encoding:'utf8'}).trim(),'','Core delivery requires committed clean source');
const qualification=json(path.join(root,'.cache/core-qualification.json')),source=json(path.join(root,'.cache/core-source-result.json'));
for(const proof of [qualification,source]){assert.equal(proof.passed,true,'Core source gates are not accepted');assert.equal(proof.commit,commit);assert.equal(proof.dirty,false);}
assert.deepEqual(qualification.checks.map(c=>c.name),qualificationChecks);
const releaseRoot=path.join(root,'release');fs.mkdirSync(releaseRoot,{recursive:true});const before=new Set(fs.readdirSync(releaseRoot));
execFileSync(process.execPath,[path.join(root,'tooling/release/package-release.mjs'),'--components-only'],{cwd:root,stdio:'inherit'});
const created=fs.readdirSync(releaseRoot).filter(name=>!before.has(name));assert.equal(created.length,1);
const release=path.join(releaseRoot,created[0]);
const legacyCache=await prepareLegacyInputs();
copyLegacyDelivery(release,json(path.join(release,'release-manifest.json')),legacyCache);
const built=verifyCoreDirectory(release,{commit,componentsOnly:true});
assert.equal(built.product.sourceDigest,qualification.sourceDigest,'Constructed source differs from the tested snapshot');
fs.mkdirSync(output,{recursive:true});
for(const entry of fs.readdirSync(release,{withFileTypes:true})){
 assert.ok(entry.isFile(),'Component release contains an unexpected directory');
 fs.copyFileSync(path.join(release,entry.name),path.join(output,entry.name),fs.constants.COPYFILE_EXCL);
}
const receipt={schema:'nora-core-components-acceptance/1',commit,qualified:true,
 sourceGate:{checks:qualification.checks,sourceDigest:source.runs[0].run.identity.sourceDigest},
 inputs:{maintenance:source.inputLockSha256},files:files(output)};
fs.writeFileSync(path.join(output,'core-batch-acceptance.json'),JSON.stringify(receipt,null,2)+'\n',{flag:'wx'});
verifyBatch(output,{commit});
console.log(`Accepted core components: ${output}`);
