import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import path from 'node:path';import {execFileSync} from 'node:child_process';import {fileURLToPath} from 'node:url';
import {createReleaseSource,verifyUpdaterDependencies,assertNoraSystemArtifacts} from '../../tooling/release/release-source.mjs';
const root=fileURLToPath(new URL('../../',import.meta.url));
test('core checkout has no desktop author tree and no Electron dependency',()=>{assert.equal(fs.existsSync(path.join(root,'launcher')),false);const pkg=JSON.parse(fs.readFileSync(path.join(root,'package.json')));for(const name of Object.keys({...pkg.dependencies,...pkg.devDependencies}))assert.doesNotMatch(name,/electron|playwright/i);const files=execFileSync('git',['ls-files','--cached','--others','--exclude-standard','-z'],{cwd:root,encoding:'utf8'}).split('\0').filter(f=>f&&fs.existsSync(path.join(root,f)));assert.equal(files.some(f=>f.startsWith('launcher/')),false);assert.equal(files.some(f=>/\.github\/workflows\/.*launcher/.test(f)),false);assert.equal(files.some(f=>f.startsWith('docs/')&&/launcher/i.test(path.basename(f))),false);});
test('core source projection joins its fixed execution input without acquiring a GUI',t=>{const v=createReleaseSource(root,{candidate:true});t.after(()=>fs.rmSync(v.stage,{recursive:true,force:true}));assert.ok(v.identity.externalInputs.maintenance);assert.equal(Object.keys(v.identity.sourceFiles).some(f=>f.startsWith('launcher/')),false);assert.equal(fs.existsSync(path.join(v.stage,'ops/installer/desktop/main.js')),false);assert.equal(fs.existsSync(path.join(v.stage,'ops/installer/desktop/package.json')),false);assertNoraSystemArtifacts(v.files);const receipt=verifyUpdaterDependencies(v.stage);assert.equal(receipt.dependencies['fs-native-extensions'],'1.5.1');assert.equal(fs.existsSync(path.join(v.stage,'ops/updater/actor-dependencies/node_modules/electron')),false);});

test('external input identity comes from the same source snapshot when the worktree lock changes',t=>{
 const pinFile=path.join(root,'tooling/maintenance-input.lock.json'),original=fs.readFileSync;let reads=0;
 const captured=JSON.parse(original(pinFile));const changed={...captured,author:{...captured.author,commit:'b'.repeat(40)}};
 fs.readFileSync=function(file,...args){if(path.resolve(String(file))===pinFile&&++reads>1)return Buffer.from(JSON.stringify(changed));return original.call(this,file,...args);};
 let view;try{view=createReleaseSource(root,{candidate:true});}finally{fs.readFileSync=original;}
 t.after(()=>fs.rmSync(view.stage,{recursive:true,force:true}));
 assert.equal(view.identity.externalInputs.maintenance.author.commit,captured.author.commit);
 assert.equal(view.identity.externalInputs.maintenance.pinSha256,view.identity.sourceFiles['tooling/maintenance-input.lock.json']);
});
