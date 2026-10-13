'use strict';
// This gate uses Chromium networking, never ELECTRON_RUN_AS_NODE or a fake fetch.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const {spawn, execFileSync} = require('node:child_process');
const desktop = process.env.NORA_ELECTRON_NETWORK_DESKTOP || (fs.existsSync(path.resolve(__dirname, '../../launcher/desktop/release-network.js'))
  ? path.resolve(__dirname, '../../launcher/desktop') : path.resolve(__dirname, '../installer/desktop'));
const hash = file => crypto.createHash('sha256').update(
  (process.versions.electron && file.endsWith('.asar') ? require('original-fs') : fs).readFileSync(file)).digest('hex');

async function chromiumGate() {
  const {app, net, session, BrowserWindow} = require('electron');
  const https = require('node:https');
  const http = require('node:http');
  const sockets = require('node:net');
  const directory = process.env.NORA_ELECTRON_NETWORK_HOME;
  assert.ok(directory && fs.statSync(directory).isDirectory());
  app.setPath('userData', path.join(directory, 'user-data'));
  app.setPath('sessionData', path.join(directory, 'session-data'));
  app.commandLine.appendSwitch('disable-gpu');
  app.commandLine.appendSwitch('disable-background-networking');
  app.commandLine.appendSwitch('disable-component-update');
  if (process.platform === 'darwin') app.setActivationPolicy('prohibited');
  const originalExecutable = process.env.NORA_ELECTRON_NETWORK_ORIGINAL_EXECUTABLE || process.execPath;
  const asar = process.env.NORA_ELECTRON_NETWORK_ASAR;
  const report = {schema: 'nora-electron-network/1', platform: process.platform, arch: process.arch,
    scope: asar ? 'packaged-network-modules-in-native-chromium' : 'source-network-modules-in-native-chromium',
    versions: {electron: process.versions.electron, node: process.versions.node},
    executable: {path: originalExecutable, sha256: hash(originalExecutable)},
    runtimeExecutable: {path: process.execPath, sha256: hash(process.execPath)},
    asar: asar ? {path: asar, sha256: hash(asar)} : null,
    moduleHashes: Object.fromEntries(['release-network.js', 'release-sources.js', 'launcher-errors.js', 'release-sources.json']
      .map(name => [name, hash(path.join(desktop, name))])), actualChromiumNet: true,
    requests: [], tunnels: [], assertions: {}};
  const liveSockets = new Set();
  let origin, proxy, finishing=false;
  const finish = async (error) => {
    if(finishing)return;
    finishing=true;
    if (error) report.failure = {message: error.message, code: error.code, stack: error.stack};
    clearTimeout(deadline);
    for (const socket of liveSockets) socket.destroy();
    await Promise.all([origin, proxy].filter(Boolean).map(server => new Promise(resolve => server.close(resolve))));
    report.windowCount = BrowserWindow.getAllWindows().length;
    fs.writeFileSync(path.join(directory, 'report.json'), JSON.stringify(report, null, 2) + '\n');
    if (error) console.error(error.stack);
    app.exit(error ? 1 : 0);
  };
  const deadline = setTimeout(() => finish(new Error('The real Electron network gate exceeded 30 seconds')), 30000);
  try {
    if(process.env.NORA_ELECTRON_NETWORK_TEST_FAULT==='ignore-term'){
      await app.whenReady();
      process.on('SIGTERM',()=>{});
      console.log(JSON.stringify({fixture:'ignore-term',ready:true,pid:process.pid}));
      await new Promise(()=>{});
      return;
    }
    assert.ok(process.versions.electron, 'Chromium must be active');
    assert.equal(report.runtimeExecutable.sha256, report.executable.sha256, 'The executed native runtime must have the exact candidate executable bytes');
    const key = path.join(directory, 'key.pem'), cert = path.join(directory, 'cert.pem');
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
      '-subj', '/CN=nora-network-fixture', '-addext',
      'subjectAltName=DNS:jihulab.com,DNS:api.github.com,DNS:github.com,DNS:downloads.sourceforge.net,DNS:zenlayer.dl.sourceforge.net',
      '-keyout', key, '-out', cert], {stdio: 'ignore'});
    const certificate = new crypto.X509Certificate(fs.readFileSync(cert));
    const allowed = new Set(['jihulab.com', 'api.github.com', 'downloads.sourceforge.net', 'zenlayer.dl.sourceforge.net']);
    const bytes = Buffer.alloc(512 * 1024, 0x5a);
    let transferFinished = false, stalledClosed = false, conditionalResponses = 0;
    origin = https.createServer({key: fs.readFileSync(key), cert: fs.readFileSync(cert)}, (request, response) => {
      report.requests.push({host: request.headers.host, path: request.url, method: request.method});
      if (['jihulab.com','api.github.com', 'github.com'].includes(request.headers.host)) {response.writeHead(503); response.end('fixture unavailable'); return;}
      if (request.headers.host === 'downloads.sourceforge.net') {
        response.writeHead(302, {Location: request.url.endsWith('/bad.zip') ? 'https://untrusted.example' + request.url
          : 'https://zenlayer.dl.sourceforge.net' + request.url + '?viasf=1'});
        response.end('fixture redirect'); return;
      }
      if (request.url.includes('/stream.zip') || request.url.includes('/stall.zip') || request.url.includes('/idle.zip')) {
        response.writeHead(200, {'Content-Type': 'application/octet-stream', 'Content-Length': bytes.length, ETag: '"fixture-archive"'});
        response.write(bytes.subarray(0, 4096));
        if (!request.url.includes('/stream.zip')) {response.once('close', () => {stalledClosed = true;}); return;}
        setTimeout(() => {transferFinished = true; response.end(bytes.subarray(4096));}, 50);
        return;
      }
      if (request.url === '/bodyless-204.json' || request.url === '/bodyless-304.json') {
        response.writeHead(request.url.includes('204') ? 204 : 304, {ETag: '"bodyless"'}); response.end(); return;
      }
      if (request.headers['if-none-match']) {
        conditionalResponses++;
        response.writeHead(304, {ETag: '"different-channel"'}); response.end(); return;
      }
      response.writeHead(200, {'Content-Type': 'application/json', ETag: '"fixture-channel"'});
      response.end(JSON.stringify({tag_name: 'v2.4.4', draft: false, prerelease: false}));
    });
    await new Promise(resolve => origin.listen(0, '127.0.0.1', resolve));
    proxy = http.createServer((_request, response) => {response.writeHead(502); response.end();});
    proxy.on('connect', (request, socket, head) => {
      report.tunnels.push(request.url);
      const host=request.url.split(':')[0];
      try {
        assert.ok(allowed.has(host), 'The fixture must never connect to another host');
        if(process.env.NORA_ELECTRON_NETWORK_TEST_FAULT==='proxy-callback')
          throw Object.assign(new Error('Injected native proxy callback failure'),{code:'FIXTURE_PROXY_CALLBACK'});
      }catch(error){
        socket.destroy();
        finish(error).catch(failure=>{console.error(failure.stack);app.exit(1);});
        return;
      }
      const upstream = sockets.connect(origin.address().port, '127.0.0.1', () => {
        socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        if (head.length) upstream.write(head);
        socket.pipe(upstream); upstream.pipe(socket);
      });
      for (const connection of [socket, upstream]) {liveSockets.add(connection); connection.on('close', () => liveSockets.delete(connection));}
      upstream.on('error', () => socket.destroy()); socket.on('error', () => upstream.destroy());
    });
    await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve));
    await app.whenReady();
    // Trust only this test's certificate in this isolated session. Production
    // certificate handling and all product source validators remain unchanged.
    session.defaultSession.setCertificateVerifyProc((details, callback) => callback(
      allowed.has(details.hostname) && new crypto.X509Certificate(details.certificate.data).fingerprint256 === certificate.fingerprint256 ? 0 : -2));
    await session.defaultSession.setProxy({proxyRules: `http=127.0.0.1:${proxy.address().port};https=127.0.0.1:${proxy.address().port}`, proxyBypassRules: '<-loopback>'});
    const network = require(path.join(desktop, 'release-network'));
    const product = network.createReleaseNetwork({app, net, diagnostics: {write() {}, error() {}},
      policy: {maxAttempts: 1, totalBudgetMs: 5000, attemptTimeoutMs: 2000},
      routeFor: url => session.defaultSession.resolveProxy(url)});
    const result = await network.metadataJson('https://api.github.com/repos/LoveMaker-art/noras-tavern/releases/latest', {
      fetcher: product.fetch, policy: {maxAttempts: 1, totalBudgetMs: 5000, attemptTimeoutMs: 2000}});
    assert.equal(result.value.tag_name, 'v2.4.4');
    assert.deepEqual(report.requests.map(request => request.host), ['jihulab.com','api.github.com', 'downloads.sourceforge.net', 'zenlayer.dl.sourceforge.net']);
    assert.equal(result.responseSource, 'https://zenlayer.dl.sourceforge.net/project/nora-tavern/channels/stable.json');
    report.assertions.sourceFallback = true;
    report.assertions.manualRedirect = true;
    report.assertions.sessionProxy = true;
    const assetUrl = name => 'https://github.com/LoveMaker-art/noras-tavern/releases/download/v2.4.4/' + name;
    // GitHub file downloads are routed into the same controlled fixture too.
    allowed.add('github.com');
    const identity = asset => ({tag: 'v2.4.4', asset, size: bytes.length,
      sha256: crypto.createHash('sha256').update(bytes).digest('hex')});
    const progress = [];
    await network.downloadAsset({url: assetUrl('stream.zip'), fetcher: product.fetch,
      target: path.join(directory, 'stream.zip'), identity: identity('stream.zip'),
      policy: {downloadBudgetMs: 5000, attemptTimeoutMs: 1000}, onEvent: event => {
        if (event.event === 'progress' && event.current > 0) progress.push({current: event.current, transferFinished});
      }});
    assert.equal(hash(path.join(directory, 'stream.zip')), identity('stream.zip').sha256);
    assert.ok(progress.some(event => event.current === 4096 && !event.transferFinished), 'Progress must arrive while the archive is still streaming');
    assert.ok(report.requests.some(request => request.host === 'zenlayer.dl.sourceforge.net' && request.path.includes('/stream.zip')));
    report.assertions.streaming = true;
    const before = report.requests.length;
    await assert.rejects(network.downloadAsset({url: assetUrl('bad.zip'), fetcher: product.fetch,
      target: path.join(directory, 'bad.zip'), identity: identity('bad.zip'), policy: {downloadBudgetMs: 3000}}),
      error => error.code === 'VERIFICATION_FAILED');
    assert.equal(report.requests.slice(before).length, 3, 'The two unavailable sources precede SourceForge; an untrusted destination is refused before its request');
    assert.ok(!report.tunnels.some(value => value.startsWith('untrusted.example')));
    report.assertions.untrustedRedirectRefused = true;
    const controller = new AbortController();
    await assert.rejects(network.downloadAsset({url: assetUrl('stall.zip'), fetcher: product.fetch, signal: controller.signal,
      target: path.join(directory, 'stall.zip'), identity: identity('stall.zip'), policy: {downloadBudgetMs: 3000},
      onEvent: event => {if (event.event === 'progress' && event.current > 0) controller.abort();}}),
      error => error.name === 'AbortError' || error.cause?.name === 'AbortError');
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.equal(stalledClosed, true, 'Cancellation must close the actual Chromium request');
    report.assertions.abort = true;
    const started = Date.now();
    await assert.rejects(network.downloadAsset({url: assetUrl('idle.zip'), fetcher: product.fetch,
      target: path.join(directory, 'idle.zip'), identity: identity('idle.zip'),
      policy: {downloadBudgetMs: 300, backupBudgetMs: 150, attemptTimeoutMs: 100, downloadIdleTimeoutMs: 75}}),
      error => error.code === 'TIMEOUT');
    assert.ok(Date.now() - started < 1500, 'A stalled body must respect the finite source budget');
    report.assertions.deadline = true;
    let clock = Date.now();
    const metadataCache = network.createMetadataCache({ttlMs: 10, now: () => clock});
    const cacheOptions = {fetcher: product.fetch, metadataCache, policy: {totalBudgetMs: 2000, maxAttempts: 1}};
    await network.metadataJson('https://api.github.com/repos/LoveMaker-art/noras-tavern/releases/latest', cacheOptions);
    clock += 20;
    const refreshed = await network.metadataJson('https://api.github.com/repos/LoveMaker-art/noras-tavern/releases/latest', cacheOptions);
    assert.equal(conditionalResponses, 1);
    assert.equal(refreshed.source, 'network');
    assert.equal(refreshed.latestConfirmed, true);
    assert.equal(refreshed.value.tag_name, 'v2.4.4');
    report.assertions.conditionalCacheRecovery = true;
    const head = await product.readOnce('https://zenlayer.dl.sourceforge.net/bodyless-head.json', {method: 'HEAD', redirect: 'manual'});
    assert.equal(head.status, 200); assert.equal(head.body, null);
    for (const status of [204,304]) {
      const bodyless = await product.readOnce(`https://zenlayer.dl.sourceforge.net/bodyless-${status}.json`, {redirect: 'manual'});
      assert.equal(bodyless.status, status); assert.equal(bodyless.body, null);
      assert.equal(bodyless.headers.get('etag'), '"bodyless"');
    }
    await new Promise(resolve => setTimeout(resolve, 20));
    report.assertions.bodylessResponses = true;
    await finish();
  } catch (error) {await finish(error);}
}

if (process.versions.electron && !process.env.ELECTRON_RUN_AS_NODE) {
  chromiumGate().catch(error => {console.error(error.stack);require('electron').app.exit(1);});
} else {
  const {test} = require('node:test');
  const {captureChild,firstJsonLine,stopChild}=require('./launcher_test_lifecycle.cjs');
  async function executeGate({fault}={}) {
    const executable = process.env.NORA_ELECTRON || (() => {
      try {return require(path.join(desktop, 'node_modules/electron'));} catch {return null;}
    })();
    assert.ok(executable && fs.statSync(executable).isFile(), 'Set NORA_ELECTRON to the native Electron executable; this gate cannot run as Node');
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'nora-electron-network-'));
    const env = {...process.env, NORA_ELECTRON_NETWORK_HOME: directory};
    delete env.ELECTRON_RUN_AS_NODE;
    delete env.NORA_ELECTRON_NETWORK_TEST_FAULT;
    if(fault)env.NORA_ELECTRON_NETWORK_TEST_FAULT=fault;
    const child=spawn(executable,[__filename],{env,stdio:['ignore','pipe','pipe'],windowsHide:true});
    const captured=captureChild(child);
    let deadline;
    try {
      if(fault==='ignore-term'){
        const ready=await firstJsonLine(child);
        assert.equal(ready.fixture,'ignore-term');assert.equal(ready.ready,true);assert.equal(ready.pid,child.pid);
      }
      const closed=await Promise.race([captured.closed,new Promise(resolve=>{deadline=setTimeout(()=>resolve(null),fault==='ignore-term'?100:35000);})]);
      const result=closed||await stopChild(child,{graceMs:500,timeoutMs:5000});
      const report = fs.existsSync(path.join(directory, 'report.json')) ? JSON.parse(fs.readFileSync(path.join(directory, 'report.json'), 'utf8')) : null;
      if (report && !fault && process.env.NORA_ELECTRON_NETWORK_REPORT) fs.copyFileSync(path.join(directory, 'report.json'), process.env.NORA_ELECTRON_NETWORK_REPORT);
      if(captured.error)throw captured.error;
      if(fault!=='ignore-term')assert.equal(result.signal, null, `Electron terminated with ${result.signal}: ${captured.stderr}`);
      return {result,report,stderr:captured.stderr};
    } finally {
      clearTimeout(deadline);
      await stopChild(child,{graceMs:500,timeoutMs:5000});
      if(captured.didClose)fs.rmSync(directory,{recursive:true,force:true});
    }
  }
  test('real Electron uses the checked SourceForge redirect through its session proxy without a window', {timeout: 45000}, async () => {
      const {result,report,stderr}=await executeGate();
      assert.equal(result.code, 0, report?.failure?.stack || stderr);
      assert.equal(report.windowCount, 0);
      assert.equal(report.actualChromiumNet, true);
      for (const field of ['manualRedirect', 'sourceFallback', 'untrustedRedirectRefused', 'abort', 'sessionProxy', 'streaming', 'deadline']) assert.equal(report.assertions[field], true, field);
  });
  test('a native proxy callback failure retains its original error and closes without a blocking dialog', {timeout:45000}, async()=>{
    const {result,report,stderr}=await executeGate({fault:'proxy-callback'});
    assert.equal(result.code,1,stderr);
    assert.equal(report.failure.code,'FIXTURE_PROXY_CALLBACK');
    assert.match(report.failure.message,/Injected native proxy callback failure/);
    assert.equal(report.windowCount,0);
  });
  test('the native parent deadline waits for forced child closure when SIGTERM is ignored',
    {timeout:20000,skip:process.platform==='win32'?'Windows does not deliver a catchable POSIX SIGTERM':false},async()=>{
      const {result}=await executeGate({fault:'ignore-term'});
      assert.equal(result.signal,'SIGKILL');assert.equal(result.code,null);
    });
}
