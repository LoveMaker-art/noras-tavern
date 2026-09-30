const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {pathToFileURL} = require('node:url');
const {DatabaseSync} = require('node:sqlite');
const desktop = fs.existsSync(path.join(__dirname,'../../launcher/desktop/telemetry.js'))
  ? path.join(__dirname,'../../launcher/desktop') : path.join(__dirname,'../installer/desktop');
const {createTelemetry} = require(path.join(desktop,'telemetry'));

test('launcher events traverse the actual Worker contract and D1 schema', {skip:!process.env.NORA_LANDING_ROOT}, async t => {
  const landing = process.env.NORA_LANDING_ROOT;
  const {default:worker} = await import(pathToFileURL(path.join(landing,'server/worker.mjs')));
  assert.deepEqual(require(path.join(desktop,'telemetry-contract.json')),JSON.parse(fs.readFileSync(path.join(landing,'server/launcher-contract.json'),'utf8')));
  const db = new DatabaseSync(':memory:');
  db.exec(fs.readFileSync(path.join(landing,'migrations/0005_launcher_events.sql'),'utf8'));
  const statement = (sql,args=[])=>({bind(...values){return statement(sql,values);},async run(){return db.prepare(sql).run(...args);},async all(){return {results:db.prepare(sql).all(...args)};}});
  const env = {DB:{prepare:statement},VISITOR_HASH_SECRET:'integration-only',STATS_READ_KEY:'integration-read-only'};
  const root = fs.mkdtempSync(path.join(os.tmpdir(),'nora-worker-contract-'));
  const client = createTelemetry({file:path.join(root,'telemetry.json'),launcherVersion:'1.1.2',cohort:'new',automatic:false,
    fetcher:(url,options)=>worker.fetch(new Request(url,options),env)});
  t.after(()=>{client.close();db.close();fs.rmSync(root,{recursive:true,force:true});});
  const operation = client.begin('install');client.stage('runtime_extract');client.finish('failed',{code:'ENOENT'});
  await client.flush();
  assert.equal(JSON.parse(fs.readFileSync(path.join(root,'telemetry.json'))).queue.length,0);
  const date = new Date(Date.now()+28800000).toISOString().slice(0,10);
  const result = await worker.fetch(new Request(`https://noratavern.com/api/launcher/stats?from=${date}&to=${date}&operation_id=${operation}`,{headers:{Authorization:'Bearer integration-read-only'}}),env);
  assert.equal(result.status,200);
  const data = await result.json();
  assert.equal(data.timeline.at(-1).error_code,'missing_dependency');
  assert.equal(data.timeline.at(-1).status,'failed');
  assert.notEqual(data.timeline[0].installation_id,client.settings().installationId);
});
