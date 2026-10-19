const { app, BrowserWindow, dialog, ipcMain, shell, net, session, crashReporter } = require('electron');
const { spawn } = require('node:child_process');
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
let lifecycleDiagnostics;
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
  if(!telemetry)queueLifecycleFailure('startup',error);
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
    client:'updater',updaterCapabilities:releases.UPDATER_CAPABILITIES,launcherVersion:app.getVersion(),launcherDiscovery:true,
    ...(localReleaseDirectory?{allowCandidate:true,explicitLocalRelease:localReleaseDirectory}:{}),
    installRoot:installRoot(),channel:CHANNEL,metadataCache:releaseMetadataCache()}))
    .then(result=>({...result,launcherVersion:app.getVersion()}))
    .finally(()=>{releaseCheckRequest=null;});
  return releaseCheckRequest;
}
const systemUpdate = require('./system-update');
const { createSkillUpdateReceiver, finishHandoff } = require('./skill-update');
const launcherUpdate = require('./launcher-update');
let SELF_UPDATE_JOB = process.argv.find(value => value.startsWith('--nora-self-update='))?.slice('--nora-self-update='.length);
const updateSequence = require('./update-sequence');
let continueDesktopUpdate;
let desktopUpdateNotice;
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
    prepareEffects:context=>maintenancePolicy().prepareEffects(context),
    captureConditions:(record,context)=>maintenancePolicy().initialConditions(record,context),
    identifyFailureCondition:(error,record)=>maintenancePolicy().identifyFailureCondition(error,record),
    verifyHandoff:async(record,proof)=>launcherUpdate.verifyHandoff({...launcherRecoveryOptions(),job:proof.job,
      operation:record,version:app.getVersion(),planDigest:proof.planDigest}),
    verifyRecoveryHandoff:async(record,proof)=>launcherUpdate.verifyRecovery({...launcherRecoveryOptions(),job:proof?.job,operation:record}),
    verifyRestoredHandoff:async(record,context)=>{
      const previous=activeOperationContext;activeOperationContext=context;
      try{return await maintenancePolicy().reconcileHandoff(record,context);}
      finally{activeOperationContext=previous;}
    }});
}

let operationPolicy;
function maintenancePolicy(){
  return operationPolicy ||= require('./operation-policy').create({home:noraHome,hermesHome,installRoot,
    networkFetch:releaseNetwork.readOnce,launcherVersion:()=>app.getVersion(),channel:CHANNEL,
    bridge:(command,options)=>runBridge(command,options),
    runRuntime:(context,{recover,allowCommitted,partialRepair,inspectPartial})=>runProcess(process.execPath,
      [path.join(__dirname,'runtime-worker.js'),payloadDirectory(),noraHome(),hermesHome(),
        ...(recover?['--recover-runtime']:[]),...(allowCommitted?['--allow-committed']:[]),
        ...(partialRepair?['--repair-managed']:[]),...(inspectPartial?['--inspect-managed']:[])],null,context.operationId,
      {input:partialRepair?JSON.stringify(partialRepair):undefined,returnResult:true}),
    runLegacy:(context,request)=>runProcess(process.execPath,[path.join(__dirname,'legacy-recovery-worker.js'),noraHome()],null,
      context.operationId,{kind:'legacy-recovery',input:JSON.stringify(request),returnResult:true}),
    inspectLauncher:job=>launcherUpdate.assessJob({...launcherRecoveryOptions(),job}),
    inspectLauncherOutcome:(job,operation)=>launcherUpdate.inspectOutcome({...launcherRecoveryOptions(),job,operation,
      spawnChild:(command,args,options)=>spawnMaintenance(command,args,options)})});
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
      port:installationPort(await operations().snapshot()),channel:CHANNEL});
  }catch(error){diagnostics.error('operation.capability-registration-failed',error);return null;}
}

function drainPendingOutboxes(){
  if(!app.isPackaged||ISOLATED_TEST&&!LOCAL_TEST?.telemetryEnabled||localReleaseDirectory
    ||MOCK_SCENARIO||SELF_UPDATE_JOB&&activeRun||activeRun||modelBusy||uninstalling||selectingLocation||quitting)return;
  if(outboxDrain)return outboxDrain;
  outboxDrain=Promise.allSettled([getLifecycleDiagnostics().drain(),
    require('./operation-cli').drainOperationOutboxes({noraHome:noraHome(),launcherVersion:app.getVersion(),
      fetcher:(url,options)=>net.fetch(url,options)})]).then(results=>{
        for(const result of results)if(result.status==='rejected')diagnostics.error('telemetry.outbox-deferred',result.reason);
      })
    .catch(error=>diagnostics.error('telemetry.outbox-deferred',error)).finally(()=>{outboxDrain=null;});
  return outboxDrain;
}
function lifecycleReportingEnabled(){
  return Boolean(app.isPackaged&&(!ISOLATED_TEST||LOCAL_TEST?.telemetryEnabled===true)&&!localReleaseDirectory);
}
function getLifecycleDiagnostics(){
  return lifecycleDiagnostics ||= require('./lifecycle-diagnostics').createLifecycleDiagnostics({
    directory:path.join(app.getPath('appData'),'NoraTavern','diagnostics','lifecycle'),
    launcherVersion:app.getVersion(),enabled:lifecycleReportingEnabled(),
    fetcher:(url,options)=>net.fetch(url,options),clean:diagnostics.clean,
    roots:()=>[os.homedir()],diagnostic:code=>diagnostics.write('telemetry.lifecycle-diagnostic',{code})});
}
function queueLifecycleFailure(kind,error){
  try{
    let home=null;try{home=noraHome();}catch{}
    const handle=getLifecycleDiagnostics().capture(kind,error,{home});
    if(handle)void handle.flush().finally(()=>handle.close()).catch(()=>
      diagnostics.write('telemetry.lifecycle-diagnostic',{code:'delivery_deferred'}));
  }catch{diagnostics.write('telemetry.lifecycle-diagnostic',{code:'capture_unavailable'});}
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
    resumeTarget: null,
    milestones: MILESTONES.map((label, index) => ({ index, label, state: 'pending', task: '' })),
  };
}

// This file is a UI projection, not the operation journal or an installation
// receipt. Keep the current projection in memory if its cache cannot be saved;
// controller commits and backend acceptance still determine the outcome.
let installerStateCache = null;
let installerStateWarning = '';
function normalizeInstallerState(value) {
  const state = defaultInstallerState();
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.schema !== 1) return state;
  if (['idle','installing','ready','start','stop','restart','pair','update','repair','recover','error','cancelled'].includes(value.phase)) state.phase = value.phase;
  for (const name of ['task','error']) if (typeof value[name] === 'string') state[name] = value[name];
  if (Number.isSafeInteger(value.startedAt) && value.startedAt >= 0) state.startedAt = value.startedAt;
  if (Number.isSafeInteger(value.updatedAt) && value.updatedAt >= 0) state.updatedAt = value.updatedAt;
  if (typeof value.setupCompleted === 'boolean') state.setupCompleted = value.setupCompleted;
  if (Number.isInteger(value.port) && value.port >= 1024 && value.port <= 65535) state.port = value.port;
  if (typeof value.resumeTarget === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}$/.test(value.resumeTarget)) state.resumeTarget = value.resumeTarget;
  const milestones = Array.isArray(value.milestones) ? value.milestones : [];
  state.milestones = state.milestones.map(item => {
    const prior = milestones.find(value => value && typeof value === 'object' && value.index === item.index);
    return { ...item, state: ['pending','running','done','error'].includes(prior?.state) ? prior.state : 'pending',
      task: typeof prior?.task === 'string' ? prior.task : '' };
  });
  const progress = value.progress;
  if (progress && typeof progress === 'object' && !Array.isArray(progress) && Number.isFinite(progress.current) && progress.current >= 0
    && (progress.total === undefined || Number.isFinite(progress.total) && progress.total >= 0)) {
    state.progress = { event: 'progress', current: progress.current };
    if (progress.total !== undefined) state.progress.total = progress.total;
    if (Number.isFinite(progress.ratio)) state.progress.ratio = Math.max(0, Math.min(1, progress.ratio));
    for (const name of ['task','stage','stage_id','unit']) if (typeof progress[name] === 'string') state.progress[name] = progress[name];
  }
  return state;
}

function readInstallerState() {
  const target = installerStatePath();
  if (installerStateCache?.file === target && installerStateCache.dirty) return { ...installerStateCache.value };
  try {
    const stat = fs.lstatSync(target);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 64 * 1024) throw new Error('Invalid presentation cache');
    const saved = JSON.parse(fs.readFileSync(target, 'utf8'));
    const value = normalizeInstallerState(saved);
    if (saved?.schema !== 1 || saved?.milestones !== undefined && !Array.isArray(saved.milestones))
      diagnostics.write('state.cache-rebuilt', { level: 'warning' });
    installerStateCache = { file: target, value, dirty: false };
    return { ...value };
  } catch {
    return installerStateCache?.file === target ? { ...installerStateCache.value } : defaultInstallerState();
  }
}

function writeInstallerState(value) {
  const next = { ...normalizeInstallerState(value), updatedAt: Date.now() };
  const target = installerStatePath();
  const temporary = `${target}.${process.pid}.${require('node:crypto').randomUUID()}.tmp`;
  installerStateCache = { file: target, value: next, dirty: true };
  try {
    fs.mkdirSync(installerDirectory(), { recursive: true });
    fs.writeFileSync(temporary, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
    fs.renameSync(temporary, target);
    installerStateCache.dirty = false;
    if (installerStateWarning) diagnostics.write('state.cache-restored', { level: 'info' });
    installerStateWarning = '';
  } catch (error) {
    const signature = `${target}:${diagnostics.operationId}:${error.code || error.name}:${error.syscall || ''}`;
    if (installerStateWarning !== signature) {
      installerStateWarning = signature;
      diagnostics.error('state.cache-write-failed', launcherError('安装进度缓存暂时无法保存；实际结果以维护记录和状态核验为准。',
        { userCode: 'INSTALLER_STATE_WRITE_FAILED' }, error), { level: 'warning', projection: true });
    }
  } finally {
    try { fs.rmSync(temporary, { force: true }); }
    catch (error) { diagnostics.error('state.cache-cleanup-failed', error, { level: 'warning', projection: true }); }
  }
  return next;
}

let installerPortBinding = null;
function confirmedMaintenanceIdentity(operation) {
  if (operation?.verification !== 'confirmed' || !['install','update','repair','recover'].includes(operation.kind)) return null;
  const result = operation.result;
  if (!result || typeof result !== 'object') return null;
  let version, commit;
  if (operation.state === 'rolled-back' || operation.state === 'failed') {
    if (operation.state === 'failed'
      ? operation.currentFailure || operation.effectState !== 'untouched' || operation.recoveryOutcome !== 'not-required' || result.notAppliedVerification !== 'confirmed'
      : operation.effectState !== 'restored' || operation.recoveryOutcome !== 'restored-and-verified' || result.recoveryVerification !== 'confirmed') return null;
    version = result.version; commit = result.commit;
    // A rollback restores its original system, not the candidate plan's new
    // version. The first failure remains immutable diagnostic evidence.
    const original = operation.target?.currentVersion;
    if (typeof original === 'string' && releases.compare(original, original) === 0
      && releases.compare(version, original) !== 0) return null;
  } else if (operation.state === 'succeeded' && operation.kind !== 'recover') {
    if (operation.currentFailure || operation.effectState === 'unknown'
      || ['recovery-required','files-restored-start-failed'].includes(operation.recoveryOutcome)
      || ['update','repair'].includes(operation.kind) && result.updateVerified !== true) return null;
    const plan = operation.target?.releasePlan;
    version = plan?.version || plan?.releaseManifest?.versions?.tavern;
    commit = plan?.commit || plan?.releaseManifest?.commit;
    if (plan?.schema === 'nora-release-plan/1') {
      try {
        const fixed = releases.validatePlan(plan, { launcherVersion: app.getVersion(), channel: CHANNEL,
          platform: process.platform, arch: process.arch,
          operationDirectory: path.join(installerDirectory(), 'operations', operation.operationId),
          ...(plan.client === 'updater' ? { client: 'updater', updaterCapabilities: releases.UPDATER_CAPABILITIES } : {}),
          ...(plan.candidateAcceptance ? { allowCandidate: true, explicitLocalRelease: plan.candidateAcceptance.releaseDirectory } : {}) });
        ({ version, commit } = releases.coreIdentity(fixed));
      } catch { return null; }
    }
  } else return null;
  if (typeof version !== 'string' || releases.compare(version, version) !== 0
    || releases.compare(result.version, version) !== 0 || !/^[a-f0-9]{40}$/.test(commit || '') || result.commit !== commit) return null;
  return { version, commit };
}

function installationPort(operation = activeOperationContext?.snapshot) {
  const roots = { noraHome: noraHome(), hermesHome: hermesHome(), installRoot: installRoot() };
  const identity = JSON.stringify(roots);
  const bound = value => Object.entries(roots).every(([name, expected]) => typeof value?.[name] === 'string'
    && path.isAbsolute(value[name]) && path.resolve(value[name]) === path.resolve(expected));
  const validPort = value => Number.isInteger(value) && value >= 1024 && value <= 65535;
  const invalid = cause => launcherError('当前安装的实例端口或目录记录不一致，尚未查询或修改服务；请保留现有安装和日志。',
    { code: 'VERIFICATION_FAILED', source: 'launcher', site: 'launcher.operation' }, cause);
  let instance;
  const target = path.join(roots.hermesHome, 'nora-instance.json');
  try {
    const stat = fs.lstatSync(target);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 32 * 1024) throw new Error('Invalid instance record path or size');
    instance = JSON.parse(fs.readFileSync(target, 'utf8'));
    if (instance.schema !== 1 || !bound(instance) || !validPort(instance.port)
      || instance.releaseChannel !== undefined && instance.releaseChannel !== CHANNEL) throw new Error('Invalid instance record binding');
  } catch (error) { if (error.code !== 'ENOENT') throw invalid(error); }
  let accepted = installerPortBinding?.identity === identity ? installerPortBinding.port : null;
  if (confirmedMaintenanceIdentity(operation) && operation.result.systemReady === true && bound(operation.result)
    && validPort(operation.result.port)) accepted = operation.result.port;
  if (instance && accepted !== null && instance.port !== accepted) throw invalid(new Error('Instance and accepted maintenance ports disagree'));
  const port = instance?.port ?? accepted;
  if (port !== null && port !== undefined) {
    installerPortBinding = { identity, port };
    return port;
  }
  const retained=require('./retained-installation').inspect(roots.noraHome,{allowPending:true,operationId:operation?.operationId});
  if(retained){const cached=readInstallerState().port;return retained.port||(Number.isInteger(cached)&&cached>=1024&&cached<=65535?cached:DEFAULT_PORT);}
  if (require('./operation-policy').hasManagedRecords(roots)) throw invalid(new Error('Managed installation has no verified instance port'));
  const cached = readInstallerState().port;
  return validPort(cached) ? cached : DEFAULT_PORT;
}

function reconcileInstallerState(operation, runtime, { hasRecovery = false } = {}) {
  const state = readInstallerState();
  const result = operation?.result, identity = confirmedMaintenanceIdentity(operation);
  if (activeRun || hasRecovery || operation?.busy || !identity || result.systemReady !== true || runtime?.systemReady !== true
    || releases.compare(runtime.version, identity.version) !== 0 || runtime.commit !== identity.commit) return state;
  for (const [name, expected] of Object.entries({ noraHome: noraHome(), hermesHome: hermesHome(), installRoot: installRoot() })) {
    if ([result[name], runtime[name]].some(value => typeof value !== 'string' || !path.isAbsolute(value)
      || path.resolve(value) !== path.resolve(expected))) return state;
  }
  if (!Number.isInteger(result.port) || result.port !== runtime.port) return state;
  const setupCompleted = typeof runtime.setupCompleted === 'boolean' ? runtime.setupCompleted : state.setupCompleted;
  if (state.phase === 'ready' && !state.error && !state.task && !state.resumeTarget && state.setupCompleted === setupCompleted) return state;
  return writeInstallerState({ ...state, port: runtime.port, phase: 'ready', error: '', task: '', resumeTarget: null, setupCompleted });
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
      String(options.port || installationPort(options.operation)),
      command,
      ...(options.service ? ['--service', options.service] : []),
      ...(options.releaseDir ? ['--release-dir', options.releaseDir] : []),
      ...(options.url ? [options.url] : []),
      ...(options.tag ? ['--tag', options.tag] : []),
      ...(options.operationId ? ['--operation-id',options.operationId] : []),
      ...(options.kind ? ['--kind',options.kind] : []),
      ...(options.version ? ['--version',options.version] : []),
      ...(command==='inspect-current-update' ? ['--commit',options.commit,
        ...(options.manifestSha256 ? ['--manifest-sha256',options.manifestSha256] : [])] : []),
    ],
  };
}

function nodeStatus(error = '', operation) {
  const root = installRoot();
  const port = installationPort(operation);
  const verifiedModel = readVerifiedModel(noraHome());
  const installed = fs.existsSync(path.join(root, 'apps', 'tavern-runtime', 'native-runtime.json'))
    && fs.existsSync(path.join(root, 'apps', 'tavern-runtime', 'native_lifecycle.py'));
  const retained=require('./retained-installation').inspect(noraHome(),{allowPending:true,operationId:operation?.operationId});
  const removed=retained&&!retained.reinstalled;
  const managed = removed?null:require('./operation-policy').inspectManagedInstallation({noraHome:noraHome(),hermesHome:hermesHome(),
    installRoot:root,port,operationId:operation?.operationId});
  return {
    installed:removed?false:installed,
    systemReady: false,
    setupCompleted: false,
    hermesInstalled: removed?false:Boolean(findHermes()),
    modelConfigured: false,
    modelProvider: verifiedModel?.provider || '',
    modelName: verifiedModel?.model || '',
    modelBaseUrl: verifiedModel?.baseUrl || '',
    running: false,
    gatewayRunning: false,
    clawchatConnected: false,
    clawchatPaired: false,
    busy: activeRun || modelBusy,
    port,
    url: `http://127.0.0.1:${port}`,
    home: noraHome(),
    noraHome: noraHome(),
    hermesHome: hermesHome(),
    installRoot: root,
    warning: error || undefined,
    installer: readInstallerState(),
    ...(removed?{retainedInstallation:true,retainedUninstallPending:retained.state==='prepared',noraInstalled:false,
      warning:retained.state==='prepared'?'保留数据卸载尚未完成，请在更多中继续卸载。':undefined}:{}),
    ...(retained?.cleanupPending?{retainedCompletionPending:true,warning:error||retained.warning}:{}),
    ...(managed?.needsRepair?{managedInstallation:true,needsRepair:true,version:managed.version,commit:managed.commit,
      missingPrograms:managed.missing,systemProblems:['已有安装的程序文件缺失，需要保留数据修复。'],
      running:null,gatewayRunning:null,clawchatConnected:null}:{}),
    ...locationStatus(),
  };
}

function finishRetainedInstallation(context,result){
  const completion=require('./retained-installation').consume(noraHome(),context.operationId,{result});
  if(!completion?.pending)return result;
  diagnostics.write('retained.completion-pending',{operationId:context.operationId,code:completion.code});
  return {...result,retainedCompletionPending:true,warning:[result.warning,completion.warning].filter(Boolean).join('\n')};
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
      proc = ['status','inspect-current-update'].includes(command) || (!activeOperationContext && ['verify-model','operation-effects','check-update','plan-update'].includes(command))
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
    const timeoutMs = command === 'status' ? 90000 : command === 'stop' ? 60000 : ['repair-preflight','operation-effects'].includes(command) ? 300000 : 30 * 60 * 1000;
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

async function reconcileRestoredHandoff() {
  // The restored GUI can start just before its helper releases the writer.
  // Wait for that owner, then perform one explicit verification, never a
  // repeated full-tree check in the ordinary status polling path.
  for(let attempt=0;attempt<8;attempt++){
    const pending=await operations().snapshot();
    if(!pending?.handoffRef)return;
    if(pending.busy){await new Promise(resolve=>setTimeout(resolve,250));continue;}
    if(pending.state==='interrupted')
      return operations().recheck(pending.operationId,{snapshotSequence:pending.snapshotSequence});
    return;
  }
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
        // Service children can keep the APP's crash reporter alive after its
        // main process exits. Stop them while this recovery still owns the lock.
        const stopped=await runBridge('stop',{service:'all'});
        if(stopped.running!==false||stopped.gatewayRunning!==false)
          throw new Error('尚未确认诺拉与酒馆已停止，暂未交接启动器恢复。');
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
    // A busy shared lock does not identify its owner. Keep the original quit
    // protection and never stop services while an independent task may own them.
    const updating=await require('./updater-task').query(noraHome());
    if(updating.busy===true||updating.settled===false
      ||updating.operation&&['selecting','downloading','prepared','applying','verifying','recovering'].includes(updating.status)){
      await dialog.showMessageBox({type:'info',title:'暂未退出',
        message:'后台任务尚未结束或状态待确认，暂不能退出启动器',
        detail:'请等待更新或恢复结束后再退出；状态无法确认时请查看日志。',buttons:['知道了']});
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
    resolveCommit:context=>{
      const fixed=context.target.releasePlan;
      if(fixed?.schema!=='nora-release-plan/1')return fixed?.commit||fixed?.releaseManifest?.commit;
      return releases.coreIdentity(releases.validatePlan(fixed,{launcherVersion:app.getVersion(),channel:CHANNEL,
        operationDirectory:path.join(installerDirectory(),'operations',context.operationId)})).commit;
    },
    bridge:(command,options)=>runBridge(command,options,webContents,payload.runId),
    finalizeLauncher:async(job,verified)=>{
      await launcherUpdate.finalize({...launcherRecoveryOptions(),spawnChild:(command,args,options)=>spawnMaintenance(command,args,options),
        job,version:app.getVersion(),target:verified.version,systemReady:verified.systemReady,updateVerified:verified.updateVerified});
      diagnostics.write('update.launcher-committed',{job,target:verified.version});
    }});
}

function sharedUpdateJob(operationId,requestId){
  const jobs=path.join(installerDirectory(),'update-jobs');
  if(!fs.existsSync(jobs))return null;
  const expected=/^[a-f0-9-]{36}$/.test(requestId||'')?path.join(jobs,requestId):null;
  if(expected&&fs.existsSync(expected)){
    const referenceFile=path.join(expected,'operation-ref.json');
    if(fs.existsSync(referenceFile)){
      const reference=JSON.parse(fs.readFileSync(referenceFile,'utf8'));
      if(reference.operationId!==operationId)throw launcherError('更新任务归属与操作记录不一致，请保留日志。',{code:'UPDATER_JOB_INVALID'});
    }else{
      // The canonical admission can commit before its job pointer. Its fixed
      // request ID may reconnect only the original update submission.
      const submitted=JSON.parse(fs.readFileSync(path.join(expected,'request.json'),'utf8'));
      if(submitted.requestId!==requestId||submitted.request?.kind!=='update')
        throw launcherError('原更新提交记录无法核验，请保留日志。',{code:'UPDATER_JOB_INVALID'});
    }
    return expected;
  }
  for(const id of fs.readdirSync(jobs)){
    if(!/^[a-f0-9-]{36}$/.test(id))continue;
    const job=path.join(jobs,id),reference=path.join(job,'operation-ref.json');
    let record;try{record=JSON.parse(fs.readFileSync(reference,'utf8'));}catch{continue;}
    if(record.operationId===operationId)return job;
  }
  return null;
}

async function runSharedUpdate(event,payload,{recover=false}={}){
  const python=findPython();
  if(!python)throw launcherError('诺拉运行环境不完整，未开始更新。请保留数据。',{code:'RESOURCE_INCOMPLETE'});
  let script=path.join(installRoot(),'apps/tavern-ops/updater/task.py');
  if(payload.operationId&&!fs.existsSync(script)){
    const job=sharedUpdateJob(payload.operationId,payload.requestId);
    if(job)script=path.join(job,'runner/ops/updater/task.py');
  }
  let bootstrap=false;
  if(!fs.existsSync(script)&&payload.sequenceId){
    const sequence=updateSequence.load(noraHome(),desktopSequenceOptions());
    if(sequence?.id!==payload.sequenceId||sequence.requests.core!==payload.operationRequestId)
      throw launcherError('核心更新入口与原两项任务不一致，未开始更新。',{code:'UPDATE_SEQUENCE_INVALID'});
    if(sequence.order[0]==='launcher'){script=updateSequence.bootstrap(noraHome(),sequence);bootstrap=true;}
  }
  if(!fs.existsSync(script)&&!payload.operationId){
    const bundled=path.join(payloadDirectory(),'tavern-updater-bootstrap.py'),manifest=path.join(payloadDirectory(),'release-manifest.json');
    if(fs.existsSync(bundled)&&fs.existsSync(manifest)){
      const expected=JSON.parse(fs.readFileSync(manifest,'utf8')).bootstrap?.sha256;
      if(require('node:crypto').createHash('sha256').update(fs.readFileSync(bundled)).digest('hex')!==expected)
        throw launcherError('包内更新入口校验失败，未修改程序和数据。',{code:'RELEASE_COMPATIBILITY'});
      script=bundled;bootstrap=true;
    }
  }
  if(!fs.existsSync(script))throw launcherError('当前安装尚未包含独立更新入口，请用新版官方更新命令接入；现有数据未改变。',{code:'RESOURCE_INCOMPLETE'});
  const args=['-B','-u',script,'--hermes-home',hermesHome(),'--install-root',installRoot(),...(bootstrap?[]:['--port',String(installationPort())]),
    recover?'--recover':'--apply','--confirm'];
  if(payload.tag)args.push('--tag',payload.tag);
  if(payload.requestId&&!payload.operationId)args.push('--request-id',payload.requestId);
  if(payload.operationRequestId)args.push('--operation-request-id',payload.operationRequestId);
  if(payload.targetManifestSha256)args.push('--target-manifest-sha256',payload.targetManifestSha256);
  if(payload.targetCommit)args.push('--target-commit',payload.targetCommit);
  if(localReleaseDirectory)args.push('--release-dir',localReleaseDirectory,'--allow-candidate');
  if(payload.operationId)args.push('--operation-id',payload.operationId,'--snapshot-sequence',String(payload.snapshotSequence));
  const admitted=await new Promise((resolve,reject)=>{
    // This child only submits. The detached task has its own output handles
    // and real Node interpreter; it is never put in activeProcess.
    const child=spawn(python.command,args,{env:launcherEnv(),windowsHide:true,stdio:['ignore','pipe','pipe']});
    let result,error;
    consumeLines(child.stdout,line=>{try{const item=JSON.parse(line);if(item.event==='result')result=item;}catch{}},reject);
    consumeLines(child.stderr,line=>{try{const item=JSON.parse(line);if(item.event==='error')error=Object.assign(new Error(item.message),{code:item.code});}catch{}},reject);
    child.once('error',reject);child.once('close',code=>result?resolve(result):reject(error||new Error(`更新器未确认接管，退出码 ${code}。`)));
  });
  const submitting=admitted.status==='submitting'&&admitted.settled===false
    &&/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(admitted.requestId||'');
  if(!admitted.operation&&!submitting)throw Object.assign(new Error(admitted.message||'更新器未确认接管，请查看日志。'),{code:admitted.code||'UPDATER_ADMISSION_PENDING'});
  if(submitting)sendBridgeEvent(event.sender,payload.runId,{event:'task',stage_id:'update_admission',task:'更新器仍在准备接管，正在查询同一任务，请勿重复更新'});
  const final=await require('./updater-task').wait(noraHome(),admitted.requestId,{onEvent:current=>{
    if(!current.operation)return;
    const tasks={selecting:'正在确认更新版本',downloading:'正在下载更新',prepared:'更新资源已校验',applying:'正在更新程序，用户数据保留',verifying:'正在核验更新结果',recovering:'正在恢复原程序和数据'};
    sendBridgeEvent(event.sender,payload.runId,{event:'task',stage_id:current.operation.stageId,
      task:tasks[current.operation.state]||'正在读取更新结果'});
  }});
  if(final.settled!==true)throw launcherError('暂时无法确认更新任务是否结束。后台任务和数据已保留，请查询同一任务或查看日志。',
    {code:'UPDATER_STATUS_UNCONFIRMED'});
  if(!final.operation)throw new Error(final.message||'更新任务未返回操作结果，请查看日志。');
  const result=requireOperationResult(final.operation,{recover});
  const state=readInstallerState();
  writeInstallerState({...state,phase:result.systemReady?'ready':'idle',error:'',task:'',resumeTarget:null});
  return result;
}

function desktopSequenceOptions(){
  return {capabilities:releases.LAUNCHER_CAPABILITIES,validatePlan:plan=>releases.validatePlan(plan,
    {launcherVersion:app.getVersion(),platform:process.platform,arch:process.arch,channel:CHANNEL})};
}
function desktopSequenceForOperation(operation){
  const sequence=updateSequence.load(noraHome(),desktopSequenceOptions());
  return sequence&&Object.values(sequence.requests).includes(operation?.requestId)?sequence:null;
}

async function performSystemUpdate(selectedPayload, payload, webContents) {
  if (hermesHome() !== path.join(noraHome(), 'hermes') || installRoot() !== path.join(noraHome(), 'tavern')) {
    throw new Error('完整系统更新仅支持启动器管理的专属安装目录。');
  }
  const target = JSON.parse(fs.readFileSync(path.join(selectedPayload, 'release-manifest.json'))).versions;
  const before = await runBridge('status');
  const comparison = releases.compare(before.version, target.tavern);
  if (comparison !== -1 && !(comparison === 0 && (before.systemReady === false || payload.partialRepair))) {
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
    let result=null,inputFailure,outputFailure;
    let stderr = '', timedOut = false;
    const started=Date.now();
    diagnostics.write('model.helper-start',{site:'model.save',pid:proc.pid});
    const inputError=error=>{inputFailure ||= error;diagnostics.error('model.input-failed',error,{site:'model.save'});};
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
      if (code === 0 && result?.ok===true&&!inputFailure&&!outputFailure) resolve(result);
      else {
        const cause=require('./launcher-errors').programError(result?.diagnostic);
        const failure=inputFailure||outputFailure||cause;
        const error = launcherError(clean(result?.error || stderr || '无法保存模型配置。'),{source:'launcher_process',site:'model.save',exitCode:code,signal,
          code:timedOut ? 'TIMEOUT' : inputFailure?.code || outputFailure?.code || (code===0&&!result?'INVALID_RESPONSE':undefined)},failure);
        const secondary=[{operation:'model-output',error:outputFailure},{operation:'model-helper',error:cause}]
          .filter(item=>item.error&&item.error!==failure);
        if(secondary.length)error.secondaryErrors=secondary;
        error.remoteMessage = 'Model configuration helper failed; see technical exit status.';
        diagnostics.error('model.helper-failed',error,{site:'model.save'});
        reject(error);
      }
    });
    // A child can reject startup before reading its input. Stream errors do not
    // reach ChildProcess's error event; retain them until close drains its logs.
    proc.stdin.on('error',inputError);
    try { proc.stdin.end(JSON.stringify(payload)); }
    catch (error) { inputError(error); }
  });
}

async function finishModelSetup() {
  const saved = readVerifiedModel(noraHome());
  if (!saved) throw new Error('请先配置并验证模型。');
  if (saved.tavernSyncPending) {
    recordEvent({ event: 'milestone', index: 2, state: 'running', task: '模型已验证，正在准备酒馆并同步配置' });
    try {
      const port = installationPort();
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
    // A prepared replacement/recovery has already authorized this exit; its
    // helper cannot restore the APP until the current process closes.
    if (quitReady) return;
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
    let port, serviceMode = 'port';
    const retained=mode==='keep'?require('./retained-installation').inspect(home,{allowPending:true}):null;
    if(retained?.state==='prepared'){port=retained.port;serviceMode='retained';}
    try { if(serviceMode==='port')port = installationPort(); }
    catch (error) {
      if (mode !== 'all' || error.code !== 'VERIFICATION_FAILED') throw error;
      port = null; serviceMode = 'native-root';
      diagnostics.error('uninstall.native-root-handoff', error, { level: 'warning', reason: 'instance-port-unconfirmed' });
    }
    onProgress('正在停止诺拉与酒馆。');
    // Stop only services with this installation's ownership records. An error
    // aborts the uninstall rather than deleting files underneath a live service.
    if (serviceMode === 'port' && findPython()) {
      let stopStarted = false;
      try {
        await runOwnedTask('shutdown',{action:'stop',service:'all'},async context=>{
          await context.stage('applying');
          stopStarted = true;
          const stopped=await runBridge('recovery-stop', { port });
          if(stopped.offline!==true||stopped.running!==false||stopped.gatewayRunning!==false)
            throw launcherError('服务停止状态尚未确认，未开始卸载。',{code:'VERIFICATION_FAILED'});
          return {verification:'confirmed',value:stopped};
        });
      } catch (error) {
        if (mode !== 'all' || stopStarted) throw error;
        port = null; serviceMode = 'native-root';
        diagnostics.error('uninstall.native-root-handoff', error, { level: 'warning', reason: 'shutdown-admission-failed' });
      }
    }
    // Without Python, the handoff worker proves offline ownership under its
    // writer lock before deleting anything; residual records are not proof of
    // a running service and must not require repairing an app just to remove it.
    const appPath = process.platform === 'darwin' ? path.resolve(process.execPath, '../../..') : null;
    const plan = uninstall.makePlan({ home, hermesHome: hermesHome(), installRoot: installRoot(), mode, appPath, executable: process.execPath,
      port, serviceMode });
    if (process.platform === 'darwin' && (!appPath.endsWith('.app') || appPath.startsWith('/Volumes/'))) {
      throw new Error('请先将启动器移入“应用程序”，再执行卸载。');
    }
    if (!planFile) {
      const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'nora-uninstall-'));
      fs.chmodSync(directory, 0o700);
      planFile = path.join(directory, 'nora-uninstall.json');
      plan.parentPid = process.pid;
    }
    plan.diagnostics={enabled:lifecycleReportingEnabled(),launcherVersion:app.getVersion()};
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
    queueLifecycleFailure('startup',error);
    const guidance=formatUserError(error,{action:'startup',logAvailable:Boolean(diagnostics.lastFile)});
    const log=diagnostics.lastFile?`本机日志：${diagnostics.lastFile}`:'本机日志未能保存。';
    try { dialog.showErrorBox('启动器未能打开', `${guidance}\n\n${log}`); }
    catch (dialogError) { diagnostics.error('launcher.startup-dialog-failed', dialogError); }
    app.exit(1);
    return false;
  }
}

const initialized=Boolean(app&&BrowserWindow&&ipcMain&&shell&&initializeLauncher());
const primaryInstance=initialized&&app.requestSingleInstanceLock();
if(initialized&&!primaryInstance)app.quit();
if (primaryInstance) {
  app.on('will-quit',()=>{void lifecycleDiagnostics?.close().catch(()=>{});});
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
      const retained=require('./retained-installation').inspect(noraHome(),{allowPending:true,operationId:operation?.operationId});
      if(retained?.state==='prepared')
        return {...nodeStatus('',operation),...taskCancellation(),launcherRecovery,operation};
      const legacyRecovery=systemUpdate.inspect(noraHome());
      if (!findPython()) {
        const fallback = nodeStatus('', operation);
        if (!fallback.installed || fallback.managedInstallation) return {...fallback,...taskCancellation(),launcherRecovery,operation};
        throw new Error('无法查询已安装的服务状态，启动器未找到可用的 Python。请保留现有安装和数据。');
      }
      const runtime = await runBridge('status', { operation });
      if (runtime.warning && (runtime.warningCode || !/[\u3400-\u9fff]/.test(runtime.warning)))
        runtime.warning = statusErrorMessage(Object.assign(new Error(runtime.warning), {code:runtime.warningCode}));
      else lastStatusError = '';
      if(retained?.cleanupPending){runtime.retainedCompletionPending=true;
        runtime.warning=[runtime.warning,retained.warning].filter(Boolean).join('\n');}
      const installer = (['succeeded','rolled-back'].includes(operation?.state)
        || operation?.state==='failed'&&operation.result?.notAppliedVerification==='confirmed')
        && ['install','update','repair','recover'].includes(operation.kind)
        ? reconcileInstallerState(operation, runtime, { hasRecovery: Boolean(runtime.updateRecovery || legacyRecovery || launcherRecovery) })
        : readInstallerState();
      if (!activeRun && !modelBusy) telemetry?.status({ ...runtime, installer });
      const bundledUpgradeTarget = !LOCAL_TEST && runtime.installed ? releases.bundledUpgradeTarget({
        bundledRoot: payloadDirectory(), currentVersion: runtime.version, launcherVersion: app.getVersion(), channel: CHANNEL,
      }) : null;
      return { ...runtime,...taskCancellation(),operation,updateRecovery:runtime.updateRecovery||legacyRecovery, bundledUpgradeTarget, installer, busy: activeRun || modelBusy, launcherRecovery,
        updateSequence:desktopUpdateNotice?{...desktopUpdateNotice,
          ...(desktopUpdateNotice.operationId?{operation:await operations().snapshot(desktopUpdateNotice.operationId)}:{})}:null,
        ...locationStatus() };
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
    // A fresh call owns source preference. Only a fully read network metadata
    // response for the fixed tag can influence the subsequent asset reads;
    // selection deadlines remain confined to the selector's policy clone.
    const networkPolicy={sourceContext:require('./release-network').createReleaseSourceContext()};
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
      const completion=require('./retained-installation').retryCompletion(noraHome(),context);
      if(completion?.pending){
        diagnostics.write('retained.completion-pending',{operationId:context.operationId,code:completion.code});
        if(['install','update','repair','recover'].includes(payload.action))
          throw launcherError(completion.warning,{code:'RETAINED_COMPLETION_PENDING'});
      }
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
        port: payload.port || installationPort(),
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
      if(payload.sequenceId){
        const sequence=updateSequence.load(noraHome(),desktopSequenceOptions());
        if(sequence?.id!==payload.sequenceId||sequence.requests.launcher!==context.snapshot.requestId)
          throw launcherError('启动器更新与原两项任务不一致，请保留日志。',{code:'UPDATE_SEQUENCE_INVALID'});
        if(!selectedPlan)await fixedTarget(sequence.plan,payload.expectedCoreVersion);
      }
      const isUpdate=['update','repair'].includes(payload.action);
      if(payload.action==='install'&&selectedPlan){
        let continued=await systemUpdateExecutor(payload,event.sender).resumeInstallation(context,
          {hasTransaction:fs.existsSync(path.join(installerDirectory(),'operations',context.operationId,'first-install','transaction.json')),port:payload.port});
        if(continued){continued=finishRetainedInstallation(context,continued);
          writeInstallerState({...readInstallerState(),phase:'ready',error:'',task:'',setupCompleted:continued.setupCompleted===true});
          diagnostics.finish('success');return {verification:'confirmed',value:continued};}
      }
      const managedFacts=require('./operation-policy').inspectManagedInstallation({noraHome:noraHome(),hermesHome:hermesHome(),
        installRoot:installRoot(),port:payload.port||state.port||DEFAULT_PORT,operationId:context.operationId});
      if(payload.action==='install'&&require('./operation-policy').hasManagedRecords({noraHome:noraHome(),hermesHome:hermesHome(),installRoot:installRoot(),operationId:context.operationId}))
        throw launcherError('此目录已有受管安装记录，请使用修复当前安装；现有数据已保留，未下载或覆盖程序。',{code:'MANAGED_INSTALLATION_EXISTS'});
      const managedRepair=isUpdate&&(managedFacts?.needsRepair||selectedPlan?.mode==='install');
      if(managedRepair){payload.partialRepair=true;
        if(selectedPlan&&selectedPlan.mode!=='install')throw launcherError('原固定更新计划未包含缺失程序的完整修复资源，未改变已封存目标。请保留原操作记录。',{code:'RELEASE_COMPATIBILITY'});}
      if (isUpdate) {
        telemetry?.stage('release_check');
        if (LOCAL_TEST) throw new Error('本地候选包不用于在线更新，请使用正式模式包。');
        const current = managedFacts?.needsRepair ? nodeStatus() : await runBridge('status', { port: payload.port }, event.sender, payload.runId);
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
              mode:managedRepair?'install':'update',
              launcherVersion:app.getVersion(),signal:releaseAbort.signal,
              metadataCache:releaseMetadataCache(),networkPolicy});
            await fixedTarget(selectedPlan,current.version);
          }
          if(payload.launcherOnly===true&&releases.compare(current.version,payload.expectedCoreVersion||selectedPlan.version||selectedPlan.releaseManifest?.versions?.tavern)!==0)
            throw launcherError('酒馆版本已变化，请重新检查更新；本次未替换启动器或酒馆。',{code:'CONDITIONS_CHANGED'});
          await context.stage('downloading');
          prepared = await launcherUpdate.prepare({ fetcher: updateFetch, channel: CHANNEL, tag: payload.tag,
            selectedPlan,operationDirectory,networkPolicy,
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
        if(payload.launcherOnly===true){
          const expected=payload.expectedCoreVersion||prepared.manifest.versions.tavern;
          const verified=await runBridge('verify-current-update',{port:payload.port,version:expected},event.sender,payload.runId);
          if(verified.updateVerified!==true||verified.systemReady!==true||releases.compare(verified.version,expected)!==0)
            throw launcherError('启动器替换后的原核心尚未通过核验，程序备份已保留。',{code:'VERIFICATION_FAILED'});
          if(context.snapshot.handoffRef)await launcherUpdate.finalize({...launcherRecoveryOptions(),
            spawnChild:(command,args,options)=>spawnMaintenance(command,args,options),job:context.snapshot.handoffRef,
            version:app.getVersion(),target:prepared.tag,systemReady:true,updateVerified:true});
          writeInstallerState({ ...readInstallerState(), phase: 'ready', error: '', task: '', resumeTarget: null });
          return {verification:'confirmed',value:verified};
        }
        const comparison = releases.compare(current.version, prepared.manifest.versions.tavern);
        if (comparison === null) throw new Error('当前安装版本不明确，未修改现有安装。');
        if (comparison > 0 && current.systemReady === false) {
          throw new Error('当前安装需要修复，但目标版本更旧；未修改现有安装。');
        }
        if (comparison >= 0 && current.systemReady === true && !managedRepair) {
          // A launcher-only handoff still requires the system acceptance before
          // its old APP backup can become terminal.
          if(context.snapshot.handoffRef){
            const verified=await runBridge('verify-current-update',{port:payload.port,version:prepared.manifest.versions.tavern},event.sender,payload.runId);
            if(verified.updateVerified!==true||verified.systemReady!==true||releases.compare(verified.version,prepared.manifest.versions.tavern)!==0)
              throw launcherError('联合更新的原系统尚未通过核验，旧启动器备份已保留。',{code:'VERIFICATION_FAILED'});
            await launcherUpdate.finalize({...launcherRecoveryOptions(),spawnChild:(command,args,options)=>spawnMaintenance(command,args,options),
              job:context.snapshot.handoffRef,version:app.getVersion(),target:prepared.tag,systemReady:verified.systemReady,updateVerified:verified.updateVerified});
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
          selectedPayload = managedRepair ? await releases.prepareInstall({bundledRoot:payloadDirectory(),
            launcherVersion:app.getVersion(),selectedPlan,operationDirectory,fetcher:updateFetch,networkPolicy,
            cacheRoot:path.join(noraHome(),'cache','releases'),signal:releaseAbort.signal,channel:CHANNEL,tag:payload.tag,
            onEvent:message=>sendBridgeEvent(event.sender,payload.runId,message)}) : payload.action === 'install' ? (LOCAL_TEST
            ? await prepareTestPayload(payloadDirectory(), LOCAL_TEST, app.getVersion(),
              message => sendBridgeEvent(event.sender, payload.runId, message))
            : selectedPlan?.schema==='nora-bundled-plan/1'
              ? await releases.prepareBundled({bundledRoot:payloadDirectory(),launcherVersion:app.getVersion(),channel:CHANNEL})
              : await releases.prepareInstall({ bundledRoot: payloadDirectory(), launcherVersion: app.getVersion(),
              tag:payload.tag,
              ...(selectedPlan?.schema==='nora-release-plan/1'?{selectedPlan}:{}),operationDirectory,onPlan:fixedTarget,
              fetcher: updateFetch, networkPolicy, cacheRoot: path.join(noraHome(), 'cache', 'releases'),
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
            fetcher: updateFetch, networkPolicy,
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
        if(payload.action==='install'){
          const retained=require('./retained-installation');
          let saved=retained.inspect(noraHome(),{operationId:context.operationId});
          if(saved?.legacy)saved=await retained.upgradeLegacy(noraHome(),payload.port||state.port||DEFAULT_PORT,context);
          if(saved){await context.effect('changed');retained.claim(noraHome(),context.operationId);}
        }
        await context.stage('prepared');
        await context.effect('changed');
        if (cancelled) throw Object.assign(new Error('安装已取消。'),{name:'AbortError',code:'ABORT_ERR'});
        if (payload.action === 'install') {
          const removed = cleanupInstallTemps(noraHome());
          if (removed.length) sendBridgeEvent(event.sender, payload.runId,
            { event: 'task', task: `已清理 ${removed.length} 个上次安装的临时目录` });
          await ensureHermesFromNode(event.sender, payload.runId, selectedPayload);
        } else if (managedFacts?.missing.python) {
          const journal=path.join(installerDirectory(),'operations',context.operationId,'runtime-bootstrap.json');
          await context.journal(journal);
          await runProcess(process.execPath,[path.join(__dirname,'runtime-worker.js'),selectedPayload,noraHome(),hermesHome(),
            '--repair-managed'],event.sender,payload.runId,{input:JSON.stringify(managedFacts),returnResult:true});
        }
      }
      if (cancelled) throw Object.assign(new Error('安装已取消。'),{name:'AbortError',code:'ABORT_ERR'});
      await context.stage('applying');
      let result = isUpdate
        ? await performSystemUpdate(selectedPayload, payload, event.sender)
        : await runBridge(payload.action === 'recover' ? 'recover-update' : payload.action, { port: payload.port, code: payload.code, tag: payload.tag, service: payload.service,
        ...(payload.action === 'install' ? { releaseDir: selectedPayload } : {}) }, event.sender, payload.runId);
      const finalState = readInstallerState();
      await context.stage('verifying');
      const targetVersion=selectedPayload?JSON.parse(fs.readFileSync(path.join(selectedPayload,'release-manifest.json'),'utf8')).versions?.tavern:undefined;
      if(!verifyWorkflowResult({action:payload.action,service:payload.service,targetVersion,result}))
        throw launcherError('后台返回的实际状态尚未满足本次操作要求，请重新检查状态。',{code:'VERIFICATION_FAILED'});
      if(payload.action==='install')result=finishRetainedInstallation(context,result);
      else if(completion?.pending)result={...result,retainedCompletionPending:true,
        warning:[result.warning,completion.warning].filter(Boolean).join('\n')};
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
  const runDesktopUpdate=async(event,payload,{retry=false}={})=>{
    const options=desktopSequenceOptions();
    let sequence=updateSequence.load(noraHome(),options);
    if(!sequence){
      const before=await runBridge('status');
      if(before.systemReady!==true)throw launcherError('请先确认当前核心安装可用，再更新两项程序。',{code:'UPDATE_RECOVERY_REQUIRED'});
      await registerCapabilities();
      await require('./launcher-capability').validate({receiptPath:path.join(installerDirectory(),'launcher-control.json'),
        noraHome:noraHome(),currentExecutable:process.execPath});
      const plan=await releases.selectPlan({fetcher:updateFetch,tag:payload.tag,launcherVersion:app.getVersion(),
        channel:CHANNEL,metadataCache:releaseMetadataCache()});
      const installedManifest=path.join(installRoot(),'tavern-updates','installed-manifest.json');
      const stat=fs.lstatSync(installedManifest);
      if(!stat.isFile()||stat.isSymbolicLink()||stat.size>8*1024*1024)
        throw launcherError('当前核心清单无法核验，未开始两项更新。',{code:'UPDATE_SEQUENCE_UNCONFIRMED'});
      const bytes=fs.readFileSync(installedManifest),installed=JSON.parse(bytes);
      if(installed.versions?.tavern!==before.version||installed.commit!==before.commit)
        throw launcherError('当前核心版本与实际清单不一致，未开始两项更新。',{code:'UPDATE_SEQUENCE_UNCONFIRMED'});
      sequence=updateSequence.create(noraHome(),{plan,before:{core:before.version,launcher:app.getVersion(),
        coreCommit:installed.commit,coreManifestSha256:require('node:crypto').createHash('sha256').update(bytes).digest('hex')},...options});
    }else if(payload.tag&&payload.tag!==sequence.plan.tag){
      throw launcherError('原来的两项更新尚未结束，请先继续原目标。',{code:'UPDATE_SEQUENCE_PENDING'});
    }
    const safe=operation=>operation&&!operation.busy&&operation.state!=='awaiting-handoff'
      &&['untouched','restored'].includes(operation.effectState)
      &&!['recovery-required','files-restored-start-failed'].includes(operation.recoveryOutcome);
    const observe=async step=>{
      const record=updateSequence.operation(noraHome(),sequence.requests[step]);
      if(!record){
        if(step!=='core'||!fs.existsSync(path.join(installerDirectory(),'update-jobs',sequence.requests.core)))return null;
        const pending=await require('./updater-task').query(noraHome(),sequence.requests.core);
        return {settled:pending.settled===true,safe:pending.settled===true&&['error','interrupted'].includes(pending.status),
          failed:['error','interrupted'].includes(pending.status),error:launcherError(pending.message||'更新器接管尚未完成。',
            {code:pending.code||'UPDATER_ADMISSION_PENDING'})};
      }
      const current=step==='core'?await require('./updater-task').query(noraHome(),sequence.requests.core)
        :{operation:await operations().snapshot(record.operationId)};
      const operation=current.operation;
      if(!operation)throw launcherError('原更新任务暂时无法核验，请保留记录。',{code:'UPDATE_SEQUENCE_UNCONFIRMED'});
      const settled=step==='core'?current.settled===true:operation.busy===false;
      return {operation,settled,safe:settled&&safe(operation),
        succeeded:settled&&operation.state==='succeeded'&&operation.verification==='confirmed',
        failed:settled&&['failed','rolled-back','blocked','cancelled','interrupted'].includes(operation.state),
        error:Object.assign(new Error(operation.currentFailure?.message||operation.primaryFailure?.message||'更新未完成，请查看日志。'),
          {operation,code:operation.currentFailure?.code||operation.primaryFailure?.code||'UPDATE_SEQUENCE_FAILED'})};
    };
    const verifyCombination=async()=>{
      await registerCapabilities();
      await require('./launcher-capability').validate({receiptPath:path.join(installerDirectory(),'launcher-control.json'),
        noraHome:noraHome(),currentExecutable:process.execPath});
      const current=await runBridge('status');
      if(current.systemReady!==true)return {compatible:false,current};
      const hash=bytes=>require('node:crypto').createHash('sha256').update(bytes).digest('hex');
      const file=path.join(installRoot(),'tavern-updates','installed-manifest.json'),stat=fs.lstatSync(file);
      if(!stat.isFile()||stat.isSymbolicLink()||stat.size>4*1024*1024)return {compatible:false,current};
      const installedDigest=hash(fs.readFileSync(file));
      // Updates serialize the authenticated manifest with indent=2 and a final
      // newline. Keep that installed-byte identity separate from download SHA.
      const identities=[{version:sequence.before.core,commit:sequence.before.coreCommit,
        manifestSha256:sequence.before.coreManifestSha256},
        {...releases.coreIdentity(sequence.plan),
          ...(!releases.coreReference(sequence.plan.releaseManifest,process.platform,process.arch)
            ?{manifestSha256:hash(JSON.stringify(sequence.plan.releaseManifest,null,2)+'\n')}:{})}];
      const expected=identities.find(item=>item.version===current.version&&item.commit===current.commit
        &&item.manifestSha256===installedDigest);
      if(!expected)return {compatible:false,current};
      const verified=await runBridge('inspect-current-update',expected);
      return {current,compatible:verified.updateVerified===true&&verified.systemReady===true
        &&updateSequence.compatible(sequence.plan.releaseManifest,current.version,app.getVersion(),options.capabilities)};
    };
    let result;
    try{
      if(sequence.order[0]==='launcher'&&!fs.existsSync(path.join(installRoot(),'apps/tavern-ops/updater/task.py')))
        await updateSequence.prepareBootstrap(noraHome(),sequence,{fetcher:updateFetch,
          networkPolicy:{sourceContext:require('./release-network').createReleaseSourceContext()},
          onEvent:message=>sendBridgeEvent(event.sender,payload.runId,message)});
      result=await updateSequence.run(sequence,{
      observe,
      verifyCombination,
      verifyStep:async(step,_sequence,current)=>{
        const fixed=current.operation.target?.releasePlan;
        const digest=require('node:crypto').createHash('sha256').update(sequence.plan.releaseManifestText).digest('hex');
        if(fixed?.tag!==sequence.plan.tag||fixed.commit!==sequence.plan.commit||fixed.manifestSha256!==digest)
          throw launcherError('更新步骤与原固定发布不一致，请保留数据和记录。',{code:'UPDATE_SEQUENCE_INVALID'});
        const actual=await verifyCombination();
        const expected=step==='core'?sequence.plan.releaseManifest.versions.tavern:sequence.plan.launcherManifest.version;
        if(actual.compatible!==true||releases.compare(step==='core'?actual.current.version:app.getVersion(),expected)!==0)
          throw launcherError('更新步骤的实际程序组合尚未通过核验，请保留数据。',{code:'UPDATE_RECOVERY_REQUIRED'});
      },
      execute:async(step,_sequence,current)=>{
        if(step==='core'){
          return runSharedUpdate(event,{action:'update',tag:sequence.plan.tag,sequenceId:sequence.id,
            ...(!current?.failed?{requestId:sequence.requests.core}:{}),operationRequestId:sequence.requests.core,
            targetCommit:sequence.plan.commit,
            targetManifestSha256:require('node:crypto').createHash('sha256').update(sequence.plan.releaseManifestText).digest('hex'),
            ...(current?.failed&&current.operation?{operationId:current.operation.operationId,snapshotSequence:current.operation.snapshotSequence||current.operation.sequence}:{}),
            runId:payload.runId||sequence.requests.core});
        }
        const core=await observe('core');
        const request={action:'update',tag:sequence.plan.tag,launcherOnly:true,sequenceId:sequence.id,
          expectedCoreVersion:core?.succeeded?sequence.plan.releaseManifest.versions.tavern:sequence.before.core};
        const operation=current
          ?await operations().resume(current.operation.operationId,{snapshotSequence:current.operation.snapshotSequence,
            event,runId:sequence.requests.launcher,onFailure:rememberOperationFailure})
          :await operations().start('update',{target:{request},execute:context=>executeAction(context,{payload:request,event}),
            onFailure:rememberOperationFailure},sequence.requests.launcher);
        finishOperationTelemetry(operation);
        if(operation.state==='awaiting-handoff'){
          try{await launcherUpdate.launchHandoff({...launcherRecoveryOptions(),job:operation.handoffRef,
            managedPythonRoot:path.join(hermesHome(),'python'),venvHome:path.join(hermesHome(),'hermes-agent','venv'),env:process.env});}
          catch(error){const failed=await operations().failHandoff(operation.operationId,{job:operation.handoffRef,error,onFailure:rememberOperationFailure});
            finishOperationTelemetry(failed);return requireOperationResult(failed);}
          quitReady=true;setImmediate(()=>app.quit());return {restarting:true};
        }
        return requireOperationResult(operation);
      },
    },{retry});}
    catch(error){
      const anchor=error.operation||updateSequence.operation(noraHome(),sequence.requests.launcher)||updateSequence.operation(noraHome(),sequence.requests.core);
      const first=await observe(sequence.order[0]);
      desktopUpdateNotice={status:'blocked',message:error.message,releaseTag:sequence.plan.tag,canRetry:first===null||first?.settled===true&&first?.safe===true,
        ...(anchor?{operationId:anchor.operationId,snapshotSequence:anchor.snapshotSequence||anchor.sequence}:{})};
      throw error;
    }
    if(result.restarting)return result;
    if(result.status==='partial'){
      const anchor=result.operation||updateSequence.operation(noraHome(),sequence.requests[result.completed.at(-1)]);
      desktopUpdateNotice={status:'partial',message:result.message,failed:result.failed,releaseTag:sequence.plan.tag,
        coreVersion:result.current.version,launcherVersion:app.getVersion(),
        operationId:anchor.operationId,snapshotSequence:anchor.snapshotSequence||anchor.sequence};
      throw Object.assign(new Error(result.message),{code:'UPDATE_PARTIALLY_COMPLETED',operation:anchor});
    }
    updateSequence.clear(noraHome(),sequence);desktopUpdateNotice=null;
    return {...result.current,updateComplete:true,updateSequence:null};
  };
  continueDesktopUpdate=async(event)=>{
    activeRun=true;
    try{if(!updateSequence.load(noraHome(),desktopSequenceOptions()))return;
      return await runDesktopUpdate(event,{},{});}
    catch(error){desktopUpdateNotice||={status:'blocked',message:error.message};throw error;}
    finally{activeRun=false;activeOperationContext=null;}
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
      const selected=await operations().snapshot(payload.operationId);
      if(desktopSequenceForOperation(selected)){
        if(selected.snapshotSequence!==payload.snapshotSequence)throw launcherError('任务记录已变化，请重新查询。',{code:'OPERATION_SNAPSHOT_CHANGED'});
        if(mode==='resume')return await runDesktopUpdate(event,{}, {retry:true});
      }
      if(sharedUpdateJob(payload.operationId,selected?.requestId)){
        if(selected.snapshotSequence!==payload.snapshotSequence)throw launcherError('任务记录已变化，请重新查询。',{code:'OPERATION_SNAPSHOT_CHANGED'});
        return await runSharedUpdate(event,{...selected.target.request,...payload,requestId:selected.requestId,action:'update'},{recover:mode==='recover'});
      }
      const operation=await operations()[mode](payload.operationId,{...options,event});
      finishOperationTelemetry(operation,{recover:mode==='recover'});
      if(['succeeded','rolled-back'].includes(operation.state))await registerCapabilities();
      return requireOperationResult(operation,{recover:mode==='recover'});
    }finally{activeRun=false;activeOperationContext=null;}
  });
  handle('nora:operation-recheck',async(_event,payload)=>{
    if(activeRun||modelBusy)throw launcherError('正在处理任务，请等待完成。',{code:'OPERATION_BUSY'});
    const options=operationRequest(payload);
    activeRun=true;
    try{
      if(statusRequest)await statusRequest;
      return {operation:await operations().recheck(payload.operationId,options)};
    }finally{activeRun=false;activeOperationContext=null;}
  });

  const runAction = async (event,payload) => {
    if (modelBusy || activeRun) throw new Error('Nora 正在处理任务，请稍候。');
    if (!['install', 'start', 'stop', 'restart', 'pair', 'update', 'repair', 'recover'].includes(payload?.action)) throw new Error('不支持的操作。');
    if (payload.port !== undefined && (!Number.isInteger(payload.port) || payload.port < 1024 || payload.port > 65535)) throw new Error('端口无效。');
    if (typeof payload.runId !== 'string' || !/^[\w-]{1,100}$/.test(payload.runId)) throw new Error('任务编号无效。');
    if(payload.launcherOnly!==undefined&&(typeof payload.launcherOnly!=='boolean'||payload.action!=='update'))throw new Error('启动器更新请求无效。');
    if(payload.includeLauncher!==undefined&&(typeof payload.includeLauncher!=='boolean'||payload.action!=='update'))throw new Error('两项更新请求无效。');
    if (payload.tag !== undefined && !/^[a-zA-Z0-9._-]{1,100}$/.test(payload.tag)) throw new Error('版本编号无效。');
    if (payload.service !== undefined && (!['all', 'nora', 'tavern'].includes(payload.service)
      || !['start', 'stop', 'restart'].includes(payload.action))) throw new Error('服务目标无效。');
    activeRun=true;cancelled=false;
    try {
      // Startup handoffs resume directly; a later request has its own owner.
      if(payload.action==='update'&&payload.includeLauncher===true)return await runDesktopUpdate(event,payload);
      if(payload.action==='update'&&payload.launcherOnly!==true)return await runSharedUpdate(event,payload);
      const request={action:payload.action};
      for(const name of ['port','tag','service','launcherOnly'])if(payload[name]!==undefined)request[name]=payload[name];
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
        const result = await trackLauncher('check_update','release_check', () => releases.check({ fetcher: updateFetch, installRoot: installRoot(), client:'updater',updaterCapabilities:releases.UPDATER_CAPABILITIES, channel: CHANNEL }));
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
        if(!SELF_UPDATE_JOB&&app.isPackaged){
          activeRun=true;
          try{await reconcileRestoredHandoff();}
          catch(error){diagnostics.error('update.restored-handoff-unconfirmed',error);}
          finally{activeRun=false;activeOperationContext=null;}
        }
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
                await continueDesktopUpdate?.({sender:window.webContents});
              }
            } catch (error) {
              activeRun = false; diagnostics.error('update.resume', error);
              if (plan?.skillId) finishHandoff(noraHome(), plan.skillId, null, diagnostics.clean(error.message));
            }finally{SELF_UPDATE_JOB=null;activeRun=false;activeOperationContext=null;}
          });
        }else{
          const window=BrowserWindow.getAllWindows()[0];
          window.webContents.once('did-finish-load',()=>continueDesktopUpdate?.({sender:window.webContents})
            .catch(error=>diagnostics.error('update.sequence-resume',error)));
        }
        return;
      }
      try {
        const destination = path.resolve(SYSTEM_UNINSTALL);
        if (process.platform !== 'win32' || path.basename(destination) !== 'nora-uninstall.json'
          || !destination.startsWith(path.resolve(os.tmpdir()) + path.sep)) throw new Error('系统卸载请求无效。');
        if (!await confirmUninstall(destination)) app.exit(1);
      } catch (error) { diagnostics.error('uninstall.handoff-failed',error);queueLifecycleFailure('uninstall',error);
        dialog.showErrorBox('卸载未完成', error.message); app.exit(1); }
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
