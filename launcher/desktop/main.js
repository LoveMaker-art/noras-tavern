const { app, BrowserWindow, dialog, ipcMain, shell } = require('electron');
const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createDiagnostics } = require('./diagnostics');
const diagnostics = createDiagnostics({
  primary: () => path.join(installerDirectory(), 'install.log'),
  fallback: path.join(app.getPath('appData'), 'NoraTavern', 'diagnostics', 'install.log'),
});
for (const [name, value] of Object.entries(process.env)) {
  if (/(?:API_KEY|TOKEN|SECRET|PASSWORD|PAIR_CODE)$/i.test(name)) diagnostics.addSecret(value);
}
// Observe fatal startup errors without suppressing Electron's normal exit.
process.on('uncaughtExceptionMonitor', (error, origin) => diagnostics.error('main.uncaught', error, { origin }));
const { findBundledRuntime } = require('./runtime');
const releases = require('./releases');
const systemUpdate = require('./system-update');
const { testBuild, prepareTestPayload } = require('./test-build');
const { cleanupInstallTemps } = require('./install-cleanup');
const uninstall = require('./uninstall');
const locations = require('./install-location');
const SYSTEM_UNINSTALL = process.argv.find(value => value.startsWith('--nora-uninstall-plan='))?.slice('--nora-uninstall-plan='.length);
const LOCAL_TEST = testBuild(require('./package.json'));
const CHANNEL = require('./package.json').noraReleaseChannel || 'stable';
if (!['stable', 'beta'].includes(CHANNEL)) throw new Error('启动器发布通道无效。');
const ISOLATED_TEST = LOCAL_TEST || CHANNEL === 'beta';
const { consumeLines, externalUrl } = require('./process-output');
const {
  loadProviderModels,
  normalizeCustomBaseUrl,
  publicProviders,
  readVerifiedModel,
  requireProvider,
  testCustomModel,
  testProviderModel,
  writeVerifiedModel,
} = require('./model-config');

const WINDOW_WIDTH = 1120;
const WINDOW_HEIGHT = 680;
const DEFAULT_PORT = LOCAL_TEST ? 18999 : CHANNEL === 'beta' ? 18998 : 8799;
const MILESTONES = ['安装 Nora', '安装酒馆', '配置模型', '连接 ClawChat', '启动检查'];
const ANSI = /[\u001B\u009B][[\]()#;?]*(?:(?:(?:[a-zA-Z\d]*(?:;[-a-zA-Z\d/#&.:=?%@~_]+)*)?\u0007)|(?:(?:\d{1,4}(?:[;:]\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]))/g;
const MOCK_SCENARIO = !app?.isPackaged ? (process.argv.find((value) => value.startsWith('--nora-mock='))?.split('=')[1] || '') : '';
const WATCH_UI = !app?.isPackaged && process.argv.includes('--nora-watch');
let activeProcess = null;
let activeRun = false;
let modelBusy = false;
let statusRequest = null;
let cancelled = false;
let releaseAbort = null;
let updatingSystem = false;
let uninstalling = false;
let selectingLocation = false;
let selectedHome;
const LOCATION_SCOPE = LOCAL_TEST ? `test-${LOCAL_TEST.buildId}` : CHANNEL;

function installerRoot() {
  if (!app) return path.resolve(__dirname, '..');
  if (app.isPackaged) {
    const unpacked = path.join(process.resourcesPath, 'app.asar.unpacked');
    const packagedRoot = path.join(unpacked, 'ops', 'installer');
    if (fs.existsSync(packagedRoot)) return packagedRoot;
    return process.resourcesPath;
  }
  return path.resolve(__dirname, '..');
}

function defaultNoraHome() {
  if (CHANNEL === 'beta') {
    const base = process.platform === 'darwin' ? path.join(os.homedir(), 'Library')
      : process.platform === 'win32' ? (process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'))
      : path.join(os.homedir(), '.local', 'share');
    return path.join(base, 'NoraTavern-Beta');
  }
  if (LOCAL_TEST) {
    const base = process.platform === 'darwin' ? path.join(os.homedir(), 'Library')
      : (process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'));
    return path.join(base, 'NoraTavern-Tests', `launcher-${LOCAL_TEST.buildId}`);
  }
  if (process.env.NORA_TAVERN_HOME) {
    const root = path.resolve(process.env.NORA_TAVERN_HOME);
    if (root === path.parse(root).root || root === os.homedir()) throw new Error('请选择专属安装目录，不能直接使用用户目录或磁盘根目录。');
    return root;
  }
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'NoraTavern');
  }
  if (process.platform === 'win32') {
    return path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'NoraTavern');
  }
  return path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share'), 'nora-tavern');
}

function noraHome() {
  return selectedHome ??= locations.readLocation(defaultNoraHome(), LOCATION_SCOPE);
}

function locationStatus() {
  return { noraHome: noraHome(), canChooseDirectory: !activeRun && !modelBusy && !selectingLocation
    && !process.env.NORA_HERMES_HOME && !process.env.NORA_TAVERN_INSTALL_ROOT
    && locations.canChangeLocation(noraHome()) };
}

function hermesHome() {
  return isolatedPath((!ISOLATED_TEST && process.env.NORA_HERMES_HOME) || path.join(noraHome(), 'hermes'), 'Hermes');
}

function installRoot() {
  return isolatedPath((!ISOLATED_TEST && process.env.NORA_TAVERN_INSTALL_ROOT) || path.join(noraHome(), 'tavern'), 'Tavern');
}

function isolatedPath(value, label) {
  const canonical = input => {
    const full = path.resolve(input);
    if (fs.existsSync(full)) return fs.realpathSync(full);
    const parent = path.dirname(full);
    return parent === full ? full : path.join(canonical(parent), path.basename(full));
  };
  const root = canonical(noraHome());
  const target = canonical(value);
  if (target === root || !target.startsWith(`${root}${path.sep}`)) {
    throw new Error(`${label} 目录必须位于 Nora Tavern 隔离目录内。`);
  }
  return target;
}

function pathAdditions() {
  const home = hermesHome();
  if (process.platform === 'win32') {
    return [
      path.join(home, 'clawchat', 'liveware'),
      path.join(home, '.local', 'bin'),
      path.join(home, 'bin'),
      path.join(home, 'node'),
      path.join(home, 'hermes-agent'),
      path.join(home, 'hermes-agent', 'Scripts'),
      path.join(home, 'hermes-agent', 'venv', 'Scripts'),
    ].filter(Boolean);
  }
  return [
    path.join(home, 'clawchat', 'liveware'),
    path.join(home, '.local', 'bin'),
    path.join(home, 'bin'),
    path.join(home, 'node', 'bin'),
    path.join(home, 'hermes-agent'),
    path.join(home, 'hermes-agent', 'bin'),
    path.join(home, 'hermes-agent', 'venv', 'bin'),
  ];
}

function launcherEnv() {
  const env = {
    ...process.env,
    NORA_TAVERN_HOME: noraHome(),
    NORA_RELEASE_CHANNEL: CHANNEL,
    NORA_HERMES_HOME: hermesHome(),
    HERMES_HOME: hermesHome(),
    HERMES_INSTALL_DIR: path.join(hermesHome(), 'hermes-agent'),
    TAVERN_DATA_ROOT: installRoot(),
    PATH: [...pathAdditions(), process.env.PATH || ''].join(path.delimiter),
    PYTHONPATH: path.join(hermesHome(), 'hermes-agent'),
    PYTHONNOUSERSITE: '1',
    PYTHONUTF8: '1',
    PYTHONIOENCODING: 'utf-8',
    PIP_CACHE_DIR: path.join(noraHome(), 'cache', 'pip'),
    UV_CACHE_DIR: path.join(noraHome(), 'cache', 'uv'),
    npm_config_cache: path.join(noraHome(), 'cache', 'npm'),
    TMPDIR: path.join(noraHome(), 'cache', 'tmp'),
    TEMP: path.join(noraHome(), 'cache', 'tmp'),
    TMP: path.join(noraHome(), 'cache', 'tmp'),
  };
  if (process.platform === 'win32') {
    env.USERPROFILE = hermesHome();
    env.APPDATA = path.join(noraHome(), 'appdata', 'roaming');
    env.LOCALAPPDATA = path.join(noraHome(), 'appdata', 'local');
  } else {
    env.HOME = hermesHome();
    env.XDG_CACHE_HOME = path.join(noraHome(), 'cache');
    env.XDG_DATA_HOME = path.join(noraHome(), 'data');
  }
  return env;
}

function checkCommand(command, args = []) {
  const result = spawnSync(command, args, { env: launcherEnv(), stdio: 'ignore', timeout: 15000, windowsHide: true });
  return result.status === 0 ? { command, args } : null;
}

function findPython() {
  if (!app?.isPackaged && process.env.TAVERN_PYTHON && fs.existsSync(process.env.TAVERN_PYTHON)) {
    return { command: process.env.TAVERN_PYTHON, args: [] };
  }
  const home = hermesHome();
  const candidates = process.platform === 'win32'
    ? [
      path.join(home, 'hermes-agent', 'venv', 'Scripts', 'python.exe'),
    ]
    : [
      path.join(home, 'hermes-agent', 'venv', 'bin', 'python3'),
      path.join(home, 'hermes-agent', 'venv', 'bin', 'python'),
    ];
  for (const candidate of candidates.filter(Boolean)) {
    if (fs.existsSync(candidate)) return { command: candidate, args: [] };
  }
  return null;
}

function findHermes() {
  const name = process.platform === 'win32' ? 'hermes.exe' : 'hermes';
  const marker = path.join(hermesHome(), 'hermes-agent', '.hermes-bootstrap-complete');
  if (!fs.existsSync(marker)) return null;
  const directories = process.platform === 'win32'
    ? [path.join(hermesHome(), 'hermes-agent', 'venv', 'Scripts')]
    : [path.join(hermesHome(), 'hermes-agent', 'venv', 'bin')];
  for (const directory of directories) {
    const candidate = path.join(directory, name);
    if (candidate && fs.existsSync(candidate)) return candidate;
  }
  return null;
}

function installerDirectory() {
  return path.join(noraHome(), 'installer');
}

function installerStatePath() {
  return path.join(installerDirectory(), 'state.json');
}

function defaultInstallerState() {
  return {
    schema: 1,
    phase: 'idle',
    task: '',
    startedAt: null,
    updatedAt: Date.now(),
    error: '',
    setupCompleted: false,
    milestones: MILESTONES.map((label, index) => ({ index, label, state: 'pending', task: '' })),
  };
}

function readInstallerState() {
  try {
    const value = JSON.parse(fs.readFileSync(installerStatePath(), 'utf8'));
    return { ...defaultInstallerState(), ...value };
  } catch {
    return defaultInstallerState();
  }
}

function writeInstallerState(value) {
  fs.mkdirSync(installerDirectory(), { recursive: true });
  const next = { ...value, updatedAt: Date.now() };
  const target = installerStatePath();
  const temporary = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, target);
  return next;
}

function sanitizeLine(value) {
  return String(value || '').replace(ANSI, '').replace(/^\s*-e\s+/, '').trimEnd();
}

function recordEvent(message) {
  diagnostics.event(message);
  if (!['milestone', 'task', 'progress', 'log'].includes(message.event)) return;
  const state = readInstallerState();
  if (message.event === 'milestone' && Number.isInteger(message.index)) {
    state.milestones = state.milestones.map((item) => item.index === message.index
      ? { ...item, state: message.state || item.state, task: message.task || item.task }
      : item);
    state.task = message.task || state.task;
  } else if (message.event === 'task') {
    state.task = message.task || state.task;
    if (message.current && message.total) {
      state.progress = { current: message.current, total: message.total, ratio: message.current / message.total };
    }
  } else if (message.event === 'progress') {
    state.progress = message;
  }
  writeInstallerState(state);
}

function bridgeScript() {
  return path.join(installerRoot(), 'launcher_bridge.py');
}

function bridgeArgs(command, options = {}) {
  const python = findPython();
  if (!python) {
    throw new Error('未找到 Python。请先用整合包脚本安装，或安装带 Python 的 Hermes。');
  }
  return {
    command: python.command,
    args: [
      ...python.args.filter((arg) => arg !== '-V'),
      '-u',
      '-B',
      bridgeScript(),
      '--nora-home',
      noraHome(),
      '--hermes-home',
      hermesHome(),
      '--install-root',
      installRoot(),
      '--port',
      String(options.port || readInstallerState().port || DEFAULT_PORT),
      command,
      ...(options.service ? ['--service', options.service] : []),
      ...(options.releaseDir ? ['--release-dir', options.releaseDir] : []),
      ...(options.url ? [options.url] : []),
      ...(options.tag ? ['--tag', options.tag] : []),
    ],
  };
}

function nodeStatus(error = '') {
  const root = installRoot();
  const verifiedModel = readVerifiedModel(noraHome());
  const installed = fs.existsSync(path.join(root, 'apps', 'tavern-runtime', 'native-runtime.json'))
    && fs.existsSync(path.join(root, 'apps', 'tavern-runtime', 'native_lifecycle.py'));
  return {
    installed,
    systemReady: false,
    setupCompleted: false,
    hermesInstalled: Boolean(findHermes()),
    modelConfigured: false,
    modelProvider: verifiedModel?.provider || '',
    modelName: verifiedModel?.model || '',
    modelBaseUrl: verifiedModel?.baseUrl || '',
    running: false,
    gatewayRunning: false,
    clawchatConnected: false,
    clawchatPaired: false,
    busy: activeRun || modelBusy,
    port: DEFAULT_PORT,
    url: `http://127.0.0.1:${DEFAULT_PORT}`,
    home: noraHome(),
    noraHome: noraHome(),
    hermesHome: hermesHome(),
    installRoot: root,
    warning: error || undefined,
    installer: readInstallerState(),
    ...locationStatus(),
  };
}

function parseJsonLine(line) {
  try {
    return JSON.parse(line);
  } catch {
    return { event: 'log', line };
  }
}

function sendBridgeEvent(webContents, runId, message) {
  if (message.event !== 'result') message = diagnostics.clean(message);
  if (message.event === 'milestone' && message.index === 4 && readInstallerState().phase === 'installing') {
    message = { event: 'task', milestone: 1, task: '正在检查酒馆安装文件' };
  }
  recordEvent(message);
  if (message.event === 'diagnostic') return;
  if (webContents && !webContents.isDestroyed() && runId) {
    webContents.send(`nora:bridge-event:${runId}`, message);
  }
}

function runProcess(command, args, webContents, runId) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    let timedOut = false;
    diagnostics.write('process.start', { command: [command, ...args], cwd: installerRoot() });
    sendBridgeEvent(webContents, runId, { event: 'command', command: [command, ...args] });
    const proc = spawn(command, args, {
      env: { ...launcherEnv(), ...(command === process.execPath ? { ELECTRON_RUN_AS_NODE: '1' } : {}) },
      cwd: installerRoot(),
      detached: process.platform !== 'win32',
    });
    activeProcess = proc;
    diagnostics.write('process.spawned', { pid: proc.pid });
    proc.cancelSafe = !args.includes(path.join(__dirname, 'runtime-worker.js'));
    let errorMessage = '';
    const heartbeat = setInterval(() => {
      sendBridgeEvent(webContents, runId, { event: 'heartbeat', at: Date.now() });
    }, 1000);
    proc.stdin.end();
    const timeout = setTimeout(() => {
      timedOut = true;
      diagnostics.write('process.timeout', { pid: proc.pid, timeoutMs: 30 * 60 * 1000 });
      terminateProcess(proc);
    }, 30 * 60 * 1000);
    consumeLines(proc.stdout, (line) => {
        const clean = sanitizeLine(line);
        if (clean) sendBridgeEvent(webContents, runId, parseJsonLine(clean));
    });
    consumeLines(proc.stderr, (line) => {
        const clean = diagnostics.clean(sanitizeLine(line));
        errorMessage = (errorMessage + '\n' + clean).slice(-4000);
        if (clean) sendBridgeEvent(webContents, runId, { event: 'log', line: clean, stream: 'stderr' });
    });
    proc.on('error', error => { diagnostics.error('process.error', error, { pid: proc.pid }); clearInterval(heartbeat); clearTimeout(timeout); reject(error); });
    proc.on('close', (code, signal) => {
      diagnostics.write('process.exit', { pid: proc.pid, exitCode: code, signal, timedOut, cancelled, durationMs: Date.now() - started });
      clearInterval(heartbeat);
      clearTimeout(timeout);
      if (activeProcess === proc) activeProcess = null;
      if (code === 0) resolve();
      else reject(Object.assign(new Error(diagnostics.clean((errorMessage || `命令执行失败，退出码 ${code}`).trim())), { exitCode: code, signal }));
    });
  });
}

function terminateProcess(proc) {
  if (!proc?.pid || proc.exitCode !== null || proc.signalCode !== null) return;
  if (process.platform === 'win32') {
    spawn('taskkill.exe', ['/pid', String(proc.pid), '/t', '/f'], { windowsHide: true, stdio: 'ignore' }).on('error', () => proc.kill());
  } else {
    try { process.kill(-proc.pid, 'SIGTERM'); } catch { proc.kill('SIGTERM'); }
    const timer = setTimeout(() => {
      if (proc.exitCode !== null || proc.signalCode !== null) return;
      try { process.kill(-proc.pid, 'SIGKILL'); } catch { proc.kill('SIGKILL'); }
    }, 5000);
    timer.unref();
  }
}

function payloadDirectory() {
  return !app.isPackaged && process.env.NORA_LAUNCHER_PAYLOAD
    ? path.resolve(process.env.NORA_LAUNCHER_PAYLOAD) : path.join(installerRoot(), 'payload');
}

async function ensureHermesFromNode(webContents, runId, payloadRoot) {
  const bundle = findBundledRuntime(payloadRoot);
  if (!bundle) throw new Error('发布包缺少完整 Hermes 运行环境。');
  diagnostics.write('runtime.selected', { archive: bundle.archive, sha256: bundle.manifest.sha256,
    platform: bundle.manifest.platform, arch: bundle.manifest.arch,
    python: bundle.manifest.venvPython, components: bundle.manifest.components });
  if (findHermes()) {
    const marker = JSON.parse(fs.readFileSync(path.join(hermesHome(), 'hermes-agent', '.hermes-bootstrap-complete'), 'utf8'));
    if (marker.sha256 !== bundle.manifest.sha256) throw new Error('已有 Hermes 与目标完整系统版本不匹配。已保留原有配置，请使用匹配版本的完整包进行迁移。');
    sendBridgeEvent(webContents, runId, { event: 'task', task: 'Hermes 核心已就绪，继续初始化 Nora' });
    return;
  }
  if (!findBundledRuntime(payloadRoot)) {
    throw new Error('当前启动器缺少内置运行时，请使用完整整合包。开发测试请配置 NORA_LAUNCHER_PAYLOAD。');
  }
  fs.mkdirSync(installerDirectory(), { recursive: true });
  sendBridgeEvent(webContents, runId, { event: 'milestone', index: 0, state: 'running', task: '准备 Nora 核心' });
  await runProcess(process.execPath, [path.join(__dirname, 'runtime-worker.js'), payloadRoot, noraHome(), hermesHome()], webContents, runId);
  if (!findHermes()) throw new Error('内置 Nora 核心释放后未通过检查。');
  sendBridgeEvent(webContents, runId, { event: 'task', task: 'Hermes 核心已就绪，继续初始化 Nora' });
}

function runBridge(command, options = {}, webContents = null, runId = '') {
  return new Promise((resolve, reject) => {
    diagnostics.addSecret(options.code);
    const started = Date.now();
    let timedOut = false;
    let proc;
    try {
      const spec = bridgeArgs(command, options);
      if (command !== 'status') diagnostics.write('process.start', { command: [spec.command, ...spec.args], cwd: installerRoot() });
      proc = spawn(spec.command, spec.args, { env: launcherEnv(), cwd: installerRoot(), detached: command !== 'status' && process.platform !== 'win32', windowsHide: true });
      if (command !== 'status') diagnostics.write('process.spawned', { pid: proc.pid });
      if (command !== 'status') activeProcess = proc;
      proc.stdin.end(command === 'pair' ? JSON.stringify({ code: options.code }) : undefined);
    } catch (error) {
      diagnostics.error('bridge.spawn-error', error, { command });
      reject(error);
      return;
    }
    let result = null;
    let errorMessage = '';
    const heartbeat = setInterval(() => {
      sendBridgeEvent(webContents, runId, { event: 'heartbeat', at: Date.now() });
    }, 1000);
    const timeoutMs = command === 'status' ? 90000 : 30 * 60 * 1000;
    const timeout = setTimeout(() => {
      timedOut = true;
      diagnostics.write('process.timeout', { command, pid: proc.pid, timeoutMs });
      terminateProcess(proc);
    }, timeoutMs);
    consumeLines(proc.stdout, (line) => {
        const message = parseJsonLine(sanitizeLine(line));
        if (message.event === 'result') {
          result = { ...message };
          delete result.event;
        } else if (message.event === 'error') {
          errorMessage = diagnostics.clean(message.message || line);
        }
        if (command !== 'status') sendBridgeEvent(webContents, runId, message);
    });
    consumeLines(proc.stderr, (line) => {
      line = diagnostics.clean(line);
      errorMessage = (errorMessage + '\n' + line).slice(-4000);
      if (command !== 'status') {
          const clean = sanitizeLine(line);
          if (clean) sendBridgeEvent(webContents, runId, { event: 'log', line: clean, stream: 'stderr' });
      } else diagnostics.event({ event: 'log', stream: 'stderr', line, command });
    });
    proc.on('error', (error) => { diagnostics.error('bridge.process-error', error, { command, pid: proc.pid }); clearInterval(heartbeat); clearTimeout(timeout); reject(error); });
    proc.on('close', (code, signal) => {
      if (command !== 'status' || code !== 0) diagnostics.write('process.exit', { command, pid: proc.pid, exitCode: code, signal, timedOut, cancelled, durationMs: Date.now() - started });
      clearInterval(heartbeat);
      clearTimeout(timeout);
      if (activeProcess === proc) activeProcess = null;
      if (code === 0) {
        if (!result) { reject(new Error('后台没有返回操作结果。')); return; }
        resolve(result);
        return;
      }
      reject(Object.assign(new Error(diagnostics.clean((errorMessage || `命令执行失败，退出码 ${code}`).trim())), { exitCode: code, signal }));
    });
  });
}

async function stopForUpdate() {
  if (findPython()) await runBridge('stop');
}

async function performSystemUpdate(selectedPayload, payload, webContents) {
  if (hermesHome() !== path.join(noraHome(), 'hermes') || installRoot() !== path.join(noraHome(), 'tavern')) {
    throw new Error('完整系统更新仅支持启动器管理的专属安装目录。');
  }
  const target = JSON.parse(fs.readFileSync(path.join(selectedPayload, 'nora-system.json')));
  const before = await runBridge('status');
  if (releases.compare(before.version, target.version) !== -1) throw new Error('目标必须高于当前安装版本。');
  updatingSystem = true;
  const onEvent = message => sendBridgeEvent(webContents, payload.runId, message);
  try {
    return await systemUpdate.perform({ home: noraHome(), target: target.version, stop: stopForUpdate, onEvent,
      restoreRunning: async () => {
        if (before.setupCompleted && (before.running || before.gatewayRunning)) await runBridge('start', {
          port: payload.port, service: before.running && before.gatewayRunning ? 'all' : before.running ? 'tavern' : 'nora',
        }, webContents, payload.runId);
      },
      apply: async backup => {
        const bundle = findBundledRuntime(selectedPayload);
        const marker = JSON.parse(fs.readFileSync(path.join(hermesHome(), 'hermes-agent/.hermes-bootstrap-complete')));
        if (marker.sha256 !== bundle.manifest.sha256) {
          await runProcess(process.execPath, [path.join(__dirname, 'runtime-worker.js'), selectedPayload, noraHome(), hermesHome()], webContents, payload.runId);
          onEvent({ event: 'task', task: '保留模型、配对和会话配置' });
          await systemUpdate.restoreUserHome(path.join(backup, 'hermes'), hermesHome());
        }
        await runBridge('update', { port: payload.port, releaseDir: selectedPayload }, webContents, payload.runId);
      },
      verify: async () => {
        let result = await runBridge('status');
        if (!result.systemReady || releases.compare(result.version, target.version) !== 0) throw new Error('更新后的完整性或版本检查未通过。');
        if (before.setupCompleted) {
          await runBridge('finish-update');
          result = await runBridge('stop');
          if (before.running || before.gatewayRunning) result = await runBridge('start', {
            port: payload.port, service: before.running && before.gatewayRunning ? 'all' : before.running ? 'tavern' : 'nora',
          }, webContents, payload.runId);
        } else result = await runBridge('stop');
        return result;
      },
    });
  } finally { updatingSystem = false; }
}

function modelConfigScript() {
  return path.join(installerRoot(), 'model_config.py');
}

function runModelConfigHelper(payload) {
  diagnostics.addSecret(payload.key);
  return new Promise((resolve, reject) => {
    const python = findPython();
    if (!python) {
      reject(new Error('没有找到 Nora 的 Python 环境。'));
      return;
    }
    const proc = spawn(python.command, [
      ...python.args.filter((arg) => arg !== '-V'),
      '-u', '-B', modelConfigScript(),
    ], {
      env: launcherEnv(),
      cwd: path.join(hermesHome(), 'hermes-agent'),
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => proc.kill('SIGTERM'), 60000);
    proc.stdout.setEncoding('utf8');
    proc.stderr.setEncoding('utf8');
    proc.stdout.on('data', (chunk) => { stdout += chunk; });
    proc.stderr.on('data', (chunk) => { stderr += chunk; });
    proc.on('error', error => { clearTimeout(timer); reject(error); });
    proc.on('close', (code) => {
      clearTimeout(timer);
      const secret = String(payload.key || '');
      const clean = (value) => {
        const text = String(value || '');
        return (secret ? text.replaceAll(secret, '***') : text).trim();
      };
      let result;
      try {
        result = JSON.parse(stdout.trim().split(/\r?\n/).filter(Boolean).pop() || '{}');
      } catch {
        result = null;
      }
      if (code === 0 && result?.ok) resolve(result);
      else reject(new Error(clean(result?.error || stderr || '无法保存模型配置。')));
    });
    proc.stdin.end(JSON.stringify(payload));
  });
}

function createWindow() {
  const uiPath = path.join(installerRoot(), 'launcher-conversation-prototype.html');
  const win = new BrowserWindow({
    show: app.isPackaged || !process.argv.includes('--nora-test-hidden'),
    width: WINDOW_WIDTH,
    height: WINDOW_HEIGHT,
    useContentSize: true,
    minWidth: WINDOW_WIDTH,
    minHeight: WINDOW_HEIGHT,
    maxWidth: WINDOW_WIDTH,
    maxHeight: WINDOW_HEIGHT,
    resizable: false,
    title: CHANNEL === 'beta' ? '诺拉·酒馆 [Beta 测试]' : LOCAL_TEST ? '诺拉·酒馆 [本地候选测试]' : MOCK_SCENARIO ? '诺拉·酒馆 [界面模拟]' : '诺拉·酒馆',
    backgroundColor: '#111016',
    icon: path.join(installerRoot(), 'assets', 'tavern-icon-dbf4ecbd54ec.png'),
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.loadFile(uiPath, { query: MOCK_SCENARIO ? { mock: MOCK_SCENARIO } : { desktop: '1' } });
  if (ISOLATED_TEST) win.on('page-title-updated', event => event.preventDefault());
  win.webContents.setWindowOpenHandler(({ url }) => {
    try { shell.openExternal(externalUrl(url)).catch(() => {}); } catch {}
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', event => event.preventDefault());
  if (WATCH_UI) {
    let reloadTimer = null;
    const watcher = fs.watch(path.dirname(uiPath), { persistent: false }, (_event, filename) => {
      if (filename && ![path.basename(uiPath), 'launcher-controller.js'].includes(filename)) return;
      clearTimeout(reloadTimer);
      reloadTimer = setTimeout(() => win.webContents.reloadIgnoringCache(), 120);
    });
    win.on('closed', () => {
      clearTimeout(reloadTimer);
      watcher.close();
    });
  }
  win.on('close', (event) => {
    if (!activeRun && !modelBusy) return;
    event.preventDefault();
    dialog.showMessageBox(win, {
      type: 'info',
      title: '正在处理',
      message: '当前任务还没有结束',
      detail: '请等待完成，或先在启动器中取消。',
      buttons: ['知道了'],
    });
  });
}

async function confirmUninstall(planFile, onProgress = () => {}) {
  if (!app.isPackaged) throw new Error('开发模式不删除应用。请使用安装包测试卸载流程。');
  if (activeRun || modelBusy) throw new Error('请等待当前任务结束后再卸载。');
  const home = noraHome();
  const selection = await dialog.showMessageBox({
    type: 'question', title: '卸载诺拉·酒馆', message: '要保留数据吗？',
    detail: `保留数据：删除程序和缓存，保留世界、角色、聊天、配置及 Key，重装可继续使用。已有备份也会保留。\n\n彻底卸载：删除此目录内的所有数据，无法撤销。\n${home}\n\n不会卸载 ClawChat 客户端、删除云端联系人或撤销服务商 Key。`,
    buttons: ['取消', '保留数据卸载', '彻底卸载'], defaultId: 1, cancelId: 0, noLink: true,
  });
  if (selection.response === 0) return false;
  const mode = selection.response === 1 ? 'keep' : 'all';
  if (mode === 'all') {
    const confirmed = await dialog.showMessageBox({ type: 'warning', title: '确认彻底卸载',
      message: '永久删除本地程序、聊天数据和密钥？', detail: home,
      buttons: ['取消', '永久删除并卸载'], defaultId: 0, cancelId: 0, noLink: true });
    if (confirmed.response !== 1) return false;
  }
  activeRun = true;
  try {
    if (statusRequest) await statusRequest.catch(() => {});
    onProgress('正在停止诺拉与酒馆。');
    // Stop only services with this installation's ownership records. An error
    // aborts the uninstall rather than deleting files underneath a live service.
    if (findPython()) await runBridge('stop', { service: 'all' });
    else if (fs.existsSync(path.join(home, 'installer/gateway.json'))
      || fs.existsSync(path.join(installRoot(), 'tavern-state/native-runtime/runs'))) {
      throw new Error('缺少停止服务所需的运行环境。请先修复安装，再卸载；尚未删除文件。');
    }
    const appPath = process.platform === 'darwin' ? path.resolve(process.execPath, '../../..') : null;
    const plan = uninstall.makePlan({ home, hermesHome: hermesHome(), installRoot: installRoot(), mode, appPath, executable: process.execPath });
    if (process.platform === 'darwin' && (!appPath.endsWith('.app') || appPath.startsWith('/Volumes/'))) {
      throw new Error('请先将启动器移入“应用程序”，再执行卸载。');
    }
    if (!planFile) {
      const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'nora-uninstall-'));
      fs.chmodSync(directory, 0o700);
      planFile = path.join(directory, 'nora-uninstall.json');
      plan.parentPid = process.pid;
    }
    fs.writeFileSync(planFile, JSON.stringify(plan), { mode: 0o600 });
    onProgress('正在退出启动器，随后清理文件。');
    if (process.platform === 'darwin') {
      const child = spawn(process.execPath, [path.join(__dirname, 'uninstall.js'), planFile], {
        cwd: os.tmpdir(), env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, detached: true, stdio: 'ignore',
      });
      await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
      child.unref();
    }
    app.exit(0);
    return true;
  } finally { activeRun = false; }
}

async function beginUninstall(event) {
  if (!app.isPackaged) throw new Error('开发模式不会删除应用。请使用安装包测试卸载流程。');
  if (activeRun || modelBusy || uninstalling) throw new Error('请等待当前任务结束后再卸载。');
  uninstalling = true;
  try {
  if (process.platform === 'win32') {
    const directory = path.dirname(process.execPath);
    const candidates = fs.readdirSync(directory).filter(name => /^Uninstall .+\.exe$/i.test(name));
    if (candidates.length !== 1) throw new Error('未找到唯一的系统卸载程序，请使用 setup 安装版。');
    const file = path.join(directory, candidates[0]);
    const child = spawn(file, [], { detached: true, stdio: 'ignore', windowsHide: false });
    await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
    child.unref(); app.exit(0);
    return { started: true };
  }
  if (process.platform !== 'darwin') throw new Error('当前系统尚不支持此卸载流程。');
  return { started: await confirmUninstall(undefined, task => {
    if (!event.sender.isDestroyed()) event.sender.send('nora:uninstall-progress', task);
  }) };
  } finally { uninstalling = false; }
}

if (app && BrowserWindow && ipcMain && shell) {
  diagnostics.write('launcher.start', { version: app.getVersion(), channel: CHANNEL,
    platform: process.platform, arch: process.arch, osRelease: os.release(),
    node: process.versions.node, electron: process.versions.electron, executable: process.execPath });
  fs.mkdirSync(path.join(noraHome(), 'cache', 'tmp'), { recursive: true });
  uninstall.own(noraHome());
  app.setPath('userData', path.join(noraHome(), 'launcher'));
  const handle = (channel, fn) => ipcMain.handle(channel, (event, ...args) => {
    const expected = require('node:url').pathToFileURL(path.join(installerRoot(), 'launcher-conversation-prototype.html')).href;
    if (event.senderFrame !== event.sender.mainFrame || event.senderFrame.url.split('?')[0] !== expected || MOCK_SCENARIO) {
      throw new Error('启动器页面来源无效。');
    }
    if (uninstalling && channel !== 'nora:status') throw new Error('正在处理卸载，请稍候。');
    if (selectingLocation && channel !== 'nora:status') throw new Error('正在选择安装位置，请稍候。');
    return fn(event, ...args);
  });
  handle('nora:status', async () => {
    if (uninstalling || selectingLocation || modelBusy) return { ...nodeStatus(), busy: true };
    if (statusRequest) return statusRequest;
    statusRequest = (async () => {
    try {
      if (!activeRun && systemUpdate.pending(noraHome())) {
        activeRun = true;
        try { await systemUpdate.recover(noraHome(), () => stopForUpdate()); }
        finally { activeRun = false; }
      }
      let installer = readInstallerState();
      if (!activeRun && ['installing', 'start', 'stop', 'restart', 'pair', 'update', 'repair'].includes(installer.phase)) {
        installer = writeInstallerState({ ...installer, phase: 'error', task: '', error: '上次操作已中断，可以重新执行。' });
      }
      if (!findPython()) return nodeStatus();
      const runtime = await runBridge('status');
      return { ...runtime, installer: readInstallerState(), busy: activeRun || modelBusy, ...locationStatus() };
    } catch (error) {
      return nodeStatus(!findPython() ? '' : error.message);
    }
    })().finally(() => { statusRequest = null; });
    return statusRequest;
  });
  handle('nora:choose-directory', async event => {
    if (!locationStatus().canChooseDirectory) throw new Error('已有安装或任务正在进行，不能更改位置。');
    selectingLocation = true;
    try {
      if (statusRequest) await statusRequest.catch(() => {});
      const selection = await dialog.showOpenDialog(BrowserWindow.fromWebContents(event.sender), {
        title: '选择安装位置', buttonLabel: '选择此位置', defaultPath: path.dirname(noraHome()),
        properties: ['openDirectory', 'createDirectory'],
      });
      if (selection.canceled || !selection.filePaths.length) return { cancelled: true };
      selectedHome = locations.selectLocation(selection.filePaths[0], {
        currentHome: noraHome(), defaultHome: defaultNoraHome(), scope: LOCATION_SCOPE,
        appPath: app.isPackaged ? (process.platform === 'darwin' ? path.resolve(process.execPath, '../../..') : path.dirname(process.execPath)) : __dirname,
      });
      fs.mkdirSync(path.join(noraHome(), 'cache', 'tmp'), { recursive: true });
      return { cancelled: false, noraHome: noraHome() };
    } finally { selectingLocation = false; }
  });
  handle('nora:run', async (event, payload) => {
    if (modelBusy || activeRun) throw new Error('Nora 正在处理任务，请稍候。');
    if (!['install', 'start', 'stop', 'restart', 'pair', 'update', 'repair'].includes(payload?.action)) throw new Error('不支持的操作。');
    if (payload.port !== undefined && (!Number.isInteger(payload.port) || payload.port < 1024 || payload.port > 65535)) throw new Error('端口无效。');
    if (typeof payload.runId !== 'string' || !/^[\w-]{1,100}$/.test(payload.runId)) throw new Error('任务编号无效。');
    if (payload.tag !== undefined && !/^[a-zA-Z0-9._-]{1,100}$/.test(payload.tag)) throw new Error('版本编号无效。');
    if (payload.service !== undefined && (!['all', 'nora', 'tavern'].includes(payload.service)
      || !['start', 'stop', 'restart'].includes(payload.action))) throw new Error('服务目标无效。');
    activeRun = true;
    cancelled = false;
    diagnostics.addSecret(payload.code);
    diagnostics.begin(payload.runId, { action: payload.action, version: app.getVersion(), channel: CHANNEL,
      platform: process.platform, arch: process.arch, osRelease: os.release(),
      node: process.versions.node, electron: process.versions.electron });
    try {
      diagnostics.write('install.paths', { noraHome: noraHome(), hermesHome: hermesHome(),
        installRoot: installRoot(), payloadRoot: payloadDirectory() });
      let state = readInstallerState();
      state = writeInstallerState({
        ...state,
        port: payload.port || state.port || DEFAULT_PORT,
        phase: payload.action === 'install' ? 'installing' : payload.action,
        startedAt: Date.now(),
        error: '',
        task: payload.action === 'install' ? '准备安装' : state.task,
        setupCompleted: payload.action === 'install' ? false : Boolean(state.setupCompleted),
        milestones: payload.action === 'install'
          ? MILESTONES.map((label, index) => ({ index, label, state: 'pending', task: '' }))
          : state.milestones,
      });
      let selectedPayload;
      if (['install', 'update'].includes(payload.action)) {
        if (payload.action === 'update' && LOCAL_TEST) throw new Error('本地候选包不用于在线更新，请使用 Beta 发布包。');
        releaseAbort = new AbortController();
        try {
          selectedPayload = LOCAL_TEST
            ? await prepareTestPayload(payloadDirectory(), LOCAL_TEST, app.getVersion(),
              message => sendBridgeEvent(event.sender, payload.runId, message))
            : await releases.prepare({
            cacheRoot: path.join(noraHome(), 'cache', 'releases'), bundledRoot: payloadDirectory(),
            launcherVersion: app.getVersion(), signal: releaseAbort.signal,
            channel: CHANNEL, tag: payload.action === 'update' ? payload.tag : undefined,
            onEvent: message => sendBridgeEvent(event.sender, payload.runId, message),
          });
        } finally { releaseAbort = null; }
        diagnostics.write('release.selected', { payloadRoot: selectedPayload });
        if (cancelled) throw new Error('安装已取消。');
        if (payload.action === 'install') {
          const removed = cleanupInstallTemps(noraHome());
          if (removed.length) sendBridgeEvent(event.sender, payload.runId,
            { event: 'task', task: `已清理 ${removed.length} 个上次安装的临时目录` });
          await ensureHermesFromNode(event.sender, payload.runId, selectedPayload);
        }
      }
      if (cancelled) throw new Error('安装已取消。');
      const result = payload.action === 'update'
        ? await performSystemUpdate(selectedPayload, payload, event.sender)
        : await runBridge(payload.action, { port: payload.port, code: payload.code, tag: payload.tag, service: payload.service,
        ...(payload.action === 'install' ? { releaseDir: selectedPayload } : {}) }, event.sender, payload.runId);
      const finalState = readInstallerState();
      writeInstallerState({ ...finalState, phase: result.systemReady ? 'ready' : 'idle', setupCompleted: Boolean(result.setupCompleted), error: '', task: '' });
      diagnostics.finish('success');
      return result;
    } catch (error) {
      diagnostics.error('run.failed', error, { cancelled });
      try {
        const failed = readInstallerState();
        const milestones = failed.milestones.map((item) => item.state === 'running'
          ? { ...item, state: 'error', task: '失败' }
          : item);
        writeInstallerState({ ...failed, milestones, phase: cancelled ? 'cancelled' : 'error', error: cancelled ? '' : diagnostics.clean(error.message || String(error)) });
      } catch (stateError) { diagnostics.error('state.write-failed', stateError); }
      diagnostics.finish(cancelled ? 'cancelled' : 'error');
      error.message = diagnostics.clean(error.message || String(error));
      throw error;
    } finally {
      activeRun = false;
    }
  });
  handle('nora:cancel', async () => {
    if (updatingSystem) return { ok: false, warning: '正在替换并验证系统，请等待完成；失败时将自动恢复。' };
    if (releaseAbort) { cancelled = true; releaseAbort.abort(); return { ok: true }; }
    if (!activeProcess) return { ok: false, warning: '当前没有正在运行的任务。' };
    if (activeProcess.cancelSafe === false) return { ok: false, warning: '正在释放核心文件，请等待这一步完成。' };
    cancelled = true;
    terminateProcess(activeProcess);
    const state = readInstallerState();
    writeInstallerState({ ...state, phase: 'cancelled', task: '已取消', error: '' });
    return { ok: true };
  });
  handle('nora:open-logs', async () => {
    const installerLog = diagnostics.lastFile || path.join(installerDirectory(), 'install.log');
    const target = fs.existsSync(installerLog) ? installerLog
      : path.join(installRoot(), 'tavern-state', 'native-runtime', 'runs', 'production', 'native.log');
    if (!fs.existsSync(target)) return { ok: false, warning: '日志文件还不存在。' };
    const openError = await shell.openPath(target);
    if (openError) return { ok: false, warning: openError };
    return { ok: true };
  });
  handle('nora:model-providers', async () => {
    if (!findHermes()) return { ok: false, warning: '请先安装 Nora。', providers: [] };
    return { ok: true, providers: publicProviders(), current: readVerifiedModel(noraHome()) };
  });
  handle('nora:model-options', async (_event, payload) => {
    if (!findHermes()) throw new Error('请先安装 Nora。');
    return { ok: true, ...(await loadProviderModels(payload?.provider, payload?.key)) };
  });
  handle('nora:model-save-test', async (_event, payload) => {
    if (activeRun || modelBusy) throw new Error('Nora 正在处理其他任务，请稍候。');
    const provider = requireProvider(payload?.provider);
    const key = String(payload?.key || '').trim();
    diagnostics.addSecret(key);
    const model = String(payload?.model || '').trim();
    const baseUrl = provider.id === 'custom' ? normalizeCustomBaseUrl(payload?.baseUrl) : '';
    if (!key || key.length > 8192 || /[\r\n]/.test(key)) throw new Error('请输入有效的 API Key。');
    if (!model || model.length > 240 || /[\r\n]/.test(model)) throw new Error('请选择模型。');
    modelBusy = true;
    recordEvent({ event: 'milestone', index: 2, state: 'running', task: '正在测试 Nora' });
    try {
      if (statusRequest) await statusRequest.catch(() => {});
      const normalized = await runModelConfigHelper({
        action: 'normalize',
        provider: provider.id,
        keyEnv: provider.keyEnv,
        model,
        baseUrl,
      });
      if (provider.id === 'custom') {
        await testCustomModel(baseUrl, key, normalized.model);
      } else {
        await testProviderModel(normalized.provider, key, normalized.model);
      }
      const saved = await runModelConfigHelper({
        action: 'save',
        provider: provider.id,
        keyEnv: provider.keyEnv,
        key,
        model: normalized.model,
        baseUrl,
      });
      let tavern = { ok: true, changed: false, reason: 'setup-complete' };
      if (!readInstallerState().setupCompleted) {
        // A previous verification must not let a restarted launcher skip a
        // failed first-install Tavern synchronization.
        fs.rmSync(path.join(installerDirectory(), 'model.json'), { force: true });
        recordEvent({ event: 'milestone', index: 2, state: 'running', task: '正在同步酒馆模型' });
        tavern = await runModelConfigHelper({
          action: 'sync-tavern', provider: provider.id, keyEnv: provider.keyEnv,
          key, model: saved.model, baseUrl, port: readInstallerState().port || DEFAULT_PORT,
        });
      }
      writeVerifiedModel(noraHome(), saved);
      const verification = await runBridge('verify-model');
      if (!verification.ok) throw new Error(verification.error || '模型配置复核未通过。');
      recordEvent({ event: 'milestone', index: 2, state: 'done', task: '模型配置完成' });
      return { ok: true, provider: saved.provider, model: saved.model, baseUrl: saved.baseUrl || '', tavern };
    } catch (error) {
      diagnostics.error('model.failed', error);
      recordEvent({ event: 'milestone', index: 2, state: 'error', task: '模型配置未完成' });
      error.message = diagnostics.clean(error.message || String(error));
      throw error;
    } finally {
      modelBusy = false;
    }
  });
  handle('nora:open-clawchat', async () => {
    await shell.openExternal('https://clawling.com/zh/chat/#get');
    return { ok: true };
  });
  handle('nora:open-clawchat-app', async () => {
    try {
      await shell.openExternal('clawchat://');
      return { ok: true };
    } catch {
      return { ok: false };
    }
  });
  handle('nora:open-settings', async () => {
    const target = path.join(hermesHome(), 'config.yaml');
    if (!fs.existsSync(target)) return { ok: false, warning: '配置文件还不存在。' };
    await shell.openPath(target);
    return { ok: true };
  });
  handle('nora:open-directory', async () => {
    const error = await shell.openPath(noraHome());
    if (error) throw new Error(error);
    return { ok: true };
  });
  handle('nora:check-update', async () => {
    if (activeRun || modelBusy) throw new Error('请等待当前任务完成。');
    return releases.check({ installRoot: installRoot(), launcherVersion: app.getVersion(), channel: CHANNEL });
  });
  handle('nora:uninstall', beginUninstall);
  handle('nora:open-external', async (_event, url) => {
    await shell.openExternal(externalUrl(url));
    return { ok: true };
  });

  if (!app.requestSingleInstanceLock()) app.quit();
  else app.whenReady().then(async () => {
    if (!SYSTEM_UNINSTALL) return createWindow();
    try {
      const destination = path.resolve(SYSTEM_UNINSTALL);
      if (process.platform !== 'win32' || path.basename(destination) !== 'nora-uninstall.json'
        || !destination.startsWith(path.resolve(os.tmpdir()) + path.sep)) throw new Error('系统卸载请求无效。');
      if (!await confirmUninstall(destination)) app.exit(1);
    } catch (error) { dialog.showErrorBox('卸载未完成', error.message); app.exit(1); }
  });
  app.on('second-instance', () => { const win = BrowserWindow.getAllWindows()[0]; if (win) { if (win.isMinimized()) win.restore(); win.show(); win.focus(); } });
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
  app.on('activate', () => {
    const windows = BrowserWindow.getAllWindows();
    if (windows.length === 0) createWindow();
    else windows[0].show();
  });
}
