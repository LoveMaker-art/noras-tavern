const { contextBridge, ipcRenderer } = require('electron');
let sequence = 0;

function runAction(action, options = {}) {
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
  return ipcRenderer.invoke('nora:run', { action, runId, port: options.port, code: options.code, tag: options.tag })
    .finally(() => ipcRenderer.removeListener(channel, listener));
}

if (contextBridge && ipcRenderer) {
  contextBridge.exposeInMainWorld('NoraLauncherBridge', {
    status() {
      return ipcRenderer.invoke('nora:status');
    },
    install(options) {
      return runAction('install', options);
    },
    start(options) {
      return runAction('start', options);
    },
    stop(options) { return runAction('stop', options); },
    restart(options) { return runAction('restart', options); },
    pair(options) { return runAction('pair', options); },
    openInstallDirectory() { return ipcRenderer.invoke('nora:open-directory'); },
    checkUpdate() { return ipcRenderer.invoke('nora:check-update'); },
    update(options) {
      return runAction('update', options);
    },
    repair(options) {
      return runAction('repair', options);
    },
    cancel() {
      return ipcRenderer.invoke('nora:cancel');
    },
    modelProviders() {
      return ipcRenderer.invoke('nora:model-providers');
    },
    modelOptions(payload) {
      return ipcRenderer.invoke('nora:model-options', payload);
    },
    saveAndTestModel(payload) {
      return ipcRenderer.invoke('nora:model-save-test', payload);
    },
    openClawChat() {
      return ipcRenderer.invoke('nora:open-clawchat');
    },
    openLogs() {
      return ipcRenderer.invoke('nora:open-logs');
    },
    openSettings() {
      return ipcRenderer.invoke('nora:open-settings');
    },
    openExternal(url) {
      return ipcRenderer.invoke('nora:open-external', url);
    },
  });
}
