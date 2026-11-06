// Native Intel APP recovery through the production preload/IPC bridge. AX is not used.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const crypto = require('node:crypto');
const {execFileSync, spawn} = require('node:child_process');
const delay = require('node:timers/promises').setTimeout;

const oldVersion = '2.2.8';
const oldCore = '2.6.4';
const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const command = (file, args) => execFileSync(file, args, {encoding: 'utf8', timeout: 120000}).trim();
const safeError = error => ({name: error.name, message: String(error.message).slice(0, 1500)});
async function hash(file) {
  const digest = crypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(file)) digest.update(chunk);
  return digest.digest('hex');
}
async function waitFor(label, seconds, observe) {
  const deadline = Date.now() + seconds * 1000;
  let last;
  do {
    try {const value = await observe(); if (value) return value;}
    catch (error) {last = error;}
    await delay(200);
  } while (Date.now() < deadline);
  throw new Error(`Timed out waiting for ${label}`, {cause: last});
}
async function unusedPort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {server.once('error', reject); server.listen(0, '127.0.0.1', resolve);});
  const {port} = server.address();
  await new Promise(resolve => server.close(resolve));
  return port;
}
function link(directory, name, file) {
  assert.equal(path.basename(name), name);
  const target = path.join(directory, name);
  if (!fs.existsSync(target)) fs.linkSync(file, target);
}
function regularFiles(directory) {
  return fs.readdirSync(directory, {recursive: true, withFileTypes: true}).filter(item => item.isFile())
    .map(item => path.join(item.parentPath, item.name));
}
async function unpack(archive, destination) {
  fs.mkdirSync(destination, {mode: 0o700});
  const helper = path.resolve(__dirname, '../../launcher/desktop/replace-launcher.py');
  command('python3', ['-B', '-c', 'import runpy,sys; from pathlib import Path; runpy.run_path(sys.argv[1])["extract"](Path(sys.argv[2]),Path(sys.argv[3]),"darwin")', helper, archive, destination]);
  const names = fs.readdirSync(destination).filter(name => name.endsWith('.app'));
  assert.equal(names.length, 1);
  const app = path.join(destination, names[0]);
  const info = field => command('/usr/libexec/PlistBuddy', ['-c', `Print :${field}`, path.join(app, 'Contents/Info.plist')]);
  const exe = path.join(app, 'Contents/MacOS', info('CFBundleExecutable'));
  const asar = path.join(app, 'Contents/Resources/app.asar');
  assert.equal(command('/usr/bin/lipo', ['-archs', exe]), 'x86_64');
  command('/usr/bin/codesign', ['--verify', '--deep', '--strict', app]);
  return {app, exe, asar, version: info('CFBundleShortVersionString'), exeSha: await hash(exe), asarSha: await hash(asar)};
}
async function evaluate(debugPort, expression, seconds = 10, awaitPromise = true) {
  const response = await fetch(`http://127.0.0.1:${debugPort}/json/list`, {signal: AbortSignal.timeout(2000)});
  assert.equal(response.status, 200);
  const pages = (await response.json()).filter(item => item.type === 'page' && item.url.startsWith('file:')
    && new URL(item.url).pathname.endsWith('/launcher-conversation-prototype.html'));
  assert.equal(pages.length, 1, 'Expected one genuine launcher renderer');
  const url = new URL(pages[0].webSocketDebuggerUrl);
  assert.equal(url.hostname, '127.0.0.1');
  assert.equal(url.port, String(debugPort));
  const socket = new WebSocket(url);
  return new Promise((resolve, reject) => {
    const finish = (error, value) => {clearTimeout(timer); socket.close(); error ? reject(error) : resolve(value);};
    const timer = setTimeout(() => finish(new Error('Timed out in packaged renderer IPC')), seconds * 1000);
    socket.addEventListener('open', () => socket.send(JSON.stringify({id: 1, method: 'Runtime.evaluate',
      params: {expression, returnByValue: true, awaitPromise}})), {once: true});
    socket.addEventListener('error', () => finish(new Error('Packaged renderer endpoint unavailable')), {once: true});
    socket.addEventListener('close', () => finish(new Error('Packaged renderer closed')), {once: true});
    socket.addEventListener('message', event => {
      const message = JSON.parse(event.data);
      if (message.id !== 1) return;
      if (message.error || message.result.exceptionDetails) return finish(new Error(JSON.stringify(message.error || message.result.exceptionDetails)));
      finish(null, message.result.result.value);
    });
  });
}
const cut = `import hashlib,json,pathlib,signal,sys,time,psutil
root,home,exe,asar=map(pathlib.Path,sys.argv[1:5]); exe_hash,asar_hash=sys.argv[5:7]
assert all(p.is_relative_to(root) for p in (home,exe,asar))
def read(file): return json.loads(file.read_text())
def digest(file):
    with file.open('rb') as stream: return hashlib.file_digest(stream,'sha256').hexdigest()
deadline=time.monotonic()+300
while time.monotonic()<deadline:
    for checkpoint in home.glob('installer/launcher-update/job-*/recovery.json'):
        job=checkpoint.parent; ready=job/'ready.json'; snap=read(checkpoint)
        if snap.get('phase')!='awaiting-launcher' or ready.exists(): continue
        plan=read(job/'plan.json')
        assert plan['operationId']==snap['operationId'] and plan['planDigest']==snap['planDigest']
        assert pathlib.Path(plan['appRoot'])/plan['executable']==exe
        try:
            worker=psutil.Process(snap['workerPid'])
            if worker.create_time()!=snap['workerCreationTime']: continue
            for child in worker.children():
                if child.exe()!=str(exe) or '--nora-self-update='+str(job) not in child.cmdline(): continue
                birth=child.create_time()
                if digest(exe)!=exe_hash or digest(asar)!=asar_hash: continue
                if ready.exists() or read(checkpoint)['phase']!='awaiting-launcher' or child.create_time()!=birth: continue
                child.send_signal(signal.SIGKILL)
                print(json.dumps(dict(job=str(job),id=snap['operationId'],digest=snap['planDigest'],pid=child.pid,birth=birth,ready=False,signal='SIGKILL')),flush=True)
                sys.exit(0)
        except (psutil.NoSuchProcess,psutil.AccessDenied): pass
    time.sleep(.02)
raise SystemExit('Authentic pre-ACK cut was not observed')`;

const crashCensus = `import json,os,pathlib,sys,psutil
root,home,job=map(pathlib.Path,sys.argv[1:4]); plan=json.loads((job/'plan.json').read_text())
assert job.is_relative_to(home) and home.is_relative_to(root)
app=pathlib.Path(plan['appRoot']); backup=app.parent/('.nora-previous-'+plan['token'])
assert backup.is_relative_to(root)
expected=backup/'Contents/Frameworks/Electron Framework.framework/Versions/A/Helpers/chrome_crashpad_handler'
db='--database='+str(home/'launcher/diagnostics/native-crashes')
records=[]
for p in psutil.process_iter():
    try:
        if p.exe()==str(expected) and p.ppid()==1 and p.uids().effective==os.geteuid() and db in p.cmdline():
            records.append(dict(pid=p.pid,birth=p.create_time()))
    except (psutil.NoSuchProcess,psutil.AccessDenied): pass
print(json.dumps(records))`;

const actorCensus = `import json,os,pathlib,sys,psutil
root=pathlib.Path(sys.argv[1]); rows=[]
for p in psutil.process_iter():
    try:
        exe=pathlib.Path(p.exe())
        if not exe.is_relative_to(root) or p.uids().effective!=os.geteuid(): continue
        args=p.cmdline()[1:]
        fields=['--type=','--nora-self-update=','--nora-local-release=','--database=','--remote-debugging-port=']
        rows.append(dict(pid=p.pid,ppid=p.ppid(),birth=p.create_time(),exe=str(exe),uid=p.uids().effective,
                         state=p.status(),args=[a for a in args if any(a.startswith(k) for k in fields)]))
    except (psutil.NoSuchProcess,psutil.AccessDenied): pass
print(json.dumps(rows[:40]))`;

function sameLiveProcess(pid, birth) {
  return command('python3', ['-B', '-c', `import psutil,sys
try:
    p=psutil.Process(int(sys.argv[1])); same=p.create_time()==float(sys.argv[2]) and p.status()!=psutil.STATUS_ZOMBIE
except psutil.NoSuchProcess: same=False
print('present' if same else 'gone')`, String(pid), String(birth)]) === 'present';
}

async function qualifyApp({directory, source, identity, payload, deliveryName, launcherName, launcherArchive, sharedName, targetVersion}) {
  assert.equal(`${process.platform}-${process.arch}`, 'darwin-x64');
  const fixture = path.join(directory, 'app-fixture');
  fs.mkdirSync(fixture, {mode: 0o700});
  const baseline = path.join(directory, 'baseline');
  const homes = path.join(fixture, 'installation');
  const repo = path.resolve(__dirname, '../..');
  execFileSync(process.execPath, ['tooling/run.mjs', 'node', 'tests/deployment/launcher_product_refactor_smoke.cjs',
    '--payload', baseline, '--baseline-release', baseline, '--product-manifest', path.join(payload, 'release-manifest.json'),
    '--app-only-prepare', '--start-state', 'stopped', '--scratch-base', homes, '--keep'], {cwd: repo, timeout: 1200000, stdio: 'inherit'});
  const reports = regularFiles(homes).filter(file => path.basename(file) === 'harness-result.json');
  assert.equal(reports.length, 1);
  const initial = read(reports[0]);
  assert.equal(initial.outcome, 'prepared-for-native-app-upgrade');
  assert.equal(initial.stop, 'verified');
  assert.equal(initial.actorSourceBinding, 'verified-selected-candidate-manifest');
  const home = path.dirname(reports[0]);
  assert.equal(initial.root, home);
  const port = initial.port;
  const installer = path.join(home, 'installer');
  fs.writeFileSync(path.join(installer, 'state.json'), JSON.stringify({schema: 1, phase: 'idle', port}), {flag: 'wx', mode: 0o600});
  const profile = path.join(fixture, 'profile');
  const tmp = path.join(fixture, 'tmp');
  fs.mkdirSync(profile, {mode: 0o700}); fs.mkdirSync(tmp, {mode: 0o700});
  const env = {HOME: profile, TMPDIR: tmp, PATH: '/usr/bin:/bin:/usr/sbin:/sbin', NORA_TAVERN_HOME: home,
    NORA_HERMES_HOME: path.join(home, 'hermes'), NORA_TAVERN_INSTALL_ROOT: path.join(home, 'tavern')};
  const baselineApp = path.join(directory, 'baseline-app');
  const oldReceipt = read(path.join(baselineApp, 'baseline-launcher-source-receipt.json'));
  const coreReceipt = read(path.join(baseline, 'baseline-source-receipt.json'));
  assert.equal(oldReceipt.version, oldVersion); assert.equal(coreReceipt.version, oldCore);
  const oldArchive = path.join(baselineApp, oldReceipt.archive);
  assert.equal(await hash(oldArchive), oldReceipt.archiveSha256);
  assert.equal(await hash(path.join(baselineApp, oldReceipt.descriptor)), oldReceipt.descriptorSha256);
  const old = await unpack(oldArchive, path.join(fixture, 'old-app'));
  assert.equal(old.version, oldVersion);
  const older = path.join(fixture, 'old-release');
  const newer = path.join(fixture, 'new-release');
  for (const dir of [older, newer]) fs.mkdirSync(dir, {mode: 0o700});
  const systemName = 'nora-system-darwin-x64.json';
  for (const [name, file] of Object.entries(coreReceipt.files)) link(older, file.asset, path.join(baseline, name));
  for (const name of [systemName, 'release-manifest.json']) link(older, name, path.join(baseline, name));
  for (const name of [oldReceipt.descriptor, oldReceipt.archive]) link(older, name, path.join(baselineApp, name));
  const delivery = path.join(directory, deliveryName);
  const desc = read(path.join(delivery, launcherName));
  assert.equal(desc.asset, launcherArchive); assert.equal(desc.commit, source.sourceCommit); assert.equal(desc.candidate, false);
  assert.equal(await hash(path.join(delivery, launcherArchive)), desc.sha256);
  const incoming = await unpack(path.join(delivery, launcherArchive), path.join(fixture, 'incoming-app'));
  assert.equal(incoming.version, desc.version);
  command('/usr/bin/codesign', ['--verify', '--deep', '--strict', path.join(directory, 'accepted.app')]);
  const helper = bundle => path.join(bundle, 'Contents/Resources/replace-launcher.py');
  const helperSha = await hash(helper(incoming.app));
  assert.equal(helperSha, await hash(helper(path.join(directory, 'accepted.app'))));
  for (const file of regularFiles(path.join(directory, sharedName))) link(newer, path.basename(file), file);
  assert.equal(read(path.join(newer, 'release-manifest.json')).commit, source.sourceCommit);
  for (const [name, file] of Object.entries(read(path.join(payload, 'nora-system.json')).files)) link(newer, file.asset, path.join(payload, name));
  for (const name of [systemName, launcherName, launcherArchive]) link(newer, name, path.join(delivery, name));
  const children = [];
  let interrupted, recoveryAdmission, recoveryReply, candidateLog;
  const collectActors = () => JSON.parse(command('python3', ['-B', '-c', actorCensus, fixture]));
  async function saveRecoveryDiagnostic(error) {
    const evidence = path.join(directory, 'evidence');
    const files = [];
    let operation, bundles, actors, log;
    if (interrupted?.job && path.dirname(interrupted.job) === path.join(installer, 'launcher-update')) {
      const job = interrupted.job;
      for (const name of ['recovery.json', 'status.json']) {
        const file = path.join(job, name);
        if (fs.existsSync(file) && fs.lstatSync(file).isFile() && fs.statSync(file).size <= 1024 ** 2) {
          fs.copyFileSync(file, path.join(evidence, 'app-' + name), fs.constants.COPYFILE_EXCL);
          files.push('app-' + name);
        }
      }
      const plan = read(path.join(job, 'plan.json'));
      assert.match(plan.token, /^[0-9a-f-]{36}$/);
      assert.match(interrupted.id, /^[0-9a-f-]{36}$/);
      const {state, sequence, ownerEpoch, planDigest, verification, recoveryOutcome, stageId} = read(path.join(installer, 'operations', interrupted.id, 'operation.json'));
      operation = {state, sequence, ownerEpoch, planDigest, verification, recoveryOutcome, stageId};
      bundles = {};
      const exe = path.relative(old.app, old.exe), asar = path.relative(old.app, old.asar);
      for (const [name, root] of Object.entries({active: old.app,
        backup: path.join(path.dirname(old.app), '.nora-previous-' + plan.token),
        failed: path.join(path.dirname(old.app), '.nora-failed-' + plan.token)})) {
        if (!fs.existsSync(root)) {bundles[name] = null; continue;}
        const stat = fs.lstatSync(root, {bigint: true});
        if (!stat.isDirectory()) {bundles[name] = {directory: false}; continue;}
        const hashes = {};
        for (const relative of [exe, asar]) {
          const file = path.join(root, relative);
          if (fs.existsSync(file) && fs.lstatSync(file).isFile()) hashes[path.basename(file)] = await hash(file);
        }
        bundles[name] = {device: String(stat.dev), inode: String(stat.ino), hashes};
      }
    }
    try {actors = collectActors();} catch (cause) {actors = {error: safeError(cause)};}
    if (candidateLog && fs.existsSync(candidateLog)) {
      const fd = fs.openSync(candidateLog, 'r');
      try {
        const size = fs.fstatSync(fd).size;
        const bytes = Buffer.alloc(Math.min(size, 32 * 1024));
        fs.readSync(fd, bytes, 0, bytes.length, size - bytes.length);
        log = bytes.toString('utf8');
      } finally {fs.closeSync(fd);}
    }
    fs.writeFileSync(path.join(evidence, 'app-diagnostic.json'), JSON.stringify({outcome: error ? 'failed' : 'passed',
      ...(error ? {error: safeError(error)} : {}), interrupted, recoveryAdmission, recoveryReply, operation, bundles, actors, files, candidateLog: log}, null, 2) + '\n',
    {flag: 'wx', mode: 0o600});
  }
  async function launch(release, version, bundleSha) {
    const debugPort = await unusedPort();
    const file = path.join(fixture, `app-${children.length}.log`);
    if (version !== oldVersion) candidateLog = file;
    const log = fs.openSync(file, 'a', 0o600);
    let child;
    try {child = spawn(old.exe, [`--nora-local-release=${release}`, '--remote-debugging-address=127.0.0.1', `--remote-debugging-port=${debugPort}`],
      {env, cwd: fixture, stdio: ['ignore', log, log]});}
    finally {fs.closeSync(log);}
    assert.ok(child.pid);
    children.push(child);
    const check = (method, parameters, seconds = 10) => evaluate(debugPort,
      `window.NoraLauncherBridge.${method}(${JSON.stringify(parameters) || ''})`, seconds);
    await waitFor(`native ${version} renderer and profile receipt`, 60, async () => {
      const value = read(path.join(installer, 'launcher-control.json'));
      return value.launcherVersion === version && value.noraHome === home && value.asar.sha256 === bundleSha
        && await evaluate(debugPort, 'Boolean(window.NoraLauncherBridge?.status)');
    });
    return {child, check, observe: expression => evaluate(debugPort, expression), trigger: (method, parameters) => evaluate(debugPort,
      `void window.NoraLauncherBridge.${method}(${JSON.stringify(parameters) || ''}).catch(e => console.error(e)); true`, 10, false)};
  }
  const running = child => child.exitCode === null && child.signalCode === null;
  const statusIsOld = value => value?.version === oldCore && value.systemReady === true && value.running === true;
  const http = route => fetch(`http://127.0.0.1:${port}${route}`, {signal: AbortSignal.timeout(10000)});
  const installReceipt = path.join(home, 'tavern/tavern-updates/installed.json');
  try {
    let session = await launch(newer, oldVersion, old.asarSha);
    await session.check('start', {port, service: 'tavern'}, 120);
    const oldService = await waitFor('Tavern started by the real old APP', 90, async () => {
      const value = await session.check('status'); return statusIsOld(value) && value.pid && value;
    });
    console.log('The authentic old Intel APP started the verified v2.6.4 Tavern');
    assert.equal(read(installReceipt).commit, source.baseline.commit);
    assert.equal((await http('/api/nora-boot/shell?lang=zh-cn')).status, 200);
    const user = path.join(home, 'tavern/tavern-state/native/default-user');
    const settings = path.join(user, 'settings.json');
    const settingsValue = read(settings); settingsValue.username = 'intel-rollback-fixture';
    fs.writeFileSync(settings, JSON.stringify(settingsValue));
    const hermesConfig = path.join(home, 'hermes/config.yaml');
    fs.appendFileSync(hermesConfig, '\nnora_qa_intel_preference: preserve-me\n');
    const protectedFiles = [hermesConfig, path.join(home, 'hermes/.env'), installReceipt,
      ...regularFiles(path.join(user, 'nora-world-core/worlds')), ...regularFiles(path.join(user, 'chats'))];
    assert.ok(protectedFiles.some(file => file.endsWith('.jsonl')));
    const before = await Promise.all(protectedFiles.map(hash));
    const offer = await session.check('checkUpdate', undefined, 30);
    assert.equal(offer.releaseTag, `v${targetVersion}`);
    assert.equal(offer.launcherUpdateAvailable, true);
    assert.equal(offer.releaseAvailable, true);
    const cutter = spawn('python3', ['-B', '-c', cut, fixture, home, old.exe, old.asar, incoming.exeSha, incoming.asarSha],
      {stdio: ['ignore', 'pipe', 'inherit']});
    children.push(cutter);
    const cutDone = new Promise((resolve, reject) => {
      let stdout = '';
      cutter.stdout.on('data', value => {stdout += value;});
      cutter.once('error', reject);
      cutter.once('close', code => code === 0 ? resolve(JSON.parse(stdout)) : reject(new Error(`Pre-ACK cutter exited ${code}`)));
    });
    cutDone.catch(() => {});
    await session.trigger('update', {port, tag: offer.releaseTag, includeLauncher: true});
    interrupted = await cutDone;
    const failed = await waitFor('immutable old helper rollback blocked by Crashpad', 90, () => {
      const value = read(path.join(interrupted.job, 'status.json'));
      return value.status === 'recovery-failed' && value;
    });
    assert.match(failed.rollbackError?.message || '', /启动器仍在运行/);
    const reporter = JSON.parse(command('python3', ['-B', '-c', crashCensus, fixture, home, interrupted.job]));
    assert.equal(reporter.length, 1, 'The old signed APP must actually leave one owned Crashpad blocking recovery');
    const jobSeal = await Promise.all(['plan.json', 'replace.py'].map(name => hash(path.join(interrupted.job, name))));
    console.log('The pre-ACK cut left the immutable old helper blocked by the exact Crashpad');
    assert.equal((await http('/')).status, 200);
    assert.equal(await hash(old.exe), incoming.exeSha);
    assert.equal(await hash(old.asar), incoming.asarSha);
    session = await launch(newer, incoming.version, incoming.asarSha);
    recoveryAdmission = await waitFor('original recovery action after candidate startup work ends', 120, async () => {
      const pending = await session.check('status');
      if (pending.busy !== false || pending.launcherRecovery?.canRecover !== true
          || pending.launcherRecovery.operationId !== interrupted.id) return false;
      const enabled = await session.observe(`(()=>{const button=document.getElementById('recoverLauncher');
        return Boolean(button&&!button.disabled&&!button.hidden&&button.getBoundingClientRect().width>0);})()`);
      return enabled && {busy: false, originalId: interrupted.id, visibleEnabledAction: true};
    });
    try {recoveryReply = {value: await session.check('recoverLauncher', undefined, 110)};}
    catch (error) {recoveryReply = {error: safeError(error)};}
    const recovered = await waitFor('candidate replacement helper restored the old APP and exited', 120, async () => {
      const value = read(path.join(interrupted.job, 'recovery.json'));
      return value.phase === 'restored' && value.diagnosticVerification === 'confirmed' && !running(session.child)
        && value.operationId === interrupted.id && value.planDigest === interrupted.digest
        && !sameLiveProcess(value.workerPid, value.workerCreationTime)
        && await hash(old.exe) === old.exeSha && await hash(old.asar) === old.asarSha && value;
    });
    assert.equal(sameLiveProcess(reporter[0].pid, reporter[0].birth), false);
    assert.equal((await http('/')).status, 200);
    let reopen;
    if (recovered.launchAttempted === true) {
      reopen = await waitFor('automatically relaunched original APP process and verified registration', 60, () => {
        const receipt = read(path.join(installer, 'launcher-control.json'));
        if (receipt.launcherVersion !== oldVersion || receipt.noraHome !== home || receipt.executable.path !== old.exe
            || receipt.executable.sha256 !== old.exeSha || receipt.asar.sha256 !== old.asarSha) return false;
        const actors = collectActors().filter(actor => actor.exe === old.exe && actor.birth > recovered.workerCreationTime
          && actor.state !== 'zombie' && !actor.args.some(arg => arg.startsWith('--type=') || arg.startsWith('--nora-self-update=')));
        return actors.length === 1 && {method: 'automatic-ordinary-launch', pid: actors[0].pid, birth: actors[0].birth};
      });
    } else {
      assert.equal(recovered.appSegmentOnly, true, 'A historical APP-only file restoration requires an ordinary reopen');
      session = await launch(older, oldVersion, old.asarSha);
      reopen = {method: 'manual-ordinary-launch', pid: session.child.pid};
    }
    const operation = await waitFor('ordinary old APP reopen settles the same operation', 90, () => {
      const value = read(path.join(installer, 'operations', interrupted.id, 'operation.json'));
      return value.state === 'rolled-back' && value.verification === 'confirmed' && value;
    });
    assert.equal(operation.planDigest, interrupted.digest);
    const runtime = read(path.join(baseline, 'nora-hermes-runtime.json'));
    const hermes = path.join(home, 'hermes');
    const restored = recovered.launchAttempted === true
      ? JSON.parse(execFileSync(path.join(hermes, runtime.venvPython), ['-B', path.join(old.app, 'Contents/Resources/launcher_bridge.py'),
        '--nora-home', home, '--hermes-home', hermes, '--install-root', path.join(home, 'tavern'), '--port', String(port), 'status'],
      {encoding: 'utf8', timeout: 90000, env: {...env, PYTHONPATH: path.join(hermes, 'hermes-agent'),
        HERMES_INSTALL_DIR: path.join(hermes, 'hermes-agent'), TAVERN_NODE_EXECUTABLE: path.join(hermes, runtime.nodeBin, 'node')}}).trim())
      : await session.check('status');
    assert.equal(statusIsOld(restored), true); assert.equal(restored.pid, oldService.pid);
    assert.deepEqual(await Promise.all(protectedFiles.map(hash)), before);
    assert.deepEqual(await Promise.all(['plan.json', 'replace.py'].map(name => hash(path.join(interrupted.job, name)))), jobSeal);
    assert.equal(read(settings).username, 'intel-rollback-fixture');
    if (recovered.launchAttempted !== true) await session.check('stop', {port}, 60);
    await saveRecoveryDiagnostic();
    return {schema: 'nora-intel-app-rollback/1', source, identity, method: 'native packaged Electron preload IPC via private loopback CDP',
      baseline: {appArchiveSha256: oldReceipt.archiveSha256, executableSha256: old.exeSha, asarSha256: old.asarSha},
      target: {appArchiveSha256: desc.sha256, executableSha256: incoming.exeSha, asarSha256: incoming.asarSha, helperSha256: helperSha},
      interruption: {...interrupted, reporter: reporter[0]}, reopen, operation: {state: operation.state, verification: operation.verification},
      protectedFiles: Object.fromEntries(protectedFiles.map((file, index) => [path.relative(home, file), before[index]])), sameTavernPid: true};
  } catch (error) {
    try {await saveRecoveryDiagnostic(error);} catch (cause) {console.error('Diagnostic capture failed', safeError(cause));}
    throw error;
  } finally {
    for (const child of children) if (running(child)) child.kill('SIGTERM');
  }
}

module.exports = {qualifyApp};
