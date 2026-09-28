import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const html=fs.readFileSync(new URL('../public/index.html',import.meta.url),'utf8');
let scripts=0;
for(const [,attrs,body] of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)){
 if(/type=["'](?:importmap|application\/json)["']/.test(attrs)||!body.trim())continue;
 new vm.Script(body.replace(/\{\{[A-Z_]+\}\}/g, '{}'));scripts++;
}
const start=html.indexOf('        // Start fetching compatibility modules');
const end=html.indexOf('        globalThis.__NORA_MODULE_LOADER_PROMISE__ =',start);
const setup=html.slice(start,end);
const preludeStart=html.indexOf('            const compatibilityPreludeModules =');
const preludeEnd=html.indexOf('                preludeResource.complete',preludeStart);
const ordered=html.slice(preludeStart,preludeEnd).replace('            try {','');
for(const native of [true,false])for(const importMap of [true,false]){
 const links=[],calls=[];
 const ctx=vm.createContext({structuredClone:native?()=>{}:undefined,
 __NORA_VENDOR_ASSET_BASE__:'/asset-files/vendor/v1',
 __NORA_ASSET_BASES__:{'nora-entry':'/asset-files/entry/v1','st-static':'/asset-files/static/v1'},
 __NORA_TRACK_BOOT_RESOURCE__:()=>({complete(){},fail(){}}),
 recordAssetCacheMilestone(){},
 HTMLScriptElement:{supports:()=>importMap},
 document:{querySelector:()=>({textContent:JSON.stringify({imports:{'nora-module/core.js':'/asset-files/static/v1/core.js','nora-module/alias.js':'/asset-files/static/v1/core.js','nora-module/lib/eventemitter.js':'/asset-files/static/v1/lib/eventemitter.js','nora-module/lib/structured-clone/index.js':'/asset-files/static/v1/lib/structured-clone/index.js','nora-module/external.js':'https://example.org/x.js'}})}),querySelectorAll:()=>links,createElement:()=>({addEventListener(){},getAttribute(k){return this[k]}}),head:{append(x){links.push(x)}}},
 __NORA_LOAD_MODULE__:async s=>{calls.push('start:'+s);await Promise.resolve();calls.push('end:'+s);}
 });
 vm.runInContext(setup,ctx);
 assert.equal(links.length,0,'no fetch before runtime start');
 vm.runInContext('__NORA_START_RUNTIME_ASSETS__(); __NORA_START_RUNTIME_ASSETS__();',ctx);
 if(ctx.__NORA_PRELOAD_CORE_GRAPH__){
  assert.equal(links.length,native?5:10,'bulk graph must wait for legacy completion');
  vm.runInContext('__NORA_PRELOAD_CORE_GRAPH__(); __NORA_PRELOAD_CORE_GRAPH__();',ctx);
 }
 assert.equal(links.length,(native?5:10)+(importMap?1:0),'preload once, with dependency closure for fallback');
 assert.equal(links.filter(x=>x.href.includes('structured-clone')).length,native?0:5);
 assert.ok(links.every(x=>x.rel==='modulepreload'&&x.href.startsWith('/asset-files/')));
 await vm.runInContext('(async()=>{'+ordered+'})()',ctx);
 assert.equal(calls.length,native?6:8);
 for(let i=0;i<calls.length;i+=2)assert.equal(calls[i].slice(6),calls[i+1].slice(4),'keep ordered evaluation');
 console.log('PASS',native?'native structuredClone':'fallback structuredClone',importMap?'native import map':'shim branch');
}
console.log('PASS inline script syntax:',scripts);

// Execute the real legacy loader boundary, including failure paths.
const legacyStart = html.indexOf('        globalThis.__NORA_LEGACY_RUNTIME_PROMISE__ =');
const legacyEnd = html.indexOf('        globalThis.__NORA_MODULE_BOOTSTRAP_PROMISE__ =', legacyStart);
assert.ok(legacyStart >= 0 && legacyEnd > legacyStart);
for (const outcome of ['success', 'preload-error', 'legacy-error']) {
 const events = {};
 let releaseRuntime;
 let appended = false;
 let graphCalls = 0;
 const context = vm.createContext({
  __NORA_RUNTIME_ASSET_START_PROMISE__: new Promise(resolve => { releaseRuntime = resolve; }),
  __NORA_BOOT_METRICS__: { milestones: [], startedAt: 0 },
  __NORA_LEGACY_ASSET_BASE__: '/asset-files/legacy/v1',
  performance: { now: () => 1 },
  console: { warn() {} },
  __NORA_TRACK_BOOT_RESOURCE__: () => ({ complete() {}, fail() {} }),
  __NORA_REPORT_EARLY_BOOT_METRICS__() {},
  __NORA_PRELOAD_CORE_GRAPH__() {
   graphCalls++;
   if (outcome === 'preload-error') throw new Error('preload unavailable');
  },
  document: {
   createElement: () => ({ addEventListener(name, callback) { events[name] = callback; } }),
   body: { append(script) { appended = true; assert.equal(script.fetchPriority, 'high'); } },
  },
 });
 vm.runInContext(html.slice(legacyStart, legacyEnd), context);
 assert.equal(appended, false);
 releaseRuntime();
 await Promise.resolve();
 assert.equal(appended, true);
 assert.equal(graphCalls, 0, 'core graph must not compete with legacy download');
 if (outcome === 'legacy-error') {
  events.error();
  await assert.rejects(context.__NORA_LEGACY_RUNTIME_PROMISE__, /legacy runtime failed/);
  assert.equal(graphCalls, 0);
 } else {
  events.load();
  await context.__NORA_LEGACY_RUNTIME_PROMISE__;
  assert.equal(graphCalls, 1);
 }
}
console.log('PASS legacy ordering and optional-preload failure isolation');
