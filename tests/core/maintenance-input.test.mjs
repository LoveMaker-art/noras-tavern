import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import childProcess from 'node:child_process';import {syncBuiltinESMExports} from 'node:module';
import {prepareMaintenance,materializeMaintenance,readMaintenancePin} from '../../tooling/maintenance-input.mjs';
test('an offline missing maintenance input does not fall back to adjacent source or network',async t=>{const cache=fs.mkdtempSync(path.join(os.tmpdir(),'nora-core-input-'));t.after(()=>fs.rmSync(cache,{recursive:true,force:true}));await assert.rejects(prepareMaintenance({cache,offline:true,fetcher:()=>assert.fail('offline')}),/missing|ENOENT/i);assert.deepEqual(fs.readdirSync(cache),[]);});
test('corrupt input is rejected before any managed file is materialized',t=>{const cache=fs.mkdtempSync(path.join(os.tmpdir(),'nora-core-corrupt-'));t.after(()=>fs.rmSync(cache,{recursive:true,force:true}));const pin=readMaintenancePin();fs.writeFileSync(path.join(cache,pin.archive.name),'bad input');assert.throws(()=>materializeMaintenance({cache,stage:path.join(cache,'target')}),/size|checksum/i);assert.equal(fs.existsSync(path.join(cache,'target')),false);});
test('the fixed shared closure can serve core actors without Electron or GUI resources',t=>{const stage=fs.mkdtempSync(path.join(os.tmpdir(),'nora-core-consumer-'));t.after(()=>fs.rmSync(stage,{recursive:true,force:true}));const result=materializeMaintenance({stage});assert.equal(result.files.length,186);assert.ok(fs.existsSync(path.join(stage,'ops/installer/desktop/updater-task.js')));for(const name of ['main.js','preload.js','package.json'])assert.equal(fs.existsSync(path.join(stage,'ops/installer/desktop',name)),false);assert.equal(fs.existsSync(path.join(stage,'ops/updater/actor-dependencies/node_modules/electron')),false);assert.ok(result.identity.sha256);});
test('Windows maintenance archives use the native local tar command',t=>{
 const stage=fs.mkdtempSync(path.join(os.tmpdir(),'nora-core-windows-input-'));t.after(()=>fs.rmSync(stage,{recursive:true,force:true}));
 const calls=[],execute=childProcess.execFileSync,platform=Object.getOwnPropertyDescriptor(process,'platform'),systemRoot=process.env.SystemRoot;
 t.mock.method(childProcess,'execFileSync',(command,args,options)=>{calls.push(command);return execute('tar',args,options);});
 Object.defineProperty(process,'platform',{value:'win32'});process.env.SystemRoot='C:\\Windows';syncBuiltinESMExports();
 t.after(()=>{Object.defineProperty(process,'platform',platform);if(systemRoot===undefined)delete process.env.SystemRoot;else process.env.SystemRoot=systemRoot;t.mock.restoreAll();syncBuiltinESMExports();});
 const result=materializeMaintenance({stage});assert.equal(result.files.length,186);assert.equal(calls.length,3);
 for(const command of calls)assert.equal(command,path.win32.join('C:\\Windows','System32','tar.exe'));
});
