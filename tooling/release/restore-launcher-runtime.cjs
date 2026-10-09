const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const lock = require('../installer/desktop/operation-lock');
const { createOperationController } = require('../installer/desktop/operation-state');

const [artifacts, temporary] = process.argv.slice(2);
if (!artifacts || !temporary) throw new Error('Pass the baseline artifact directory and runner temporary directory');
const prefix = `${process.platform}-${process.arch}-`;
const name = `${prefix}nora-hermes-runtime.json`;
const matches = fs.readdirSync(artifacts, { recursive: true }).filter(file => path.basename(file) === name || path.basename(file) === 'nora-hermes-runtime.json');
assert.equal(matches.length, 1, 'Expected exactly one baseline runtime manifest');
const manifestFile = path.join(artifacts, matches[0]);
const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
assert.equal(manifest.platform, process.platform);
assert.equal(manifest.arch, process.arch);
assert.match(manifest.archive, /^[a-zA-Z0-9._-]+$/);
const payload = path.join(temporary, 'hermes-runtime');
fs.mkdirSync(payload, { recursive: true });
fs.copyFileSync(manifestFile, path.join(payload, 'nora-hermes-runtime.json'));
const archiveName = path.basename(manifestFile) === name ? prefix + manifest.archive : manifest.archive;
fs.copyFileSync(path.join(path.dirname(manifestFile), archiveName), path.join(payload, manifest.archive));
async function restore() {
  const home = fs.realpathSync(temporary);
  const controller = createOperationController({directory: path.join(home, 'installer'), lock});
  let actorFailure;
  const result = await controller.start('runtime-bootstrap', {
    target: {sha256: manifest.sha256, platform: manifest.platform, arch: manifest.arch},
    execute: async context => {
      await context.plan(context.target);
      await context.stage('applying');
      const child = context.lease.spawn(process.execPath,
        [path.resolve(__dirname, '../installer/desktop/runtime-worker.js'), payload, home, path.join(home, 'hermes')],
        {kind: 'runtime-bootstrap', env: {...process.env, ELECTRON_RUN_AS_NODE: '1'}, windowsHide: true});
      let frame = '', reported;
      child.stdout.on('data', value => {
        process.stdout.write(value);
        frame += value.toString('utf8');
        while (frame.includes('\n')) {
          const index = frame.indexOf('\n'), line = frame.slice(0, index); frame = frame.slice(index + 1);
          try {
            const event = JSON.parse(line); context.observe(event);
            if (event.event === 'error') reported = event;
          } catch {}
        }
        if (frame.length > 128 * 1024) frame = '';
      });
      child.stderr.on('data', value => process.stderr.write(value));
      child.stdin.end();
      const closed = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => child.kill('SIGKILL'), 600000); timer.unref();
        child.once('guard-lost', error => {clearTimeout(timer); reject(error);});
        child.once('error', error => {
          actorFailure = error;
          if (child.pid === undefined) {clearTimeout(timer); reject(error);}
        });
        child.once('close', (code, signal) => {clearTimeout(timer); resolve({code, signal});});
      });
      if (closed.code !== 0 || reported || actorFailure) {
        actorFailure ||= Object.assign(new Error(reported?.message || `Runtime actor exited ${closed.signal || closed.code}`),
          {code: reported?.code || 'RUNTIME_RESTORE_FAILED'});
        throw actorFailure;
      }
      const facts = await context.lease.snapshot();
      const job = facts.jobs.find(value => value.jobId === child.jobId);
      assert.ok(job?.closedAt && job.pid === child.pid && job.delegation.identityStatus === 'reported',
        'Runtime actor closure and delegation must be confirmed');
      await context.stage('verifying');
      const journal = JSON.parse(fs.readFileSync(path.join(home, 'installer/operations', context.operationId, 'runtime-bootstrap.json'), 'utf8'));
      assert.equal(journal.status, 'committed');
      assert.equal(journal.target.sha256, manifest.sha256);
      return {verification: 'confirmed'};
    },
  }, randomUUID());
  if (result.state !== 'succeeded') throw actorFailure || new Error(JSON.stringify(result.currentFailure || result.primaryFailure));
  // Only report success after the verified transaction and actual child closure.
  console.log(`Restored verified ${prefix}runtime: ${manifest.sha256}`);
}
restore().catch(error => {console.error(error); process.exitCode = 1;});
