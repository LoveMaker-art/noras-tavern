// Diagnostic-only: restore sealed bytes from a failed Windows job, never rebuild or publish them.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn, execFileSync } = require('node:child_process');
const { pipeline } = require('node:stream/promises');
const { verifyArchive, extractScript } = require('../release/reuse-windows-build.cjs');

const repository = path.resolve(__dirname, '../..');
const artifactName = 'nora-windows-failed-packaging-diagnostic';
const allowedChanges = new Set([
  '.github/workflows/build-integrated-launcher.yml',
  'tooling/checks/launcher-artifact-checks.cjs',
  'tooling/checks/launcher-installed-check.ps1',
  'tooling/checks/restore-launcher-check-package.cjs',
  'tooling/checks/verify-launcher-replacement.sh',
  'tests/launcher-artifact-checks.test.cjs',
  'tests/launcher-windows-reuse.test.cjs',
]);
const read = file => JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
const sha = async file => {
  const hash = crypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
};
const regular = file => {
  assert.ok(fs.lstatSync(file).isFile(), `Expected a regular package file: ${file}`);
  return file;
};
const only = (items, label) => {
  assert.equal(items.length, 1, `Expected exactly one ${label}, found ${items.length}`);
  return items[0];
};
const safeName = name => {
  assert.match(name, /^[A-Za-z0-9][A-Za-z0-9._-]*$/);
  return name;
};

function verifyInputs(env) {
  assert.equal(env.GITHUB_EVENT_NAME, 'workflow_dispatch');
  assert.equal(env.GITHUB_REF_TYPE, 'branch');
  assert.ok(typeof env.GITHUB_REF_NAME === 'string' && env.GITHUB_REF_NAME.length > 0);
  assert.equal(env.GITHUB_REF, `refs/heads/${env.GITHUB_REF_NAME}`);
  assert.equal(env.NORA_BUILD_TARGET, 'win32-package-check');
  assert.equal(env.NORA_PRODUCTION_MODE, 'true');
  for (const key of ['NORA_RUNTIME_SOURCE_RUN', 'NORA_PUBLISH_SOURCE_RUN',
    'NORA_VERIFIED_WINDOWS_RUN', 'NORA_LAUNCHER_BASELINE_TAG']) assert.equal(env[key], '');
  assert.match(env.NORA_PACKAGE_SOURCE_RUN, /^[1-9][0-9]*$/);
  assert.ok(Number.isSafeInteger(Number(env.NORA_PACKAGE_SOURCE_RUN)));
  assert.match(env.GITHUB_RUN_ID, /^[1-9][0-9]*$/);
  assert.ok(Number.isSafeInteger(Number(env.GITHUB_RUN_ID)));
  assert.notEqual(env.NORA_PACKAGE_SOURCE_RUN, env.GITHUB_RUN_ID, 'Cannot diagnose the current run');
  assert.match(env.GITHUB_REPOSITORY, /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/);
  assert.match(env.GITHUB_SHA, /^[a-f0-9]{40}$/);
  return Number(env.NORA_PACKAGE_SOURCE_RUN);
}

function verifySource(run, artifacts, env, jobs) {
  assert.equal(run.id, verifyInputs(env));
  assert.equal(run.path, '.github/workflows/build-integrated-launcher.yml');
  assert.equal(run.event, 'workflow_dispatch');
  assert.equal(run.status, 'completed');
  assert.equal(run.conclusion, 'failure');
  assert.match(run.head_sha, /^[a-f0-9]{40}$/);
  assert.equal(run.head_branch, env.GITHUB_REF_NAME, 'Expected the same branch, not a release tag');
  assert.equal(run.repository.full_name, env.GITHUB_REPOSITORY);
  assert.ok(Number.isSafeInteger(run.repository.id) && run.repository.id > 0);
  assert.equal(run.head_repository.id, run.repository.id);
  assert.equal(run.head_repository.full_name, run.repository.full_name);
  assert.equal(artifacts.total_count, artifacts.artifacts.length, 'Incomplete artifact listing');
  const item = only(artifacts.artifacts.filter(value => value.name === artifactName), 'failed Windows package artifact');
  assert.ok(Number.isSafeInteger(item.id) && item.id > 0);
  assert.equal(item.expired, false);
  assert.ok(Number.isSafeInteger(item.size_in_bytes) && item.size_in_bytes > 0);
  assert.match(item.digest, /^sha256:[a-f0-9]{64}$/);
  assert.equal(item.workflow_run.id, run.id);
  assert.equal(item.workflow_run.head_sha, run.head_sha);
  assert.equal(item.workflow_run.head_branch, run.head_branch);
  assert.equal(item.workflow_run.repository_id, run.repository.id);
  assert.equal(item.workflow_run.head_repository_id, run.repository.id);
  if (jobs) {
    assert.equal(jobs.total_count, jobs.jobs.length, 'Incomplete job listing');
    const job = only(jobs.jobs.filter(value => /^(build|replacement-contract) \(windows-latest, win32, x64, pack:win:x64\)$/.test(value.name)), 'native Windows source job');
    assert.equal(job.run_id, run.id);
    assert.equal(job.head_sha, run.head_sha);
    assert.equal(job.status, 'completed');
    assert.equal(job.conclusion, 'failure');
    for (const name of ['Assemble full installers from the same verified payload',
      'Preserve built Windows packages when later acceptance fails']) {
      const step = only(job.steps.filter(value => value.name === name), name);
      assert.equal(step.status, 'completed');
      assert.equal(step.conclusion, 'success');
    }
  }
  return item;
}

function verifyDiff(raw) {
  const parts = raw.split('\0');
  assert.equal(parts.pop(), '', 'Expected a NUL-terminated raw Git diff');
  assert.equal(parts.length % 2, 0, 'Malformed raw Git diff');
  const changes = [];
  for (let index = 0; index < parts.length; index += 2) {
    const match = /^:([0-7]{6}) ([0-7]{6}) ([a-f0-9]{40}) ([a-f0-9]{40}) ([AMD])$/.exec(parts[index]);
    assert.ok(match, 'Unsupported Git change or rename');
    const file = parts[index + 1];
    assert.ok(allowedChanges.has(file), `Package product source changed: ${file}`);
    const [, oldMode, newMode, oldBlob, newBlob, status] = match;
    assert.equal(oldMode, status === 'A' ? '000000' : '100644', `Unexpected previous mode: ${file}`);
    assert.equal(newMode, status === 'D' ? '000000' : '100644', `Unexpected changed mode: ${file}`);
    if (file === 'tooling/checks/verify-launcher-replacement.sh') assert.equal(status, 'D', 'The old wrapper may only be deleted');
    changes.push({ file, status, oldMode, newMode, oldBlob, newBlob });
  }
  return changes;
}

function verifyGitChanges(sourceCommit, checkCommit, root = repository) {
  assert.match(sourceCommit, /^[a-f0-9]{40}$/);
  assert.match(checkCommit, /^[a-f0-9]{40}$/);
  const git = args => execFileSync('git', args, { cwd: root, encoding: 'utf8' });
  assert.equal(git(['rev-parse', 'HEAD']).trim(), checkCommit, 'Checker checkout differs from its run SHA');
  assert.equal(git(['status', '--porcelain', '--untracked-files=no']).trim(), '', 'Tracked checker source must be clean');
  git(['merge-base', '--is-ancestor', sourceCommit, checkCommit]);
  return verifyDiff(git(['diff', '--raw', '-z', '--no-abbrev', '--no-renames', sourceCommit, checkCommit, '--']));
}

function extract(archive, output, python) {
  assert.ok(path.isAbsolute(python), 'Pass the explicit native Python interpreter');
  regular(python);
  assert.ok(!fs.existsSync(output), 'Refusing an existing extraction directory');
  execFileSync(python, ['-I', '-c', extractScript, regular(archive), output],
    { stdio: 'inherit', timeout: 300000, windowsHide: true });
}

async function verifyPayload(release, outer, commit) {
  const payload = path.join(release, 'nora-tavern-launcher/payload');
  const assets = path.join(outer, 'system-assets');
  const descriptor = regular(path.join(assets, 'nora-system-win32-x64.json'));
  const system = read(descriptor), manifest = read(regular(path.join(payload, 'release-manifest.json')));
  assert.equal(system.schema, 'nora-system/v1');
  assert.equal(system.commit, commit);
  assert.equal(system.candidate, false);
  assert.equal(system.channel, 'stable');
  assert.equal(system.platform, 'win32');
  assert.equal(system.arch, 'x64');
  assert.equal(manifest.commit, commit);
  assert.equal(manifest.candidate, false);
  assert.equal(manifest.dirty, false);
  assert.equal(manifest.versions.tavern, system.version);
  assert.equal(manifest.hermesRuntime.platform, 'win32');
  assert.equal(manifest.hermesRuntime.arch, 'x64');
  assert.equal(await sha(descriptor), await sha(regular(path.join(payload, 'nora-system.json'))), 'Starter and actual platform descriptor differ');
  assert.ok(system.files && typeof system.files === 'object' && !Array.isArray(system.files));
  assert.ok(Object.keys(system.files).length > 0);
  const components = {};
  for (const [name, entry] of Object.entries(system.files)) {
    safeName(name); safeName(entry.asset);
    assert.equal(entry.asset, `win32-x64-${name}`);
    assert.match(entry.sha256, /^[a-f0-9]{64}$/);
    assert.ok(Number.isSafeInteger(entry.size) && entry.size >= 0);
    for (const file of [path.join(assets, entry.asset), path.join(payload, name)]) {
      regular(file);
      assert.equal(fs.statSync(file).size, entry.size, `Component size differs: ${file}`);
      assert.equal(await sha(file), entry.sha256, `Component digest differs: ${file}`);
    }
    components[name] = { ...entry };
  }
  assert.ok(system.files['release-manifest.json'], 'Missing bound release manifest');
  return { systemManifestSha256: await sha(descriptor), releaseManifestSha256: await sha(path.join(payload, 'release-manifest.json')), components };
}

async function restore(env = process.env) {
  verifyInputs(env);
  assert.equal(process.platform, 'win32', 'This retained package diagnostic runs only on native Windows');
  assert.equal(process.arch, 'x64');
  assert.ok(path.isAbsolute(env.RUNNER_TEMP));
  assert.ok(path.isAbsolute(env.NORA_CHECK_PYTHON));
  regular(env.NORA_CHECK_PYTHON);
  const report = path.join(env.RUNNER_TEMP, 'nora-package-check-source.json');
  assert.ok(!fs.existsSync(report), 'Refusing a stale diagnostic provenance report');
  const root = path.join(env.RUNNER_TEMP, 'nora-package-check-source');
  assert.ok(!fs.existsSync(root), 'Expected a fresh diagnostic source directory');
  const releases = path.join(repository, 'release');
  if (fs.existsSync(releases)) {
    assert.ok(fs.lstatSync(releases).isDirectory());
    assert.equal(fs.readdirSync(releases).length, 0, 'Refusing existing release outputs');
  }
  const api = endpoint => JSON.parse(execFileSync('gh', ['api', `repos/${env.GITHUB_REPOSITORY}/${endpoint}`],
    { encoding: 'utf8', timeout: 120000, maxBuffer: 8 * 1024 * 1024, env }));
  const run = api(`actions/runs/${env.NORA_PACKAGE_SOURCE_RUN}`);
  const artifacts = api(`actions/runs/${run.id}/artifacts?per_page=100`);
  const jobs = api(`actions/runs/${run.id}/jobs?per_page=100`);
  const item = verifySource(run, artifacts, env, jobs);
  const changes = verifyGitChanges(run.head_sha, env.GITHUB_SHA);
  fs.mkdirSync(root);
  for (const [name, value] of Object.entries({ run, artifacts, jobs })) {
    fs.writeFileSync(path.join(root, `source-${name}.json`), JSON.stringify(value, null, 2) + '\n', { flag: 'wx' });
  }
  const archive = path.join(root, 'source-artifact.zip');
  const child = spawn('gh', ['api', `repos/${env.GITHUB_REPOSITORY}/actions/artifacts/${item.id}/zip`],
    { env, stdio: ['ignore', 'pipe', 'inherit'], windowsHide: true });
  const closed = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => code === 0 && signal === null
      ? resolve() : reject(new Error(`Artifact download exited ${signal || code}`)));
  });
  const timer = setTimeout(() => child.kill(), 600000);
  try { await Promise.all([pipeline(child.stdout, fs.createWriteStream(archive, { flags: 'wx' })), closed]); }
  catch (error) { child.kill(); throw error; }
  finally { clearTimeout(timer); }
  await verifyArchive(archive, item);
  const outerRoot = path.join(root, 'outer');
  extract(archive, outerRoot, env.NORA_CHECK_PYTHON);
  const base = only(fs.readdirSync(outerRoot), 'outer release directory');
  assert.match(base, new RegExp(`^stable-${run.head_sha.slice(0, 12)}-[0-9]+$`));
  const outer = path.join(outerRoot, base);
  assert.ok(fs.lstatSync(outer).isDirectory());
  const staging = path.join(root, 'staged-release');
  const starter = regular(path.join(outer, 'nora-tavern-launcher.zip'));
  extract(starter, staging, env.NORA_CHECK_PYTHON);
  assert.deepEqual(fs.readdirSync(staging), ['nora-tavern-launcher']);
  const binding = await verifyPayload(staging, outer, run.head_sha);
  const desktop = path.join(staging, 'nora-tavern-launcher/desktop');
  const dist = path.join(desktop, 'dist');
  assert.ok(!fs.existsSync(dist), 'The starter must not contain rebuilt desktop output');
  fs.cpSync(path.join(outer, 'nora-tavern-launcher/desktop/dist'), dist, { recursive: true, errorOnExist: true, force: false });
  const fullZip = regular(path.join(dist, only(fs.readdirSync(dist).filter(name => name.endsWith('-win-x64.zip')), 'full Windows ZIP')));
  extract(fullZip, path.join(dist, 'win-unpacked'), env.NORA_CHECK_PYTHON);
  assert.equal(await sha(regular(path.join(dist, 'win-unpacked/resources/payload/nora-system.json'))), binding.systemManifestSha256, 'Actual full ZIP payload differs from the starter');
  fs.cpSync(path.join(outer, 'system-assets'), path.join(staging, 'system-assets'), { recursive: true, errorOnExist: true, force: false });
  fs.copyFileSync(starter, path.join(staging, 'nora-tavern-launcher.zip'), fs.constants.COPYFILE_EXCL);
  const originalFiles = [];
  for (const entry of fs.readdirSync(outer, { recursive: true, withFileTypes: true })) {
    if (entry.isDirectory()) continue;
    assert.ok(entry.isFile(), 'Expected ordinary sealed package files');
    const from = path.join(entry.parentPath, entry.name), relative = path.relative(outer, from), to = regular(path.join(staging, relative));
    assert.equal(fs.statSync(to).size, fs.statSync(from).size);
    const digest = await sha(from);
    assert.equal(await sha(to), digest, `Restored bytes differ: ${relative}`);
    originalFiles.push({ path: relative, size: fs.statSync(from).size, sha256: digest });
  }
  fs.mkdirSync(releases, { recursive: true });
  const release = path.join(releases, base);
  assert.ok(!fs.existsSync(release));
  fs.renameSync(staging, release);
  const proof = { schema: 'nora-retained-package-check-source/1', diagnosticOnly: true,
    accepted: false, publicationAcceptance: false, rebuilt: false, sourceRun: run.id,
    sourceCommit: run.head_sha, checkCommit: env.GITHUB_SHA,
    artifact: { id: item.id, name: item.name, size: item.size_in_bytes, digest: item.digest },
    checkerChanges: changes, release, ...binding, originalFiles };
  fs.writeFileSync(report, JSON.stringify(proof, null, 2) + '\n', { flag: 'wx' });
  if (env.GITHUB_ENV) fs.appendFileSync(env.GITHUB_ENV,
    `NORA_CHECK_RELEASE=${release}\nNORA_CHECK_BASELINE_ARTIFACTS=${path.join(release, 'system-assets')}\n`);
  console.log(`Restored diagnostic-only Windows package from run ${run.id} at ${run.head_sha}; checker ${env.GITHUB_SHA}.`);
  return proof;
}

module.exports = { verifyInputs, verifySource, verifyDiff, verifyGitChanges, verifyPayload, allowedChanges, extract, restore };
if (require.main === module) {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === 'modes') {
    try { verifyInputs(process.env); }
    catch (error) { console.error(error); process.exitCode = 1; }
  } else if (args.length === 0) {
    restore().catch(error => { console.error(error); process.exitCode = 1; });
  } else {
    console.error('Usage: restore-launcher-check-package.cjs [modes]');
    process.exitCode = 1;
  }
}
