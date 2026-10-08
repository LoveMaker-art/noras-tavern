const { contextBridge, ipcRenderer } = require('electron');
let sequence = 0;

async function invoke(channel, ...args) {
  const result = await ipcRenderer.invoke(channel, ...args);
  if (result?.schema !== "nora-launcher-result/1") return result;
  if (result.ok === true) return result.value;
  const payload = result.error || {};
  const guidance = payload.guidance || {};
  const error = new Error([guidance.title, guidance.detail, guidance.next].filter(Boolean).join("\n"));
  for (const key of ["failureCode", "userCode", "technical", "guidance", "allowedActions", "operation", "logOperationId"]) error[key] = payload[key];
  throw error;
}

function requestWithEvents(ipcChannel,payload,options = {}) {
  const runId = `${Date.now()}-${++sequence}`;
  const channel = `nora:bridge-event:${runId}`;
  const listener = (_event, message) => {
    if (typeof options.onEvent === 'function') {
      options.onEvent(message);
    }
    if (message.event === 'step' && typeof options.onStep === 'function') {
      options.onStep(message.index, message.label);
    }
    if (message.event === 'log' && typeof options.onLog === 'function') {
      options.onLog(message.line);
    }
    if (message.event === 'command' && typeof options.onLog === 'function') {
      options.onLog(`执行：${message.command.join(' ')}`);
    }
  };
  ipcRenderer.on(channel, listener);
  return invoke(ipcChannel, {...payload,runId})
    .finally(() => ipcRenderer.removeListener(channel, listener));
}
function runAction(action,options={}){
  return requestWithEvents('nora:run',{action,port:options.port,code:options.code,tag:options.tag,service:options.service},options);
}
function operationAction(channel,payload={}){
  return requestWithEvents(channel,{operationId:payload.operationId,snapshotSequence:payload.snapshotSequence},payload);
}

if (contextBridge && ipcRenderer) {
  contextBridge.exposeInMainWorld('NoraLauncherBridge', {
    status() {
      return invoke('nora:status');
    },
    telemetry(value) { return invoke('nora:telemetry', value); },
    install(options) {
      return runAction('install', options);
    },
    start(options) {
      return runAction('start', options);
    },
    stop(options) { return runAction('stop', options); },
    restart(options) { return runAction('restart', options); },
    pair(options) { return runAction('pair', options); },
    openInstallDirectory() { return invoke('nora:open-directory'); },
    chooseInstallDirectory() { return invoke('nora:choose-directory'); },
    checkUpdate() { return invoke('nora:check-update'); },
    update(options) {
      return runAction('update', options);
    },
    repair(options) {
      return runAction('repair', options);
    },
    recover(options) { return runAction('recover', options); },
    operationSnapshot(operationId) { return invoke('nora:operation-snapshot', {operationId}); },
    operationLogs(operationId, cursor) { return invoke('nora:operation-logs', {operationId, cursor}); },
    resumeOperation(payload) { return operationAction('nora:operation-resume', payload); },
    recoverOperation(payload) { return operationAction('nora:operation-recover', payload); },
    recheckOperation(payload) { return invoke('nora:operation-recheck', payload); },
    recoverLauncher() { return invoke('nora:recover-launcher'); },
    cancel() {
      return invoke('nora:cancel');
    },
    modelProviders() {
      return invoke('nora:model-providers');
    },
    modelOptions(payload) {
      return invoke('nora:model-options', payload);
    },
    saveAndTestModel(payload) {
      return invoke('nora:model-save-test', payload);
    },
    resumeModelSetup() { return invoke('nora:model-resume'); },
    openClawChat() {
      return invoke('nora:open-clawchat');
    },
    openClawChatApp() {
      return invoke('nora:open-clawchat-app');
    },
    openLogs() {
      return invoke('nora:open-logs');
    },
    openSettings() {
      return invoke('nora:open-settings');
    },
    uninstall(options = {}) {
      const listener = (_event, task) => options.onProgress?.(task);
      ipcRenderer.on('nora:uninstall-progress', listener);
      return invoke('nora:uninstall').finally(() => ipcRenderer.removeListener('nora:uninstall-progress', listener));
    },
    openExternal(url) {
      return invoke('nora:open-external', url);
    },
  });
}
