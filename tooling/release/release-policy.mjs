// Publication and consumers use the same fixed, verified shared routing policy.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import {materializeMaintenance} from '../maintenance-input.mjs';
const root=fileURLToPath(new URL('../../',import.meta.url));
export function readReleasePolicy(directory=root) {
 const stage=fs.mkdtempSync(path.join(os.tmpdir(),'nora-release-policy-'));
 try {
  const {identity}=materializeMaintenance({directory,stage});
  const base=path.join(stage,'ops/installer/desktop');
  const configuration=JSON.parse(fs.readFileSync(path.join(base,'release-sources.json')));
  const reader=createRequire(import.meta.url)(path.join(base,'release-sources.js'));
  reader.validateSources(configuration);
  return {configuration,reader,identity};
 } finally {fs.rmSync(stage,{recursive:true,force:true});}
}
export function buildOwnedJihuSource(directory=root) {
 const {configuration}=readReleasePolicy(directory);
 const matches=configuration.mirrors.filter(item=>item.provider==='jihulab');
 assert.equal(matches.length,1,'Expected one fixed JihuLab publication source');
 return {...matches[0]};
}
