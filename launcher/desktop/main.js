const { app, BrowserWindow, dialog, ipcMain, shell, net, session, crashReporter } = require('electron');
const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createDiagnostics } = require('./diagnostics');
const {successResult,failureResult,verifyWorkflowResult} = require('./operation-result');
const operationLock = require('./operation-lock');
const {createOperationController} = require('./operation-state');
const {createEvidenceStore} = require('./evidence-store');
const {acquireInspected} = require('./operation-inspection');
const { createTelemetry } = require('./telemetry');
const { launcherError, describeError } = require('./launcher-errors');
const { formatUserError } = require('./error-presentation');
const { createFaultPackets } = require('./fault-packet');
let telemetry;
const trackLauncher = (action, stage, work) => telemetry ? telemetry.track(action,stage,work)
  : diagnostics.scope(require('node:crypto').randomUUID(),{action},work);
const diagnostics = createDiagnostics({
  primary: () => path.join(installerDirectory(), 'install.log'),
  fallback: path.join(app.getPath('appData'), 'NoraTavern', 'diagnostics', 'install.log'),
});
const faultPackets = createFaultPackets({clean:diagnostics.clean,roots:() => [installerRoot(),noraHome(),hermesHome(),installRoot(),os.homedir()]});
const operationEvidence = createEvidenceStore({directory:installerDirectory,clean:diagnostics.clean});
let nativeCrashes;
function recordNativeFailure(type,evidence){
  return trackLauncher('launcher','idle',async()=>{
    const error=launcherError(`Native ${type} process failure: ${JSON.stringify(evidence)}`,{
      code:type==='renderer'?'RENDERER_GONE':'PROCESS_EXIT',source:'launcher_process',site:'launcher.window',
      exitCode:evidence.exitCode,context:evidence,
    });
    diagnostics.error('native-crash.failed',error);
    return {diagnosticError:error};
  }).catch(()=>diagnostics.write('native-crash.diagnostic',{code:'native_crash_record_failed'}));
}
const processSite = command => ['start','stop','pair'].includes(command) ? `process.${command}` : 'process.run';
function launcherBuild() {
  // Packagers may remove package.json.build. Hash shipped code directly;
  // unavailable diagnostic metadata must not disable reporting.
  try {
    const hash = require('node:crypto').createHash('sha256');
    const resources = ['replace-launcher.py','nora_profile.py','nora_system.py','launcher-conversation-prototype.html',
      'launcher-controller.js','launcher_services.py','launcher_bridge.py','model_config.py','bootstrap.py','update_recovery.py','error_diagnostics.py'];
    for (const [directory, names] of [[__dirname,fs.readdirSync(__dirname).filter(name => /\.(?:js|json)$/.test(name)).sort()],
      [installerRoot(),resources]]) {
      for (const name of names) {
        const file = path.join(directory,name);
        if (fs.existsSync(file) && fs.statSync(file).isFile()) hash.update(name).update(fs.readFileSync(file));
      }
    }
    return hash.digest('hex');
  } catch { return ''; }
}
const { createReleaseNetwork } = require('./release-network');
const releaseNetwork = createReleaseNetwork({ app, net, diagnostics, onRetry: error => telemetry?.report(error),
  routeFor:async url=>{await app.whenReady();return session.defaultSession.resolveProxy(url);}});
const localReleaseDirectory = process.argv.find(value => value.startsWith('--nora-local-release='))?.slice('--nora-local-release='.length);
const updateFetch = localReleaseDirectory
  ? require('./local-release').createLocalRelease(localReleaseDirectory) : releaseNetwork.fetch;
for (const [name, value] of Object.entries(process.env)) {
  if (/(?:API_KEY|TOKEN|SECRET|PASSWORD|PAIR_CODE)$/i.test(name)) diagnostics.addSecret(value);
}
// Observe fatal startup errors without suppressing Electron's normal exit.
process.on('uncaughtExceptionMonitor', (error, origin) => {
  diagnostics.error('main.uncaught', error, { origin });
  telemetry?.report(error, {source:'launcher',site:'launcher.main'});
});
const { findBundledRuntime } = require('./runtime');
const releases = require('./releases');
let releaseCheckRequest=null,releaseMetadataState=null;
function releaseMetadataCache(){
  const file=path.join(noraHome(),'cache/releases/metadata.json');
  if(releaseMetadataState?.file!==file)releaseMetadataState={file,cache:releases.createMetadataCache({file})};
  return releaseMetadataState.cache;
}
function checkRelease(){
  if(releaseCheckRequest)return releaseCheckRequest;
  releaseCheckRequest=trackLauncher('check_update','release_check',()=>releases.check({fetcher:updateFetch,
    installRoot:installRoot(),launcherVersion:app.getVersion(),channel:CHANNEL,metadataCache:releaseMetadataCache()}))
    .finally(()=>{releaseCheckRequest=null;});
  return releaseCheckRequest;
}
const systemUpdate = require('./system-update');
const { createSkillUpdateReceiver, finishHandoff } = require('./skill-update');
const launcherUpdate = require('./launcher-update');
const SELF_UPDATE_JOB = process.argv.find(value => value.startsWith('--nora-self-update='))?.slice('--nora-self-update='.length);
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
  modelCredential,
  configurationFingerprint,
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
let activeOperationContext = null;
let operationController = null;
let outboxDrain;
const operationExecutors = {};
const operationRecoverers = {};
const operationRecheckers = {};
const operationErrors = new Map();
const rememberOperationFailure=(error,context)=>{operationErrors.set(context.operationId,error);};
function finishOperationTelemetry(operation,{recover=false}={}){
  let error=operationErrors.get(operation.operationId);
  const admissionOnly=diagnostics.operationId!==operation.operationId;
  if(admissionOnly){
    diagnostics.begin(operation.operationId,{operationId:operation.operationId,action:operation.kind});
    telemetry?.begin(operation.kind==='shutdown'?'stop':operation.kind,{operationId:operation.operationId});
    const cause=operation.currentFailure||operation.primaryFailure;
    if(cause){
      error||=launcherError(cause.guidance?.title||'操作未开始。',{code:cause.code,userCode:cause.code,source:'launcher',site:'launcher.operation'});
      diagnostics.error('operation.admission-failed',error);
    }
  }
  try{
    diagnostics.write('operation.result',{state:operation.state,effectState:operation.effectState,
      verification:operation.verification,recoveryOutcome:operation.recoveryOutcome,evidenceStatus:operation.evidenceStatus});
    telemetry?.finish(operation.state==='succeeded'||(recover||operation.kind==='recover')&&operation.state==='rolled-back'
      &&operation.verification==='confirmed'?'succeeded':operation.state==='awaiting-handoff'?'handoff'
      :operation.state==='cancelled'?'cancelled':'failed',error);
  }finally{
    if(admissionOnly)diagnostics.finish(operation.state==='succeeded'?'succeeded':'failed');
    operationErrors.delete(operation.operationId);
  }
}

function operations() {
  return operationController ||= createOperationController({directory:installerDirectory,
    lock:{probe:options=>operationLock.probe(options),acquire:options=>acquireInspected({...options,lock:operationLock,
      python:findPython()?.command,script:path.join(installerRoot(),'operation_control.py'),env:launcherEnv()})},
    executors:operationExecutors,recoverers:operationRecoverers,recheckers:operationRecheckers,evidence:operationEvidence,
    projectResult:result=>result?.value ?? result,
    observeEffects:record=>maintenancePolicy().observe(record),
    captureConditions:(record,context)=>maintenancePolicy().initialConditions(record,context),
    identifyFailureCondition:(error,record)=>maintenancePolicy().identifyFailureCondition(error,record),
    verifyHandoff:async(record,proof)=>launcherUpdate.verifyHandoff({...launcherRecoveryOptions(),job:proof.job,
      operation:record,version:app.getVersion(),planDigest:proof.planDigest}),
    verifyRecoveryHandoff:async(record,proof)=>launcherUpdate.verifyRecovery({...launcherRecoveryOptions(),job:proof?.job,operation:record})});
}

let operationPolicy;
function maintenancePolicy(){
  return operationPolicy ||= require('./operation-policy').create({home:noraHome,hermesHome,installRoot,
    networkFetch:releaseNetwork.readOnce,launcherVersion:()=>app.getVersion(),channel:CHANNEL,
    bridge:(command,options)=>runBridge(command,options),
    runRuntime:(context,{recover,allowCommitted})=>runProcess(process.execPath,
      [path.join(__dirname,'runtime-worker.js'),payloadDirectory(),noraHome(),hermesHome(),
        ...(recover?['--recover-runtime']:[]),...(allowCommitted?['--allow-committed']:[])],null,context.operationId),
    runLegacy:(context,request)=>runProcess(process.execPath,[path.join(__dirname,'legacy-recovery-worker.js'),noraHome()],null,
      context.operationId,{kind:'legacy-recovery',input:JSON.stringify(request),returnResult:true}),
    inspectLauncher:job=>launcherUpdate.assessJob({...launcherRecoveryOptions(),job})});
}

function requireOperationResult(operation,{recover=false}={}) {
  if(operation.state!=='succeeded'&&!(recover&&operation.state==='rolled-back'&&operation.verification==='confirmed')&&operation.state!=='awaiting-handoff'){
    const failure=operation.currentFailure||operation.primaryFailure;
    throw Object.assign(new Error(failure?.guidance?.detail||'操作尚未完成，请查看当前状态。'),
      {code:failure?.code||'OPERATION_INTERRUPTED',userCode:failure?.code,operation,logOperationId:operation.operationId});
  }
  return {...operation.result,operation};
}

async function recoverMaintenance(context,options={}){
  const result=await maintenancePolicy().recover(context,options);
  if(result.verification==='confirmed'){
    const state=readInstallerState(),value=result.value||{};
    writeInstallerState({...state,phase:value.systemReady===true?'ready':'idle',error:'',task:'',resumeTarget:null,
      setupCompleted:typeof value.setupCompleted==='boolean'?value.setupCompleted:state.setupCompleted});
  }
  return result;
}

async function registerCapabilities(){
  if(!app.isPackaged)return null;
  try{
    return await require('./launcher-capability').register({noraHome:noraHome(),hermesHome:hermesHome(),installRoot:installRoot(),
      executable:process.execPath,resourcesRoot:process.resourcesPath,isPackaged:true,launcherVersion:app.getVersion(),
      port:readInstallerState().port||DEFAULT_PORT,channel:CHANNEL});
  }catch(error){diagnostics.error('operation.capability-registration-failed',error);return null;}
}

function drainPendingOutboxes(){
  if(!app.isPackaged||ISOLATED_TEST&&!LOCAL_TEST?.telemetryEnabled||localReleaseDirectory
    ||MOCK_SCENARIO||SELF_UPDATE_JOB&&activeRun||activeRun||modelBusy||uninstalling||selectingLocation||quitting)return;
  if(outboxDrain)return outboxDrain;
  outboxDrain=require('./operation-cli').drainOperationOutboxes({noraHome:noraHome(),launcherVersion:app.getVersion(),
    fetcher:(url,options)=>net.fetch(url,options)})
    .catch(error=>diagnostics.error('telemetry.outbox-deferred',error)).finally(()=>{outboxDrain=null;});
  return outboxDrain;
}

async function runOwnedTask(kind,request,execute,{requestId=require('node:crypto').randomUUID(),conditionFingerprint=''}={}) {
  try{
  const operation=await operations().start(kind,{target:{request},conditionFingerprint,execute:async context=>{
    activeOperationContext=context;
    diagnostics.begin(requestId,{operationId:context.operationId,action:kind});
    telemetry?.begin(kind==='shutdown'?'stop':kind,{operationId:context.operationId});
    return telemetry?telemetry.scope(()=>execute(context)):execute(context);
  },onFailure:rememberOperationFailure},requestId);
    finishOperationTelemetry(operation);return requireOperationResult(operation);
  }finally{activeOperationContext=null;}
}
let activeRun = false;
let modelBusy = false;
let statusRequest = null;
let lastStatusError = '';
let cancelled = false;
let releaseAbort = null;
let updatingSystem = false;
let uninstalling = false;
let selectingLocation = false;
let quitting = false;
let quitReady = false;
let selectedHome;
const LOCATION_SCOPE = LOCAL_TEST ? `test-${LOCAL_TEST.buildId}` : CHANNEL;

function statusErrorMessage(error) {
  const fingerprint = `${error.code || ''}:${error.message || ''}`;
  if (fingerprint !== lastStatusError) diagnostics.error('launcher.status-failed', error);
  lastStatusError = fingerprint;
  return formatUserError(error, {action:'status'});
}

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
  try {
    fs.mkdirSync(installerDirectory(), { recursive: true });
    const next = { ...value, updatedAt: Date.now() };
    const target = installerStatePath();
    const temporary = `${target}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(temporary, target);
    return next;
  } catch (error) {
    throw launcherError('无法保存安装操作记录。', {userCode:'INSTALLER_STATE_WRITE_FAILED'}, error);
  }
}

function sanitizeLine(value) {
  return String(value || '').replace(ANSI, '').replace(/^\s*-e\s+/, '').trimEnd();
}

function recordEvent(message) {
  telemetry?.observe(message);
  diagnostics.event(message);
  if (!['milestone', 'task', 'progress'].includes(message.event)) return;
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

function recordFailureEvent(message,error) {
  try { recordEvent(message); }
  catch (stateError) {
    diagnostics.error('state.write-failed',stateError);
    if (stateError !== error) error.secondaryErrors=[...(error.secondaryErrors || []),{operation:'progress-state',error:stateError}];
  }
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
      ...(options.operationId ? ['--operation-id',options.operationId] : []),
      ...(options.kind ? ['--kind',options.kind] : []),
      ...(options.version ? ['--version',options.version] : []),
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

function taskCancellation() {
  const canCancel = !updatingSystem && !cancelled && Boolean(releaseAbort && !releaseAbort.signal.aborted
    || activeProcess && activeProcess.cancelSafe !== false && activeOperationContext);
  return {canCancel, cancelReason: cancelled ? '正在取消，请等待任务结束。'
    : updatingSystem || activeProcess?.cancelSafe === false ? '正在处理程序文件，暂不能取消。'
    : '当前阶段暂不能取消。'};
}

function sendBridgeEvent(webContents, runId, message) {
  activeOperationContext?.observe(message);
  if (message.event !== 'result') message = diagnostics.clean(message);
  if (message.event === 'milestone' && message.index === 4 && readInstallerState().phase === 'installing') {
    message = { event: 'task', milestone: 1, task: '正在检查酒馆安装文件' };
  }
  recordEvent(message);
  if (message.event === 'diagnostic') return;
  if (webContents && !webContents.isDestroyed() && runId) {
    webContents.send(`nora:bridge-event:${runId}`, {...message,
      ...(activeOperationContext ? {operation:activeOperationContext.snapshot} : {}), ...taskCancellation()});
  }
}

function spawnMaintenance(command,args,options={},kind='python-maintenance') {
  const context=activeOperationContext;
  if(!context)throw launcherError('维护操作缺少有效执行授权，安装和数据未修改。',{code:'OPERATION_CAPABILITY_REQUIRED'});
  context.check();
  if(kind==='python-maintenance')args=['-B','-u',path.join(installerRoot(),'operation_control.py'),'--delegate-exec',...args];
  const child=context.lease.spawn(command,args,{...options,kind,
    ...(kind==='python-maintenance'?{managedPythonRoot:path.join(hermesHome(),'python'),venvHome:path.join(hermesHome(),'hermes-agent','venv')}:{})});
  child.guarded=true;
  return child;
}

function runProcess(command, args, webContents, runId, options={}) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    let timedOut = false;
    diagnostics.write('process.start', { command: [command, ...args], cwd: installerRoot() });
    sendBridgeEvent(webContents, runId, { event: 'command', command: [command, ...args] });
    const proc = spawnMaintenance(command, args, {
      env: { ...launcherEnv(), ...(command === process.execPath ? { ELECTRON_RUN_AS_NODE: '1' } : {}) },
      cwd: installerRoot(),
    },options.kind||'runtime-bootstrap');
    activeProcess = proc;
    proc.once('spawn',()=>diagnostics.write('process.spawned', { pid: proc.pid }));
    proc.cancelSafe = false;
    let result;
    let errorMessage = '', structuredCode, structuredUserCode;
    const evidence = faultPackets.collector(true,{output:true,components:options.kind==='legacy-recovery'?['updater']:['runtime']});
    let outputFailure = null;
    const onOutputError = error => {
      if (outputFailure) return;
      outputFailure = error;
      diagnostics.error('process.output-failed', error, {pid:proc.pid});
    };
    const childFailure = error => {
      if (outputFailure && error !== outputFailure) error.secondaryErrors = [...(error.secondaryErrors || []), {operation:'progress-state',error:outputFailure}];
      return evidence.attach(error);
    };
    const heartbeat = setInterval(() => {
      try { sendBridgeEvent(webContents, runId, { event: 'heartbeat', at: Date.now() }); }
      catch (error) { onOutputError(error); }
    }, 1000);
    proc.stdin.end(options.input);
    const timeout = setTimeout(() => {
      timedOut = true;
      diagnostics.write('process.timeout', { pid: proc.pid, timeoutMs: 30 * 60 * 1000 });
      terminateProcess(proc);
    }, 30 * 60 * 1000);
    consumeLines(proc.stdout, (line) => {
        const clean = sanitizeLine(line);
        const message = parseJsonLine(clean);
        if(message.event==='result'){result={...message};delete result.event;}
        if (message.event === 'error') { structuredCode = message.code; structuredUserCode = message.userCode; }
        evidence.observe(message.event === 'log' ? {...message,stream:'stdout'} : message);
        sendBridgeEvent(webContents, runId, message.event === 'log' ? {...message,uploadScope:'maintenance'} : message);
    }, onOutputError,{preserveBlankLines:true});
    consumeLines(proc.stderr, (line) => {
        const clean = diagnostics.clean(sanitizeLine(line));
        errorMessage = (errorMessage + '\n' + clean).slice(-4000);
        evidence.observe({event:'log',line:clean,stream:'stderr'});
        sendBridgeEvent(webContents, runId, { event: 'log', line: clean, stream: 'stderr', uploadScope:'maintenance' });
    }, onOutputError,{preserveBlankLines:true});
    proc.on('error', error => { diagnostics.error('process.error', error, { pid: proc.pid }); clearInterval(heartbeat); clearTimeout(timeout);
      reject(childFailure(launcherError(error.message,{source:'launcher_process',site:'process.run'},error))); });
    proc.on('close', (code, signal) => {
      diagnostics.write('process.exit', { pid: proc.pid, exitCode: code, signal, timedOut, cancelled, durationMs: Date.now() - started });
      clearInterval(heartbeat);
      clearTimeout(timeout);
      if (activeProcess === proc) activeProcess = null;
      if (code === 0 && !outputFailure && (!options.returnResult||result)) resolve(options.returnResult?result:undefined);
      else if(code===0&&!outputFailure)reject(childFailure(launcherError('恢复程序没有返回有效结果。',{code:'INVALID_RESPONSE'})));
      else if (code === 0) reject(childFailure(outputFailure));
      else reject(childFailure(launcherError(diagnostics.clean((errorMessage || `命令执行失败，退出码 ${code}`).trim()),
        { exitCode: code, signal, code: timedOut ? 'TIMEOUT' : structuredCode, userCode:structuredUserCode, source:'launcher_process',site:'process.run' })));
    });
  });
}

function terminateProcess(proc) {
  if(proc?.guarded){proc.kill('SIGTERM');return;}
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
    if(marker.sha256!==bundle.manifest.sha256){
      if(fs.existsSync(path.join(installRoot(),'tavern-updates/nora-system.json')))
        throw launcherError('已有酒馆安装记录，请通过检查更新或修复当前安装继续。现有数据和配置已保留。',{code:'RELEASE_COMPATIBILITY'});
      const stopped=await runBridge('recovery-stop');
      if(stopped.offline!==true)throw launcherError('尚未确认旧程序已停止，未替换诺拉核心。',{code:'VERIFICATION_FAILED'});
    }else{

    sendBridgeEvent(webContents, runId, { event: 'task', task: 'Hermes 核心已就绪，继续初始化 Nora' });
    return;
    }
  }
  if (!findBundledRuntime(payloadRoot)) {
    throw new Error('当前启动器缺少内置运行时，请使用完整整合包。开发测试请配置 NORA_LAUNCHER_PAYLOAD。');
  }
  fs.mkdirSync(installerDirectory(), { recursive: true });
  sendBridgeEvent(webContents, runId, { event: 'milestone', index: 0, state: 'running', task: '准备 Nora 核心' });
  await activeOperationContext.journal(path.join(installerDirectory(),'operations',activeOperationContext.operationId,'runtime-bootstrap.json'));
  await runProcess(process.execPath, [path.join(__dirname, 'runtime-worker.js'), payloadRoot, noraHome(), hermesHome()], webContents, runId);
  if (!findHermes()) throw new Error('内置 Nora 核心释放后未通过检查。');
  sendBridgeEvent(webContents, runId, { event: 'task', task: 'Hermes 核心已就绪，继续初始化 Nora' });
}

function runBridge(command, options = {}, webContents = null, runId = '') {
  return new Promise((resolve, reject) => {
    const installerCommand=['install','update','repair','recover-update','recover-install','resume-committed-update','resume-committed-install','verify-current-update'].includes(command);
    diagnostics.addSecret(options.code);
    const started = Date.now();
    let timedOut = false;
    let proc;
    try {
      const spec = bridgeArgs(command, options);
      if (command !== 'status') diagnostics.write('process.start', { command: [spec.command, ...spec.args], cwd: installerRoot() });
      proc = command === 'status' || (!activeOperationContext && ['verify-model','operation-effects','check-update','plan-update'].includes(command))
        ? spawn(spec.command,spec.args,{env:launcherEnv(),cwd:installerRoot(),windowsHide:true})
        : spawnMaintenance(spec.command,spec.args,{env:launcherEnv(),cwd:installerRoot(),windowsHide:true});
      // The file journals decide recovery. Cancellation remains available while
      // fetching resources; an active maintenance writer is allowed to finish.
      proc.cancelSafe = false;
      if (command !== 'status') proc.once('spawn',()=>diagnostics.write('process.spawned', { pid: proc.pid }));
      if (command !== 'status') activeProcess = proc;
      proc.stdin.end(command === 'pair' ? JSON.stringify({ code: options.code }) : undefined);
    } catch (error) {
      diagnostics.error('bridge.spawn-error', error, { command });
      reject(error);
      return;
    }
    let result = null;
    let errorMessage = '', structuredMessage = '', structuredCode, structuredUserCode;
    const evidence = faultPackets.collector(true,{output:installerCommand,components:installerCommand?['bridge','installer','updater','native']:['bridge']});
    let bridgeError = null;
    let outputFailure = null;
    const onOutputError = error => {
      if (outputFailure) return;
      outputFailure = error;
      diagnostics.error('bridge.output-failed', error, {command,pid:proc.pid});
    };
    const childFailure = error => {
      if (!installerCommand) error.remoteMessage = bridgeError?.message
        || (timedOut ? '后台操作超时，尚未确认完成，请重试。' : `Launcher ${command} failed; see technical exit status.`);
      if (outputFailure && error !== outputFailure) error.secondaryErrors = [...(error.secondaryErrors || []), {operation:'progress-state',error:outputFailure}];
      return evidence.attach(error);
    };
    const heartbeat = setInterval(() => {
      try { sendBridgeEvent(webContents, runId, { event: 'heartbeat', at: Date.now() }); }
      catch (error) { onOutputError(error); }
    }, 1000);
    const timeoutMs = command === 'status' ? 90000 : command === 'stop' ? 60000 : 30 * 60 * 1000;
    const timeout = setTimeout(() => {
      if (['update', 'recover-update'].includes(command)) {
        diagnostics.write('update.waiting-for-transaction', { pid: proc.pid, timeoutMs });
        try { sendBridgeEvent(webContents, runId, { event: 'task', task: '更新仍在处理，请保留窗口；为避免中断恢复，不会强制终止更新进程。' }); }
        catch (error) { onOutputError(error); }
        return;
      }
      timedOut = true;
      diagnostics.write('process.timeout', { command, pid: proc.pid, timeoutMs });
      terminateProcess(proc);
    }, timeoutMs);
    consumeLines(proc.stdout, (line) => {
        const message = parseJsonLine(sanitizeLine(line));
        if (message.event === 'diagnostic' && message.component === 'bridge'
            && message.error && typeof message.error === 'object') bridgeError = message.error;
        evidence.observe(message.event === 'log' ? {...message,stream:message.stream || 'stdout'} : message);
        if (message.event === 'result') {
          result = { ...message };
          delete result.event;
        } else if (message.event === 'error') {
          structuredUserCode = message.userCode;
          structuredMessage = diagnostics.clean(message.message || line);
          structuredCode = message.code;
        }
        if (command !== 'status') sendBridgeEvent(webContents, runId, message.event === 'log' ? {...message,uploadScope:installerCommand?'maintenance':undefined} : message);
    }, onOutputError,{preserveBlankLines:installerCommand});
    consumeLines(proc.stderr, (line) => {
      line = diagnostics.clean(line);
      evidence.observe({event:'log',line,stream:'stderr'});
      errorMessage = (errorMessage + '\n' + line).slice(-4000);
      if (command !== 'status') {
          const clean = sanitizeLine(line);
          if (clean||installerCommand) sendBridgeEvent(webContents, runId, { event: 'log', line: clean, stream: 'stderr', ...(installerCommand ? {uploadScope:'maintenance'} : {}) });
      } else diagnostics.event({ event: 'log', stream: 'stderr', line, command });
    }, onOutputError,{preserveBlankLines:installerCommand});
    proc.on('error', (error) => { diagnostics.error('bridge.process-error', error, { command, pid: proc.pid }); clearInterval(heartbeat); clearTimeout(timeout);
      reject(childFailure(launcherError(error.message,{source:'launcher_process',site:processSite(command)},error))); });
    proc.on('close', (code, signal) => {
      if (command !== 'status' || code !== 0) diagnostics.write('process.exit', { command, pid: proc.pid, exitCode: code, signal, timedOut, cancelled, durationMs: Date.now() - started });
      clearInterval(heartbeat);
      clearTimeout(timeout);
      if (activeProcess === proc) activeProcess = null;
      if (code === 0) {
        if (outputFailure) { reject(childFailure(outputFailure)); return; }
        if (!result) { reject(childFailure(launcherError('后台没有返回操作结果。',{code:'INVALID_RESPONSE',source:'launcher_process',site:'process.run'}))); return; }
        resolve(result);
        return;
      }
      reject(childFailure(launcherError(diagnostics.clean((timedOut ? '后台操作超时，尚未确认完成，请重试。' : structuredMessage || errorMessage || `命令执行失败，退出码 ${code}`).trim()),
        { exitCode: code, signal, code: timedOut ? 'TIMEOUT' : structuredCode || bridgeError?.code, source:'launcher_process',
          userCode: structuredUserCode, site:processSite(command) })));
    });
  });
}

function launcherRecoveryOptions() {
  return {home:noraHome(),executable:process.execPath,python:findPython()?.command,
    helper:path.join(installerRoot(),'replace-launcher.py')};
}

async function readLauncherRecovery() {
  if (!app.isPackaged) return null;
  try { return await launcherUpdate.assessPending(launcherRecoveryOptions()); }
  catch (error) {
    diagnostics.error('update.launcher-recovery-status-failed',error);
    return {status:'unknown',canRecover:false,reason:'启动器恢复记录暂时无法确认，请保留日志和备份，勿直接重复更新。'};
  }
}

async function recoverLauncher() {
  if (!app.isPackaged) throw new Error('开发模式不会替换启动器。');
  if (activeRun || modelBusy || uninstalling || selectingLocation || quitting) throw new Error('请等待当前任务完成后再恢复启动器。');
  activeRun=true;
  let restarting=false;
  let handoffOperation;
  try {
    if (statusRequest) await statusRequest;
    const pending=await readLauncherRecovery();
    if (!pending || pending.canRecover !== true || pending.busy || !pending.job)
      throw new Error(pending?.reason || '没有可安全恢复的旧启动器。请保留日志和备份。');
    if(!pending.operationId)throw launcherError('旧启动器记录缺少可核验的操作协议，请保留数据并覆盖安装新版启动器。',{code:'OPERATION_CAPABILITY_REQUIRED'});
    const before=await operations().snapshot(pending.operationId);
    const operation=await operations().recover(before.operationId,{snapshotSequence:before.snapshotSequence,
      recoveryHandoff:{job:pending.job},onFailure:rememberOperationFailure,prepareHandoff:async context=>{
        activeOperationContext=context;
        diagnostics.begin(`launcher-recovery-${context.operationId}`,{operationId:context.operationId,action:'repair',version:app.getVersion()});
        telemetry?.begin('repair',{operationId:context.operationId});telemetry?.stage('rollback');
        const prepared=await launcherUpdate.prepareRecovery({...launcherRecoveryOptions(),job:pending.job,
          operation:context.snapshot,spawnChild:(command,args,options)=>spawnMaintenance(command,args,options),
          onEvent:message=>diagnostics.event(message)});
        if(prepared.untouched)return {effectState:'untouched',verification:'confirmed',value:{untouched:true,restarting:false}};
        await context.handoff(pending.job);return {handoff:true,value:prepared};
      }});
    if(operation.state!=='awaiting-handoff'){
      finishOperationTelemetry(operation,{recover:true});return requireOperationResult(operation,{recover:true});
    }
    handoffOperation=operation;
    // The old Node owner has now released its actual writer lock. The helper
    // takes it independently, confirms its own PID, then waits for this APP.
    const result=await launcherUpdate.recover({...launcherRecoveryOptions(),job:pending.job,
      parentCreationTime:operation.result.parentCreationTime,managedPythonRoot:path.join(hermesHome(),'python'),
      venvHome:path.join(hermesHome(),'hermes-agent','venv'),env:process.env,onEvent:message=>diagnostics.event(message)});
    finishOperationTelemetry(operation);
    diagnostics.write('update.launcher-recovery-prepared',{job:pending.job,restarting:result.restarting});
    if (result.restarting === true) {
      restarting=true;
      quitReady=true;
      // The helper is prepared; final restoration has no cross-version ACK.
      diagnostics.finish('restarting');
      setImmediate(()=>app.quit());
    } else if (result.restored === true) {
      diagnostics.finish('success');
    } else {
      throw new Error('启动器恢复未返回有效确认。请保留日志和备份。');
    }
    return result;
  } catch (error) {
    diagnostics.error('update.launcher-recovery-failed',error); diagnostics.finish('error');
    if(handoffOperation){
      const failed=await operations().failHandoff(handoffOperation.operationId,{job:handoffOperation.handoffRef,
        error,onFailure:rememberOperationFailure});
      finishOperationTelemetry(failed);return requireOperationResult(failed);
    }
    if(!error.operation)telemetry?.report(error,{source:'launcher',site:'launcher.operation'});
    throw error;
  } finally { activeOperationContext=null;if (!restarting) activeRun=false; }
}

async function requestQuit(event) {
  // Uninstall owns its shutdown; a second instance never registers this handler.
  if (quitReady || uninstalling || MOCK_SCENARIO) return;
  event.preventDefault();
  if (quitting) return;
  quitting = true;
  try {
    if (activeRun || modelBusy || selectingLocation) {
      await dialog.showMessageBox({ type: 'info', title: '暂未退出',
        message: '任务尚未结束，暂不能退出启动器', detail: '请等待任务结束；当前阶段允许取消时，可先点击“取消任务”。', buttons: ['知道了'] });
      return;
    }
    if (statusRequest) await statusRequest.catch(() => {});
    diagnostics.write('shutdown.start', { services: ['nora', 'tavern'] });
    if (findPython()) {
      await runOwnedTask('shutdown',{action:'stop',service:'all'},async context=>{
        await context.stage('applying');
        const result = await runBridge('stop', { service: 'all' });
        if (result.running !== false || result.gatewayRunning !== false) throw new Error('尚未确认诺拉与酒馆已全部停止。');
        await context.stage('verifying');return {verification:'confirmed',value:result};
      });
    } else {
      const status = nodeStatus();
      if (status.installed || status.hermesInstalled) throw new Error('运行环境缺失，无法安全停止服务。请修复安装后再退出。');
    }
    diagnostics.write('shutdown.complete');
    quitReady = true;
    // Even an empty installation must leave the current before-quit dispatch
    // before issuing the confirmed quit; Electron ignores recursive quit here.
    await new Promise(resolve=>setImmediate(resolve));
    app.quit();
  } catch (error) {
    diagnostics.error('shutdown.failed', error);
    telemetry?.report(error,{source:'launcher_process',site:'process.stop'});
    await dialog.showMessageBox({ type: 'error', title: '退出未完成',
      message: '后台服务停止失败，启动器未退出',
      detail: formatUserError(error, {action:'stop'}), buttons: ['知道了'] });
  } finally { quitting = false; }
}

function systemUpdateExecutor(payload,webContents){
  return require('./system-update-executor').create({compare:releases.compare,
    bridge:(command,options)=>runBridge(command,options,webContents,payload.runId),
    finalizeLauncher:async(job,verified)=>{
      await launcherUpdate.finalize({...launcherRecoveryOptions(),spawnChild:(command,args,options)=>spawnMaintenance(command,args,options),
        job,version:app.getVersion(),target:verified.version,systemReady:verified.systemReady,updateVerified:verified.updateVerified});
      diagnostics.write('update.launcher-committed',{job,target:verified.version});
    }});
}

async function performSystemUpdate(selectedPayload, payload, webContents) {
  if (hermesHome() !== path.join(noraHome(), 'hermes') || installRoot() !== path.join(noraHome(), 'tavern')) {
    throw new Error('完整系统更新仅支持启动器管理的专属安装目录。');
  }
  const target = JSON.parse(fs.readFileSync(path.join(selectedPayload, 'release-manifest.json'))).versions;
  const before = await runBridge('status');
  const comparison = releases.compare(before.version, target.tavern);
  if (comparison !== -1 && !(comparison === 0 && before.systemReady === false)) {
    throw new Error('目标必须高于当前版本，或为需要修复的同一版本；不会降级现有安装。');
  }
  updatingSystem = true;
  const onEvent = message => sendBridgeEvent(webContents, payload.runId, message);
  try {
    onEvent({ event: 'task', stage_id: 'update_apply', task: '由更新器备份、替换并验证服务；失败时恢复旧版本' });
    // Stop, validate and restore services inside the shared transaction. Nothing
    // after this call may start/stop a service or change the installed files.
    return await systemUpdateExecutor(payload,webContents).apply(activeOperationContext,
      {port:payload.port,releaseDir:selectedPayload,target:target.tavern});
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
    const proc = spawnMaintenance(python.command, [
      ...python.args.filter((arg) => arg !== '-V'),
      '-u', '-B', modelConfigScript(),
    ], {
      env: launcherEnv(),
      cwd: path.join(hermesHome(), 'hermes-agent'),
      windowsHide: true,
    });
    let result=null,outputFailure;
    let stderr = '', timedOut = false;
    const started=Date.now();
    diagnostics.write('model.helper-start',{site:'model.save',pid:proc.pid});
    const outputError=error=>{outputFailure ||= error;diagnostics.error('model.output-failed',error,{site:'model.save'});};
    const log=(line,stream)=>diagnostics.event({event:'log',line,stream,uploadScope:'maintenance',site:'model.save'});
    const timer = setTimeout(() => {timedOut = true;diagnostics.write('model.helper-timeout',{site:'model.save',pid:proc.pid});proc.kill('SIGTERM');}, 60000);
    consumeLines(proc.stdout,line=>{
      // The JSON protocol can contain saved configuration and credentials.
      // Retain execution output, never serialize this response into the log.
      try { const value=JSON.parse(line);if(typeof value?.ok==='boolean'){result=value;return;} }
      catch {}
      log(line,'stdout');
    },outputError,{preserveBlankLines:true});
    consumeLines(proc.stderr,line=>{
      log(line,'stderr');
      // Only the UI error summary is bounded; the operation log keeps every line.
      stderr=(stderr+'\n'+diagnostics.clean(line)).slice(-4000);
    },outputError,{preserveBlankLines:true});
    proc.on('error', error => { clearTimeout(timer);diagnostics.error('model.helper-failed',error,{site:'model.save'});
      reject(launcherError(error.message,{source:'launcher_process',site:'model.save'},error)); });
    proc.on('close', (code,signal) => {
      clearTimeout(timer);
      diagnostics.write('model.helper-exit',{site:'model.save',pid:proc.pid,exitCode:code,signal,durationMs:Date.now()-started});
      const secret = String(payload.key || '');
      const clean = (value) => {
        const text = String(value || '');
        return (secret ? text.replaceAll(secret, '***') : text).trim();
      };
      if (code === 0 && result?.ok===true&&!outputFailure) resolve(result);
      else {
        const cause=require('./launcher-errors').programError(result?.diagnostic);
        const error = launcherError(clean(result?.error || stderr || '无法保存模型配置。'),{source:'launcher_process',site:'model.save',exitCode:code,signal,
          code:timedOut ? 'TIMEOUT' : outputFailure?.code || (code===0&&!result?'INVALID_RESPONSE':undefined)},outputFailure||cause);
        error.remoteMessage = 'Model configuration helper failed; see technical exit status.';
        diagnostics.error('model.helper-failed',error,{site:'model.save'});
        reject(error);
      }
    });
    proc.stdin.end(JSON.stringify(payload));
  });
}

async function finishModelSetup() {
  const saved = readVerifiedModel(noraHome());
  if (!saved) throw new Error('请先配置并验证模型。');
  if (saved.tavernSyncPending) {
    recordEvent({ event: 'milestone', index: 2, state: 'running', task: '模型已验证，正在准备酒馆并同步配置' });
    try {
      const port = readInstallerState().port || DEFAULT_PORT;
      const runtime = await runBridge('start', { service: 'tavern', port });
      if (!runtime.running) throw new Error('酒馆接口尚未就绪。');
      await runModelConfigHelper({ action: 'sync-saved-tavern', port });
      writeVerifiedModel(noraHome(), { ...saved, tavernSyncPending: false });
    } catch (error) {
      throw launcherError(`模型验证已通过，但酒馆同步未完成：${error.message}。可继续同步，无需重新填写 Key。`,{site:'model.save',userCode:'MODEL_SYNC_PENDING'},error);
    }
  }
  const verification = await runBridge('verify-model');
  if (!verification.ok) throw new Error(verification.error || '模型配置复核未通过。');
  await runModelConfigHelper({ action: 'verify-runtime' });
  recordEvent({ event: 'milestone', index: 2, state: 'done', task: '模型配置完成（已验证文字响应，工具调用能力未验证）' });
  return { ok: true, provider: saved.provider, model: saved.model, toolSupport: 'unverified' };
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
  win.webContents.on('render-process-gone', (_event, details) => {
    if (!quitting && details.reason !== 'clean-exit') {
      void recordNativeFailure('renderer',{reason:details.reason,exitCode:details.exitCode});
      const timer=setTimeout(()=>nativeCrashes.collect(),1500);timer.unref();
    }
  });
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
    if (quitting && !quitReady) { event.preventDefault(); return; }
    // Windows closes the last window to quit. Keep it visible until managed
    // shutdown succeeds so a failed stop still has a usable retry surface.
    if (process.platform !== 'darwin' && !quitReady && !uninstalling && !MOCK_SCENARIO) {
      event.preventDefault();
      app.quit();
      return;
    }
    if (!activeRun && !modelBusy) return;
    event.preventDefault();
    dialog.showMessageBox(win, {
      type: 'info',
      title: '正在处理',
      message: '任务尚未结束，暂不能关闭窗口',
      detail: '请等待任务结束；当前阶段允许取消时，可先点击“取消任务”。',
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
    detail: `保留数据：仅删除程序和缓存，保留世界、角色、聊天、配置、Key 和已有备份。\n\n彻底卸载：永久删除此目录内全部数据和备份，无法撤销。\n${home}\n\n不影响 ClawChat 客户端和云端联系人，不撤销服务商 Key。`,
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
    if (findPython()) await runOwnedTask('shutdown',{action:'stop',service:'all'},async context=>{
      await context.stage('applying');
      const stopped=await runBridge('recovery-stop');
      if(stopped.offline!==true||stopped.running!==false||stopped.gatewayRunning!==false)
        throw launcherError('服务停止状态尚未确认，未开始卸载。',{code:'VERIFICATION_FAILED'});
      return {verification:'confirmed',value:stopped};
    });
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

function initializeLauncher() {
  diagnostics.write('launcher.start', { version: app.getVersion(), channel: CHANNEL,
    platform: process.platform, arch: process.arch, osRelease: os.release(),
    node: process.versions.node, electron: process.versions.electron, executable: process.execPath });
  try {
    fs.mkdirSync(path.join(noraHome(), 'cache', 'tmp'), { recursive: true });
    uninstall.own(noraHome());
    app.setPath('userData', path.join(noraHome(), 'launcher'));
    return true;
  } catch (error) {
    diagnostics.error('launcher.startup-failed', error);
    const guidance=formatUserError(error,{action:'status'}).replaceAll('在“更多”中查看日志',
      diagnostics.lastFile?'查看下方本机日志':'保留本次提示');
    const log=diagnostics.lastFile?`本机日志：${diagnostics.lastFile}`:'本机日志未能保存。';
    try { dialog.showErrorBox('启动器未能打开', `${guidance}\n\n${log}\n请保留现有安装和数据。`); }
    catch (dialogError) { diagnostics.error('launcher.startup-dialog-failed', dialogError); }
    app.exit(1);
    return false;
  }
}

const initialized=Boolean(app&&BrowserWindow&&ipcMain&&shell&&initializeLauncher());
const primaryInstance=initialized&&app.requestSingleInstanceLock();
if(initialized&&!primaryInstance)app.quit();
if (primaryInstance) {
  // Start before the first renderer or Electron-as-Node guard is created.
  nativeCrashes=require('./native-crash').createNativeCrashDiagnostics({
    directory:path.join(app.getPath('userData'),'diagnostics','native-crashes'),
    diagnostic:code=>diagnostics.write('native-crash.diagnostic',{code}),
    onEvidence:evidence=>recordNativeFailure('native',evidence),
  });
  nativeCrashes.start({app,crashReporter});
  try {
    const existing = fs.existsSync(path.join(installRoot(), 'apps/tavern-runtime/native-runtime.json'));
    telemetry = createTelemetry({ file: path.join(installerDirectory(), 'telemetry.json'), launcherVersion: app.getVersion(),
      enabled: Boolean(app.isPackaged && (!ISOLATED_TEST || LOCAL_TEST?.telemetryEnabled === true) && !localReleaseDirectory),
      diagnosticDefault: true,
      cohort: existing ? 'existing' : fs.existsSync(installRoot()) || fs.existsSync(hermesHome()) ? 'unknown' : 'new',
      clean:diagnostics.clean, roots:() => [installerRoot(),noraHome(),hermesHome(),installRoot(),os.homedir()],
      environment:{os_release:os.release(),node:process.versions.node,electron:process.versions.electron,launcher_build:launcherBuild()},
      fetcher: (url, options) => net.fetch(url, options), diagnostic: code => diagnostics.write('telemetry.diagnostic', { code }),
      operationLogs:(id,cursor)=>diagnostics.readOperation(id,cursor),
      logScope:(task,work)=>diagnostics.scope(task.id,{action:task.action,version:app.getVersion(),node:process.versions.node,electron:process.versions.electron},work),
      operationContext:()=>activeOperationContext?{...activeOperationContext.snapshot,
        currentVersion:activeOperationContext.target.currentVersion||null,
        evidence:operationEvidence.read(activeOperationContext.operationId)}:null,
      onDelivery:({operationId,summary})=>{
        if(activeOperationContext?.operationId===operationId)activeOperationContext.delivery(summary);
        else operationEvidence.updateDelivery(operationId,summary);
      }});
    app.on('will-quit', () => telemetry?.close());
  } catch { diagnostics.write('telemetry.diagnostic', { code: 'initialization_failed' }); }
  void nativeCrashes.collect();
  // Ordinary child_process Node guards do not emit child-process-gone. Poll
  // our own crash directory so their evidence also arrives without a restart.
  const nativeCrashTimer=setInterval(()=>nativeCrashes.collect(),30000);nativeCrashTimer.unref();
  app.on('will-quit',()=>clearInterval(nativeCrashTimer));
  app.on('child-process-gone',(_event,details)=>{
    if(details.reason==='clean-exit'||quitting)return;
    void recordNativeFailure('child',{type:details.type,reason:details.reason,exitCode:details.exitCode});
    const timer=setTimeout(()=>nativeCrashes.collect(),1500);timer.unref();
  });
  const handle = (channel, fn) => ipcMain.handle(channel, async (event, ...args) => {
    try {
    const expected = require('node:url').pathToFileURL(path.join(installerRoot(), 'launcher-conversation-prototype.html')).href;
    if (event.senderFrame !== event.sender.mainFrame || event.senderFrame.url.split('?')[0] !== expected || MOCK_SCENARIO) {
      throw new Error('启动器页面来源无效。');
    }
    if (uninstalling && channel !== 'nora:status') throw new Error('正在处理卸载，请稍候。');
    if (quitting && channel !== 'nora:status') throw new Error('正在退出，请等待后台服务停止。');
    if (selectingLocation && channel !== 'nora:status') throw new Error('正在选择安装位置，请稍候。');
    return successResult(await fn(event, ...args));
    } catch (error) {
      if(!error.logOperationId) diagnostics.error('launcher.ui-failed', error, {channel});
      // Only launcher-owned UI actions. Never attach status polling or runtime logs.
      const site = {'nora:choose-directory':'launcher.directory','nora:open-directory':'launcher.directory',
        'nora:open-settings':'launcher.directory','nora:open-clawchat':'launcher.window','nora:open-clawchat-app':'launcher.window'}[channel];
      if (site) telemetry?.report(error,{source:'launcher',site});
      const action = channel === 'nora:run' ? args[0]?.action : {
        'nora:model-options':'list_models', 'nora:model-save-test':'model', 'nora:model-resume':'model',
        'nora:model-providers':'model', 'nora:check-update':'check_update', 'nora:uninstall':'uninstall',
        'nora:recover-launcher':'repair',
        'nora:open-external':'open', 'nora:open-directory':'settings', 'nora:choose-directory':'settings',
      }[channel];
      // Return a versioned DTO: Electron exception transport discards custom
      // properties needed for safe actions and precise user guidance.
      return failureResult(error,{action,operation:error.operation});
    }
  });
  handle('nora:recover-launcher',recoverLauncher);
  handle('nora:status', async () => {
    if (quitting || uninstalling || selectingLocation || modelBusy) return { ...nodeStatus(), ...taskCancellation(), busy: true,
      operation:activeOperationContext?{...activeOperationContext.snapshot,busy:true,allowedActions:['wait','logs']}:await operations().snapshot(),
      launcherRecovery:await readLauncherRecovery() };
    if (statusRequest) return statusRequest;
    statusRequest = (async () => {
      const launcherRecovery=await readLauncherRecovery();
      const operation=activeOperationContext?.snapshot||await operations().snapshot();
    try {
      const legacyRecovery=systemUpdate.inspect(noraHome());
      if (!findPython()) {
        const fallback = nodeStatus();
        if (!fallback.installed) return {...fallback,...taskCancellation(),launcherRecovery,operation};
        throw new Error('无法查询已安装的服务状态，启动器未找到可用的 Python。请保留现有安装和数据。');
      }
      const runtime = await runBridge('status');
      if (runtime.warning && (runtime.warningCode || !/[\u3400-\u9fff]/.test(runtime.warning)))
        runtime.warning = statusErrorMessage(Object.assign(new Error(runtime.warning), {code:runtime.warningCode}));
      else lastStatusError = '';
      if (!activeRun && !modelBusy) telemetry?.status({ ...runtime, installer: readInstallerState() });
      const bundledUpgradeTarget = !LOCAL_TEST && runtime.installed ? releases.bundledUpgradeTarget({
        bundledRoot: payloadDirectory(), currentVersion: runtime.version, launcherVersion: app.getVersion(), channel: CHANNEL,
      }) : null;
      return { ...runtime,...taskCancellation(),operation,updateRecovery:runtime.updateRecovery||legacyRecovery, bundledUpgradeTarget, installer: readInstallerState(), busy: activeRun || modelBusy, launcherRecovery, ...locationStatus() };
    } catch (error) {
      // Failed inspection provides no evidence that services stopped or that
      // the installation needs repair. Let the renderer retain known facts.
      return {statusUnavailable:true,warning:statusErrorMessage(error),launcherRecovery,...taskCancellation(),
        busy:activeRun || modelBusy || quitting || uninstalling || selectingLocation};
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
      const currentHome=noraHome(),selectionOptions={
        currentHome: noraHome(), defaultHome: defaultNoraHome(), scope: LOCATION_SCOPE,
        appPath: app.isPackaged ? (process.platform === 'darwin' ? path.resolve(process.execPath, '../../..') : path.dirname(process.execPath)) : __dirname,
      };
      const leases=[],operationId=require('node:crypto').randomUUID(),ownerEpoch=Date.now();
      const fence=async home=>{
        const lease=await acquireInspected({lock:operationLock,directory:path.join(home,'installer'),operationId,ownerEpoch,
          python:findPython()?.command,script:path.join(installerRoot(),'operation_control.py'),env:process.env});
        leases.push(lease);
      };
      try{
        await fence(currentHome);
        // Reserve only an already validated empty/owned root. Both native
        // writer locks then cover the pointer and capability transition.
        const target=locations.prepareLocation(selection.filePaths[0],selectionOptions);
        if(target!==currentHome)await fence(target);
        selectedHome=locations.selectLocation(selection.filePaths[0],selectionOptions);
        if(selectedHome!==currentHome){
          const stale=require('./launcher-capability').receiptPath(currentHome);
          try{fs.unlinkSync(stale);}catch(error){if(error.code!=='ENOENT')throw error;}
        }
        telemetry?.relocate(path.join(installerDirectory(), 'telemetry.json'));
        fs.mkdirSync(path.join(noraHome(), 'cache', 'tmp'), { recursive: true });
        await registerCapabilities();
        return { cancelled: false, noraHome: noraHome() };
      }finally{
        const released=await Promise.allSettled(leases.reverse().map(lease=>lease.release()));
        const failed=released.find(item=>item.status==='rejected');if(failed)throw failed.reason;
      }
    } finally { selectingLocation = false; }
  });
  const executeAction = async (context, options = {}) => {
    const payload={...context.target.request,...options.payload};
    const operationDirectory=path.join(installerDirectory(),'operations',context.operationId);
    const event=options.event||{sender:null};
    payload.runId ||= options.runId||`resume-${context.operationId}`;
    activeOperationContext=context;
    diagnostics.addSecret(payload.code);
    diagnostics.begin(payload.runId, { operationId:context.operationId, action: payload.action, version: app.getVersion(), channel: CHANNEL,
      platform: process.platform, arch: process.arch, osRelease: os.release(),
      node: process.versions.node, electron: process.versions.electron });
    const telemetryAction = payload.action === 'recover' || (payload.action === 'install' && fs.existsSync(path.join(installRoot(), 'apps/tavern-runtime/native-runtime.json'))) ? 'repair' : payload.action;
    const operationId = telemetry?.begin(telemetryAction,{operationId:context.operationId});
    if (operationId) diagnostics.write('telemetry.operation', { telemetryOperationId:operationId });
    const work = async () => {
    try {
      const legacyRecovery=systemUpdate.inspect(noraHome());
      if(legacyRecovery){
        await context.effect(legacyRecovery.canRecover?'changed':'unknown');
        if(payload.action!=='recover')throw launcherError('旧更新尚未恢复，原安装与备份已保留，请先处理恢复提示。',{code:'UPDATE_RECOVERY_REQUIRED'});
        return await recoverMaintenance(context);
      }
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
      let selectedPlan=context.target.releasePlan;
      const fixedTarget=async(plan,currentVersion=context.target.currentVersion||null)=>{
        const request=context.target.request;
        const contract=plan.schema==='nora-release-plan/1'?releases.sealPlan(plan,{operationDirectory,
          assertOwner:()=>context.check(),launcherVersion:app.getVersion()}):plan;
        await context.plan({request,releasePlan:contract,currentVersion});
        selectedPlan=contract;
      };
      const isUpdate=['update','repair'].includes(payload.action);
      if(payload.action==='install'&&selectedPlan){
        const continued=await systemUpdateExecutor(payload,event.sender).resumeInstallation(context,
          {hasTransaction:fs.existsSync(path.join(installerDirectory(),'operations',context.operationId,'first-install','transaction.json')),port:payload.port});
        if(continued){writeInstallerState({...readInstallerState(),phase:'ready',error:'',task:'',setupCompleted:continued.setupCompleted===true});
          diagnostics.finish('success');return {verification:'confirmed',value:continued};}
      }
      if (isUpdate) {
        telemetry?.stage('release_check');
        if (LOCAL_TEST) throw new Error('本地候选包不用于在线更新，请使用正式模式包。');
        const current = await runBridge('status', { port: payload.port }, event.sender, payload.runId);
        if(selectedPlan){
          const resumed=await systemUpdateExecutor(payload,event.sender).resumeCommitted(context,
            {hasTransaction:fs.existsSync(path.join(installRoot(),'tavern-updates','transaction.json')),port:payload.port});
          if(resumed){
            writeInstallerState({...readInstallerState(),phase:'ready',error:'',task:'',resumeTarget:null});
            diagnostics.finish('success');return {verification:'confirmed',value:resumed};
          }
        }
        if (current.updateRecovery) throw new Error('上次更新尚未恢复完成，请保留日志和备份，暂勿再次更新。');
        diagnostics.write('update.target.requested', { currentVersion: current.version, requestedTag: payload.tag || null,
          selection: payload.tag ? 'explicit' : 'latest', systemReady: current.systemReady, systemProblems: current.systemProblems });
        releaseAbort = new AbortController();
        let prepared;
        try {
          if(!selectedPlan){
            selectedPlan=await releases.selectPlan({fetcher:updateFetch,channel:CHANNEL,tag:payload.tag,
              launcherVersion:app.getVersion(),signal:releaseAbort.signal,
              metadataCache:releaseMetadataCache()});
            await fixedTarget(selectedPlan,current.version);
          }
          await context.stage('downloading');
          prepared = await launcherUpdate.prepare({ fetcher: updateFetch, channel: CHANNEL, tag: payload.tag,
            selectedPlan,operationDirectory,
            launcherVersion: app.getVersion(), cacheRoot: path.join(noraHome(), 'cache', 'releases'),
            signal: releaseAbort.signal, onEvent: message => sendBridgeEvent(event.sender, payload.runId, message) });
        } finally { releaseAbort = null; }
        payload.tag = prepared.tag;
        diagnostics.write('update.target.resolved', { currentVersion: current.version, target: prepared.tag });
        if (cancelled) throw Object.assign(new Error('更新已取消。'),{name:'AbortError',code:'ABORT_ERR'});
        if (prepared.launcher) {
          telemetry?.stage('update_handoff');
          if (!app.isPackaged || !findPython()) throw new Error('需要已安装的完整系统才能自动替换启动器。');
          const job = await launcherUpdate.prepareHandoff({ prepared, home: noraHome(), executable: process.execPath,
            operation:context.snapshot,spawnChild:(command,args,options)=>spawnMaintenance(command,args,options),
            previousVersion:app.getVersion(),
            python: findPython().command, helper: path.join(installerRoot(), 'replace-launcher.py'),
            skillId: /^skill-[a-f0-9-]{36}$/.test(payload.runId) ? payload.runId.slice(6) : null,
            localRelease: localReleaseDirectory, onEvent: message => sendBridgeEvent(event.sender, payload.runId, message) });
          if (cancelled) { fs.writeFileSync(path.join(job, 'cancel'), 'cancel'); throw new Error('更新已取消。'); }
          diagnostics.write('update.handoff', { job, target: payload.tag });
          diagnostics.finish('restarting');
          await context.handoff(job);
          return {handoff:true,value:{restarting:true,job}};
        }
        const comparison = releases.compare(current.version, prepared.manifest.versions.tavern);
        if (comparison === null) throw new Error('当前安装版本不明确，未修改现有安装。');
        if (comparison > 0 && current.systemReady === false) {
          throw new Error('当前安装需要修复，但目标版本更旧；未修改现有安装。');
        }
        if (comparison >= 0 && current.systemReady === true) {
          // A launcher-only handoff still requires the system acceptance before
          // its old APP backup can become terminal.
          if(context.snapshot.handoffRef){
            const verified=await runBridge('verify-current-update',{port:payload.port,version:prepared.manifest.versions.tavern},event.sender,payload.runId);
            if(verified.updateVerified!==true||verified.systemReady!==true||releases.compare(verified.version,prepared.manifest.versions.tavern)!==0)
              throw launcherError('联合更新的原系统尚未通过核验，旧启动器备份已保留。',{code:'VERIFICATION_FAILED'});
            await launcherUpdate.finalize({...launcherRecoveryOptions(),spawnChild:(command,args,options)=>spawnMaintenance(command,args,options),
              job:context.snapshot.handoffRef,version:app.getVersion(),target:verified.version,systemReady:verified.systemReady,updateVerified:verified.updateVerified});
          }
          writeInstallerState({ ...readInstallerState(), phase: current.systemReady ? 'ready' : 'idle', error: '', task: '', resumeTarget: null });
          diagnostics.finish('success');
          return {verification:'confirmed',value:current};
        }
      }
      if (payload.action==='install'||isUpdate) {
        if (isUpdate && LOCAL_TEST) throw new Error('本地候选包不用于在线更新，请使用 Beta 发布包。');
        releaseAbort = new AbortController();
        try {
          selectedPayload = payload.action === 'install' ? (LOCAL_TEST
            ? await prepareTestPayload(payloadDirectory(), LOCAL_TEST, app.getVersion(),
              message => sendBridgeEvent(event.sender, payload.runId, message))
            : selectedPlan?.schema==='nora-bundled-plan/1'
              ? await releases.prepareBundled({bundledRoot:payloadDirectory(),launcherVersion:app.getVersion(),channel:CHANNEL})
              : await releases.prepareInstall({ bundledRoot: payloadDirectory(), launcherVersion: app.getVersion(),
              tag:payload.tag,
              ...(selectedPlan?.schema==='nora-release-plan/1'?{selectedPlan}:{}),operationDirectory,onPlan:fixedTarget,
              fetcher: updateFetch, cacheRoot: path.join(noraHome(), 'cache', 'releases'),
              signal: releaseAbort.signal, channel: CHANNEL,
              confirmBundled: async ({version,error}) => {
                diagnostics.error('release.first-install-check-failed', error);
                telemetry?.report(error,{source:'release_service',site:'release.request'});
                const choice = await dialog.showMessageBox({type:'warning',title:'无法获取最新版本',
                  message:'暂时无法确认最新版本。',
                  detail:`可以取消后检查网络再重试，或安装包内版本 ${version}。包内版本已通过完整性校验，但未确认它是最新版。`,
                  buttons:['取消安装',`安装包内版本 ${version}`],defaultId:0,cancelId:0});
                return choice.response === 1;
              },
              onEvent: message => sendBridgeEvent(event.sender, payload.runId, message) }))
            : await releases.prepareUpdate({
            fetcher: updateFetch,
            selectedPlan,operationDirectory,
            cacheRoot: path.join(noraHome(), 'cache', 'releases'), bundledRoot: payloadDirectory(),
            launcherVersion: app.getVersion(), signal: releaseAbort.signal,
            channel: CHANNEL, tag: isUpdate ? payload.tag : undefined,
            plan: releaseDir => runBridge('plan-update', { port: payload.port, releaseDir }, event.sender, payload.runId),
            onEvent: message => sendBridgeEvent(event.sender, payload.runId, message),
          });
        } finally { releaseAbort = null; }
        if(payload.action==='install'&&LOCAL_TEST&&!selectedPlan){
          const manifest=JSON.parse(fs.readFileSync(path.join(selectedPayload,'release-manifest.json'),'utf8'));
          await fixedTarget({schema:'nora-local-test-plan/1',mode:'install',tag:`v${manifest.versions.tavern}`,
            buildId:LOCAL_TEST.buildId,systemManifestSha256:LOCAL_TEST.systemManifestSha256,
            commit:manifest.commit,platform:process.platform,arch:process.arch,channel:CHANNEL});
        }
        if(selectedPlan?.schema==='nora-bundled-plan/1'
          &&await releases.hash(path.join(selectedPayload,'release-manifest.json'))!==selectedPlan.manifestSha256)
          throw launcherError('固定的包内版本与当前安装包不一致，未修改现有安装。',{code:'RELEASE_COMPATIBILITY'});
        diagnostics.write('release.selected', { payloadRoot: selectedPayload });
        await context.stage('prepared');
        await context.effect('changed');
        if (cancelled) throw Object.assign(new Error('安装已取消。'),{name:'AbortError',code:'ABORT_ERR'});
        if (payload.action === 'install') {
          const removed = cleanupInstallTemps(noraHome());
          if (removed.length) sendBridgeEvent(event.sender, payload.runId,
            { event: 'task', task: `已清理 ${removed.length} 个上次安装的临时目录` });
          await ensureHermesFromNode(event.sender, payload.runId, selectedPayload);
        }
      }
      if (cancelled) throw Object.assign(new Error('安装已取消。'),{name:'AbortError',code:'ABORT_ERR'});
      await context.stage('applying');
      const result = isUpdate
        ? await performSystemUpdate(selectedPayload, payload, event.sender)
        : await runBridge(payload.action === 'recover' ? 'recover-update' : payload.action, { port: payload.port, code: payload.code, tag: payload.tag, service: payload.service,
        ...(payload.action === 'install' ? { releaseDir: selectedPayload } : {}) }, event.sender, payload.runId);
      const finalState = readInstallerState();
      await context.stage('verifying');
      const targetVersion=selectedPayload?JSON.parse(fs.readFileSync(path.join(selectedPayload,'release-manifest.json'),'utf8')).versions?.tavern:undefined;
      if(!verifyWorkflowResult({action:payload.action,service:payload.service,targetVersion,result}))
        throw launcherError('后台返回的实际状态尚未满足本次操作要求，请重新检查状态。',{code:'VERIFICATION_FAILED'});
      writeInstallerState({ ...finalState, phase: result.systemReady ? 'ready' : 'idle', setupCompleted: Boolean(result.setupCompleted), error: '', task: '', resumeTarget: null });
      telemetry?.status({ ...result, installer: { phase: result.systemReady ? 'ready' : 'idle' } });
      diagnostics.finish('success');
      return {verification:'confirmed',value:result};
    } catch (error) {
      diagnostics.error('run.failed', error, { cancelled });

      try {
        const failed = readInstallerState();
        const milestones = failed.milestones.map((item) => item.state === 'running'
          ? { ...item, state: 'error', task: '失败' }
          : item);
        writeInstallerState({ ...failed, milestones, phase: cancelled ? 'cancelled' : 'error', error: cancelled ? '' : formatUserError(error, {action:payload.action}) });
      } catch (stateError) { diagnostics.error('state.write-failed', stateError);
        error.secondaryErrors=[...(error.secondaryErrors||[]),{operation:'installer-state',error:stateError}]; }
      diagnostics.finish(cancelled ? 'cancelled' : 'error');
      throw error;
    }
    };
    return telemetry ? telemetry.scope(work) : work();
  };

  for(const action of ['install','start','stop','restart','pair','update','repair','recover'])operationExecutors[action]=executeAction;
  for(const action of ['install','update','repair','recover']){
    operationRecoverers[action]=async(context,options)=>{
      activeOperationContext=context;
      if(!options.error){
        diagnostics.begin(options.runId||context.operationId,{operationId:context.operationId,action:'repair'});
        telemetry?.begin('repair',{operationId:context.operationId});
      }
      telemetry?.stage('rollback');
      return recoverMaintenance(context,options);
    };
    operationRecheckers[action]=(record,context)=>maintenancePolicy().recheck(record,context);
  }
  for(const action of ['start','restart'])operationRecheckers[action]=(record,context)=>maintenancePolicy().recheck(record,context);
  operationExecutors.model=async context=>{
    if(context.target.request?.mode!=='resume')throw launcherError('请重新填写并提交模型配置。',{code:'OPERATION_ACTION_UNAVAILABLE'});
    activeOperationContext=context;
    telemetry?.begin('model',{operationId:context.operationId});
    await context.stage('applying');const result=await finishModelSetup();
    await context.stage('verifying');return {verification:'confirmed',value:result};
  };
  const operationRequest=payload=>{
    if(!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(payload?.operationId||'')
      ||!Number.isSafeInteger(payload.snapshotSequence)||payload.snapshotSequence<1)
      throw launcherError('操作状态已变化，请重新查询后再继续。',{code:'OPERATION_SNAPSHOT_CHANGED'});
    return {snapshotSequence:payload.snapshotSequence,runId:payload.runId,onFailure:rememberOperationFailure};
  };
  handle('nora:operation-snapshot',(_event,payload)=>operations().snapshot(payload?.operationId));
  handle('nora:operation-logs',(_event,payload)=>diagnostics.readOperation(payload?.operationId || diagnostics.operationId, payload?.cursor));
  for(const mode of ['resume','recover'])handle(`nora:operation-${mode}`,async(event,payload)=>{
    if(activeRun||modelBusy)throw launcherError('正在处理任务，请等待完成。',{code:'OPERATION_BUSY'});
    const options=operationRequest(payload);activeRun=true;cancelled=false;
    try{
      const operation=await operations()[mode](payload.operationId,{...options,event});
      finishOperationTelemetry(operation,{recover:mode==='recover'});
      if(['succeeded','rolled-back'].includes(operation.state))await registerCapabilities();
      return requireOperationResult(operation,{recover:mode==='recover'});
    }finally{activeRun=false;activeOperationContext=null;}
  });
  handle('nora:operation-recheck',async(_event,payload)=>{
    if(activeRun||modelBusy)throw launcherError('正在处理任务，请等待完成。',{code:'OPERATION_BUSY'});
    const options=operationRequest(payload);
    return {operation:await operations().recheck(payload.operationId,options)};
  });

  const runAction = async (event,payload) => {
    if (modelBusy || activeRun) throw new Error('Nora 正在处理任务，请稍候。');
    if (!['install', 'start', 'stop', 'restart', 'pair', 'update', 'repair', 'recover'].includes(payload?.action)) throw new Error('不支持的操作。');
    if (payload.port !== undefined && (!Number.isInteger(payload.port) || payload.port < 1024 || payload.port > 65535)) throw new Error('端口无效。');
    if (typeof payload.runId !== 'string' || !/^[\w-]{1,100}$/.test(payload.runId)) throw new Error('任务编号无效。');
    if (payload.tag !== undefined && !/^[a-zA-Z0-9._-]{1,100}$/.test(payload.tag)) throw new Error('版本编号无效。');
    if (payload.service !== undefined && (!['all', 'nora', 'tavern'].includes(payload.service)
      || !['start', 'stop', 'restart'].includes(payload.action))) throw new Error('服务目标无效。');
    activeRun=true;cancelled=false;
    try {
      const request={action:payload.action};
      for(const name of ['port','tag','service'])if(payload[name]!==undefined)request[name]=payload[name];
      const operation=await operations().start(payload.action,{target:{request},
        execute:context=>executeAction(context,{payload,event}),onFailure:rememberOperationFailure},payload.runId);
      if(operation.state==='awaiting-handoff'){
        try{
          await launcherUpdate.launchHandoff({...launcherRecoveryOptions(),job:operation.handoffRef,
            managedPythonRoot:path.join(hermesHome(),'python'),venvHome:path.join(hermesHome(),'hermes-agent','venv'),env:process.env});
          quitReady=true;setImmediate(()=>app.quit());
        }catch(error){
          const failed=await operations().failHandoff(operation.operationId,{job:operation.handoffRef,error,onFailure:rememberOperationFailure});
          finishOperationTelemetry(failed);return requireOperationResult(failed);
        }
      }
      finishOperationTelemetry(operation,{recover:payload.action==='recover'});
      if(['succeeded','rolled-back'].includes(operation.state))await registerCapabilities();
      return requireOperationResult(operation,{recover:payload.action==='recover'});
    }finally{activeRun=false;activeOperationContext=null;}
  };
  handle('nora:run', runAction);
  const skillUpdates = createSkillUpdateReceiver({
    home: noraHome,
    busy: () => activeRun || modelBusy || quitting || uninstalling || selectingLocation || Boolean(statusRequest) || Boolean(MOCK_SCENARIO),
    clean: value => diagnostics.clean(value),
    execute: async (action, id) => {
      if (systemUpdate.pending(noraHome())) throw new Error('上次更新尚待恢复，请先在启动器中检查状态。');
      if (action === 'check') {
        const result = await trackLauncher('check_update','release_check', () => releases.check({ fetcher: updateFetch, installRoot: installRoot(), launcherVersion: app.getVersion(), channel: CHANNEL }));
        if (result.error) throw new Error(result.error);
        return result;
      }
      // runAction takes ownership synchronously, before it first yields.
      const result = await runAction({ sender: null }, { action: 'update', runId: `skill-${id}` });
      if (result.restarting) return result;
      return { version: result.version, systemReady: result.systemReady,
        running: result.running, gatewayRunning: result.gatewayRunning };
    },
  });
  handle('nora:cancel', async () => {
    if (updatingSystem) return { ok: false, warning: '正在替换并检查程序文件，当前阶段不能取消，请等待结果。' };
    if (releaseAbort) { cancelled = true; releaseAbort.abort(); return { ok: true }; }
    if (!activeProcess) return { ok: false, warning: '当前没有正在运行的任务。' };
    if (activeProcess.cancelSafe === false) return { ok: false, warning: '正在处理程序文件或恢复旧版本，当前阶段不能取消，请等待结果。' };
    cancelled = true;
    if(!activeOperationContext)return {ok:false,warning:'执行状态尚未确认，请重新检查。'};
    await activeOperationContext.lease.cancel({signal:'SIGTERM'});
    return { ok: true,closed:true };
  });
  handle('nora:open-logs', async () => {
    let installerLog = diagnostics.lastFile || path.join(installerDirectory(), 'install.log');
    try {
      const pending=await readLauncherRecovery();
      if (typeof pending?.job === 'string' && typeof pending?.log === 'string') {
        const job=path.resolve(pending.job),log=path.resolve(pending.log);
        const managed=path.join(fs.realpathSync(noraHome()),'installer','launcher-update');
        const jobInfo=fs.lstatSync(job),logInfo=fs.lstatSync(log),realJob=fs.realpathSync(job);
        if (/^job-[\w-]+$/.test(path.basename(job)) && path.dirname(realJob) === managed
          && log === path.join(job,'replace.log') && jobInfo.isDirectory() && !jobInfo.isSymbolicLink()
          && logInfo.isFile() && !logInfo.isSymbolicLink() && fs.realpathSync(log) === path.join(realJob,'replace.log'))
          installerLog=log;
      }
    } catch (error) { diagnostics.error('update.launcher-log-unavailable',error); }
    const target = fs.existsSync(installerLog) ? installerLog
      : path.join(installRoot(), 'tavern-state', 'native-runtime', 'runs', 'production', 'native.log');
    if (!fs.existsSync(target)) return { ok: false, warning: '日志文件还不存在。' };
    try {
      const openError = await shell.openPath(target);
      if (openError) throw new Error(openError);
    } catch (error) {
      throw launcherError('日志文件无法通过系统打开。', {userCode:'LOG_OPEN_FAILED'}, error);
    }
    return { ok: true };
  });
  handle('nora:telemetry', async (_event, value) => {
    if (value !== undefined && typeof value !== 'boolean') throw new Error('诊断授权设置无效。');
    return value === undefined ? telemetry?.settings() : telemetry?.setEnabled(value);
  });
  handle('nora:model-providers', async () => {
    if (!findHermes()) return { ok: false, warning: '请先安装 Nora。', providers: [] };
    return { ok: true, providers: publicProviders(), current: readVerifiedModel(noraHome()) };
  });
  handle('nora:model-options', async (_event, payload) => {
    diagnostics.addSecret(payload?.key);
    if (!findHermes()) throw new Error('请先安装 Nora。');
    return { ok: true, ...(await trackLauncher('list_models','model_test', () => loadProviderModels(payload?.provider, payload?.key, payload?.baseUrl, payload?.authMode))) };
  });
  handle('nora:model-resume', async () => {
    if (activeRun || modelBusy) throw new Error('Nora 正在处理其他任务，请稍候。');
    modelBusy = true;
    try {
      if (statusRequest) await statusRequest.catch(() => {});
      return await runOwnedTask('model',{mode:'resume'},async context=>{
        telemetry?.stage('model_save');await context.stage('applying');
        const result=await finishModelSetup();await context.stage('verifying');
        return {verification:'confirmed',value:result};
      });
    } catch (error) {
      diagnostics.error('model.resume-failed', error);
      recordFailureEvent({ event: 'milestone', index: 2, state: 'error', task: '酒馆模型同步未完成' },error);
      throw error;
    } finally { modelBusy = false; }
  });
  handle('nora:model-save-test', async (_event, payload) => {
    if (activeRun || modelBusy) throw new Error('Nora 正在处理其他任务，请稍候。');
    const provider = requireProvider(payload?.provider);
    const key = modelCredential(provider, payload);
    diagnostics.addSecret(key);
    const model = String(payload?.model || '').trim();
    const baseUrl = provider.id === 'custom' ? normalizeCustomBaseUrl(payload?.baseUrl) : '';
    if (!model || model.length > 240 || /[\r\n]/.test(model)) throw new Error('请选择模型。');
    const conditionFingerprint=configurationFingerprint({provider:provider.id,model,key,baseUrl,
      authMode:provider.custom&&payload.authMode==='none'?'none':'key'},uninstall.own(noraHome()));
    modelBusy = true;
    let configurationSaved=false;
    try {
      return await runOwnedTask('model',{mode:'configure',provider:provider.id},async context=>{
      telemetry?.stage('model_test');
      recordEvent({ event: 'milestone', index: 2, state: 'running', task: '正在测试 Nora' });
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
      telemetry?.stage('model_save');
      await context.stage('applying');
      const saved = await runModelConfigHelper({
        action: 'save',
        provider: provider.id,
        keyEnv: provider.keyEnv,
        key,
        model: normalized.model,
        baseUrl,
      });
      configurationSaved=true;
      let result;
      try {
        writeVerifiedModel(noraHome(), { ...saved, key,
          authMode: provider.custom && payload.authMode === 'none' ? 'none' : 'key',
          tavernSyncPending: !readInstallerState().setupCompleted });
        result=await finishModelSetup();
      }
      catch(error){
        if(error.userCode!=='MODEL_SYNC_PENDING')
          throw launcherError(`模型配置已保存，最后检查未完成：${error.message}`,{userCode:'MODEL_CONFIG_PARTIAL'},error);
        throw error;
      }
      await context.stage('verifying');
      return {verification:'confirmed',value:result};
      },{conditionFingerprint});
    } catch (error) {
      if (configurationSaved && !error.operation && error.userCode !== 'MODEL_SYNC_PENDING')
        error=launcherError(`模型配置已保存，最后检查未完成：${error.message}`,{userCode:'MODEL_CONFIG_PARTIAL'},error);
      diagnostics.error('model.failed', error);
      recordFailureEvent({ event: 'milestone', index: 2, state: 'error', task: '模型配置未完成' },error);
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
    const result = await checkRelease();
    // trackLauncher already saved the failure in this check's own log scope.
    // Writing again here would attach it to the last maintenance operation.
    if(result.diagnosticError)result.failureCode=describeError(result.diagnosticError,{source:'release_service'}).error_code;
    if (result.error) result.error = formatUserError(result.diagnosticError || new Error(result.error), {action:'check_update',source:'release_service'});
    if (result.compatibilityError) result.compatibilityError = formatUserError(
      result.diagnosticError || new Error(result.compatibilityError), {action:'check_update',source:'release_service'});
    return result;
  });
  handle('nora:uninstall', beginUninstall);
  handle('nora:open-external', async (_event, url) => {
    await shell.openExternal(externalUrl(url));
    return { ok: true };
  });

  {
    app.on('before-quit', requestQuit);
    app.whenReady().then(async () => {
      if (!SYSTEM_UNINSTALL) {
        const timer = setInterval(() => skillUpdates.tick().catch(error => diagnostics.error('skill-update.failed', error)), 2000);
        const outboxTimer=setInterval(()=>drainPendingOutboxes(),60000);
        timer.unref();
        outboxTimer.unref();
        app.once('will-quit', () => { clearInterval(timer);clearInterval(outboxTimer); skillUpdates.close(); });
        await registerCapabilities();
        if (SELF_UPDATE_JOB) activeRun = true;
        createWindow();
        if(!SELF_UPDATE_JOB)drainPendingOutboxes();
        if (SELF_UPDATE_JOB) {
          const window = BrowserWindow.getAllWindows()[0];
          window.webContents.once('did-finish-load', async () => {
            let plan;
            try {
              plan = launcherUpdate.resume(SELF_UPDATE_JOB, { home: noraHome(), executable: process.execPath, version: app.getVersion() });
              if (plan) {
                await launcherUpdate.waitHandoff({...launcherRecoveryOptions(),job:SELF_UPDATE_JOB});
                writeInstallerState({ ...readInstallerState(), resumeTarget: plan.target });
                const before=await operations().snapshot(plan.operationId);
                const operation=await operations().resume(plan.operationId,{snapshotSequence:before.snapshotSequence,
                  handoff:{job:SELF_UPDATE_JOB,planDigest:plan.planDigest},event:{sender:window.webContents},
                  runId:before.requestId,onFailure:rememberOperationFailure});
                finishOperationTelemetry(operation);
                const result=requireOperationResult(operation);
                await registerCapabilities();
                finishHandoff(noraHome(), plan.skillId, { version: result.version, systemReady: result.systemReady });
              }
            } catch (error) {
              activeRun = false; diagnostics.error('update.resume', error);
              if (plan?.skillId) finishHandoff(noraHome(), plan.skillId, null, diagnostics.clean(error.message));
            }finally{activeRun=false;activeOperationContext=null;}
          });
        }
        return;
      }
      try {
        const destination = path.resolve(SYSTEM_UNINSTALL);
        if (process.platform !== 'win32' || path.basename(destination) !== 'nora-uninstall.json'
          || !destination.startsWith(path.resolve(os.tmpdir()) + path.sep)) throw new Error('系统卸载请求无效。');
        if (!await confirmUninstall(destination)) app.exit(1);
      } catch (error) { dialog.showErrorBox('卸载未完成', error.message); app.exit(1); }
    });
  }
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
