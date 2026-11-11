import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {targets,files,json,verifyCoreDirectory,nativeChecks,qualificationChecks} from './core-assets.mjs';
import {copyLegacyDelivery,prepareLegacyInputs} from './legacy-app-delivery.mjs';

function verifyAcceptance(proof,target,commit) {
 assert.equal(proof.schema,'nora-core-platform-acceptance/1');assert.equal(proof.commit,commit);assert.equal(proof.target,target);assert.equal(proof.qualified,true);
 assert.deepEqual(proof.native.checks,nativeChecks,'Incomplete native core acceptance');
 assert.equal(proof.native.actorGatePassed,true,'Native Hermes and executor gate did not pass');
 assert.deepEqual(proof.sourceGate.checks.map(c=>c.name),qualificationChecks);
 assert.ok(proof.sourceGate.checks.every(c=>c.status===0&&!c.signal&&!c.error),'Source gate did not pass');
 for(const hash of [proof.sourceGate.sourceDigest,proof.inputs.maintenance,proof.inputs.runtime,proof.native.manifestSha256])assert.match(hash,/^[a-f0-9]{64}$/);
}

function verifyComponentAcceptance(proof,commit) {
 assert.equal(proof.schema,'nora-core-components-acceptance/1');assert.equal(proof.commit,commit);assert.equal(proof.qualified,true);
 assert.deepEqual(proof.sourceGate.checks.map(c=>c.name),qualificationChecks);
 assert.ok(proof.sourceGate.checks.every(c=>c.status===0&&!c.signal&&!c.error),'Source gate did not pass');
 for(const hash of [proof.sourceGate.sourceDigest,proof.inputs.maintenance])assert.match(hash,/^[a-f0-9]{64}$/);
}

export function assembleCore({incoming,output,commit,legacyCache=path.resolve('.cache/legacy-app')}) {
 assert.match(commit,/^[a-f0-9]{40}$/);assert.ok(!fs.existsSync(output),'Do not replace a sealed batch');
 const accepted={};
 for(const target of targets){const directory=path.join(incoming,'core-'+target),receipt=json(path.join(directory,'acceptance.json')),assets=path.join(directory,'assets');
  verifyAcceptance(receipt,target,commit);
  assert.deepEqual(files(assets),receipt.files,'Accepted platform bytes changed');verifyCoreDirectory(assets,{commit,target});
  accepted[target]=receipt;
 }
 assert.ok(targets.every(t=>JSON.stringify(accepted[t].inputs)===JSON.stringify(accepted[targets[0]].inputs)),'Platform fixed inputs differ');
 fs.mkdirSync(output,{recursive:true});
 try {
  const canonical=path.join(incoming,'core-'+targets[0],'assets');
  for(const entry of fs.readdirSync(canonical,{withFileTypes:true}))if(entry.isFile())fs.copyFileSync(path.join(canonical,entry.name),path.join(output,entry.name),fs.constants.COPYFILE_EXCL);
  for(const target of targets){const assets=path.join(incoming,'core-'+target,'assets');
   // Standalone bootstrap bytes must not depend on the construction host.
   for(const name of ['nora-tavern-first-install-bootstrap.py','tavern-updater-bootstrap.py','install-nora-tavern.sh','install-nora-tavern.ps1','install-tavern-updater.sh'])assert.deepEqual(accepted[target].files[name],accepted[targets[0]].files[name],'Platform bootstrap bytes differ');
   for(const name of fs.readdirSync(path.join(assets,'system-assets')))fs.copyFileSync(path.join(assets,'system-assets',name),path.join(output,name),fs.constants.COPYFILE_EXCL);
  }
  copyLegacyDelivery(output,json(path.join(output,'release-manifest.json')),legacyCache);
  verifyCoreDirectory(output,{commit});
  const receipt={schema:'nora-core-batch-acceptance/1',commit,targets:accepted,files:files(output)};
  fs.writeFileSync(path.join(output,'core-batch-acceptance.json'),JSON.stringify(receipt,null,2)+'\n',{flag:'wx'});
  return receipt;
 } catch(error){fs.rmSync(output,{recursive:true,force:true});throw error;}
}
export function verifyBatch(root,{commit}={}) {
 const receipt=json(path.join(root,'core-batch-acceptance.json'));
 const components=receipt.schema==='nora-core-components-acceptance/1';
 if(!components)assert.equal(receipt.schema,'nora-core-batch-acceptance/1');
 if(commit)assert.equal(receipt.commit,commit);
 const actual=files(root);delete actual['core-batch-acceptance.json'];assert.deepEqual(actual,receipt.files,'Accepted batch bytes changed');
 if(components){
  verifyComponentAcceptance(receipt,receipt.commit);
  const checked=verifyCoreDirectory(root,{commit:receipt.commit,componentsOnly:true});
  return {receipt,...checked};
 }
 assert.deepEqual(Object.keys(receipt.targets).sort(),[...targets].sort());
 const checked=verifyCoreDirectory(root,{commit:receipt.commit});
 for(const target of targets){const proof=receipt.targets[target];verifyAcceptance(proof,target,receipt.commit);
  const metadata=checked.files[`${target}-release-manifest.json`];assert.equal(proof.native.manifestSha256,metadata.sha256,'Native acceptance is for different bytes');
  for(const [name,entry]of Object.entries(proof.files))if(name.startsWith('system-assets/'))assert.deepEqual(checked.files[name.slice('system-assets/'.length)],entry,'Platform descriptor closure changed');
 }
 return {receipt,...checked};
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const [incoming,output,commit]=process.argv.slice(2);assert.ok(incoming&&output&&commit);const legacyCache=await prepareLegacyInputs();assembleCore({incoming:path.resolve(incoming),output:path.resolve(output),commit,legacyCache});
}
