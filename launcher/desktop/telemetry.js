const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { AsyncLocalStorage } = require('node:async_hooks');
const contract = require('./telemetry-contract.json');
const { describeError } = require('./launcher-errors');
const { createFaultPackets, validFaultPacket } = require('./fault-packet');
const EMPTY_DETAILS = {error_source:'',error_site:'',system_code:'',http_status:null,exit_code:null,exit_signal:'',error_kind:'',attempt:0};
const DAY = 86400000;
const ENDPOINT = 'https://noratavern.com/api/launcher/events';
const VERSION = /^(?:unknown|\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]{1,40})?)$/;
const version = value => {
  const normalized = typeof value === 'string' ? value.replace(/^v/, '') : '';
  return VERSION.test(normalized) ? normalized : 'unknown';
};

function errorCode(error) {
  return describeError(error).error_code;
}

function createTelemetry({ file, launcherVersion, platform = process.platform, arch = process.arch,
  enabled = true, diagnosticDefault = false, cohort = 'unknown', fetcher = globalThis.fetch, now = Date.now, random = Math.random,
  diagnostic = () => {}, automatic = true, clean, roots, environment }) {
  let state, broken = false, controller, sending = false, attempts = 0, due = 0, timer;
  let productVersion = 'unknown', progressValue = null, generation = 0;
  const operations = new AsyncLocalStorage(), reported = new WeakMap(), diagnosticTasks = new WeakMap();
  const faults = createFaultPackets({clean,roots,environment});
  const report = code => { try { diagnostic(code); } catch {} };
  try {
    if (fs.existsSync(file)) {
      if (fs.statSync(file).size > 2 * 1024 * 1024) throw Error('oversized');
      state = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (state.schema !== 1 || typeof state.enabled !== 'boolean' || !Array.isArray(state.queue) || !Number.isSafeInteger(state.sequence)
        || !/^[a-f0-9-]{36}$/.test(state.id) || !contract.cohorts.includes(state.cohort)) throw Error('invalid');
      // Never transmit arbitrary fields from a locally modified queue file.
      state.queue = state.queue.slice(-500).map(event => Object.fromEntries(contract.fields
        .filter(key => (event.schema_version >= 2 || !contract.detailFields.includes(key)) && (event.schema_version >= 3 || key !== 'fault')).map(key => [key, event[key]])));
      if (state.active && (!/^[a-f0-9-]{36}$/.test(state.active.id)
        || !contract.actions.includes(state.active.action) || !contract.stages.includes(state.active.stage)
        || !Number.isSafeInteger(state.active.started) || !Number.isSafeInteger(state.active.stageStarted)
        || !(state.active.lastProgress === null || Number.isSafeInteger(state.active.lastProgress)))) throw Error('invalid active task');
      for (const event of state.queue) {
        if (![1,2,3].includes(event.schema_version)) throw Error('invalid schema');
        if (event.schema_version >= 2) {
          for (const [key,list] of Object.entries({error_source:'sources',error_site:'sites',system_code:'systemCodes',exit_signal:'signals',error_kind:'kinds'})) {
            if (event[key] !== '' && !contract[list].includes(event[key])) throw Error('invalid detail');
          }
          if (!(event.http_status === null || Number.isInteger(event.http_status) && event.http_status >= 400 && event.http_status <= 599)
            || !(event.exit_code === null || Number.isInteger(event.exit_code) && event.exit_code >= 0 && event.exit_code <= 65535)
            || !Number.isInteger(event.attempt) || event.attempt < 0 || event.attempt > 10) throw Error('invalid detail');
        }
        if (event.schema_version === 3 && event.fault !== null && (!validFaultPacket(event.fault) || Buffer.byteLength(JSON.stringify(event.fault)) > contract.faultLimits.packetBytes)) throw Error('invalid packet');
        if (Object.entries(event).filter(([key]) => key !== 'fault').map(([,value]) => value).some(value => value !== null && !['string','number'].includes(typeof value))) throw Error('invalid event');
        for (const [key, list] of Object.entries({event:'events',action:'actions',stage:'stages',status:'statuses',error_code:'errors',cohort:'cohorts',platform:'platforms',arch:'arches'})) {
          if (!contract[list].includes(event[key])) throw Error('invalid enum');
        }
        if (!VERSION.test(event.launcher_version) || !VERSION.test(event.product_version)
          || !/^[a-f0-9-]{36}$/.test(event.event_id) || event.installation_id !== state.id
          || !/^(?:[a-f0-9-]{36})?$/.test(event.operation_id)) throw Error('invalid identity');
        for (const key of ['sequence','occurred_at','elapsed_ms','stage_elapsed_ms']) if (!Number.isSafeInteger(event[key])) throw Error('invalid number');
        if (event.progress_age_ms !== null && !Number.isSafeInteger(event.progress_age_ms)) throw Error('invalid progress');
      }
    } else state = { schema: 1, id: randomUUID(), cohort, enabled: false, consentVersion: 0, sequence: 0, seen: false, ready: false, active: null, queue: [] };
  } catch { broken = true; state = { enabled: false, queue: [] }; report('state_unreadable'); }
  // Apply the desktop's default only when no current diagnostic choice exists.
  // Preserve explicit v3 opt-out and never promote queued legacy evidence.
  if (state.consentVersion !== 3) {
    state.queue = state.queue.map(event => event.schema_version === 3 ? {...event, fault:null} : event);
    state.enabled = Boolean(enabled && diagnosticDefault && !broken);
    state.consentVersion = 3;
  }
  // Persist the consent instance so a self-update handoff cannot gain a later authorization.
  if (!state.enabled) state.diagnosticConsentId = '';
  else if (!/^[a-f0-9-]{36}$/.test(state.diagnosticConsentId || '')) state.diagnosticConsentId = randomUUID();
  const stripFaults = () => { state.queue = state.queue.map(event => event.schema_version === 3 ? {...event,fault:null} : event); };
  if (!state.enabled) stripFaults();
  function save() {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const temporary = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(state), { mode: 0o600 });
    fs.renameSync(temporary, file);
  }
  // Basic operation statistics are independent of detailed diagnostic consent.
  const allowed = () => enabled && !broken && now() >= (state.pauseUntil || 0);
  const detailedAllowed = () => allowed() && state.enabled && state.consentVersion === 3;
  const protect = fn => (...args) => {
    try { return fn(...args); } catch { broken = true; controller?.abort(); report('state_write_failed'); }
  };
  const currentScope = () => operations.getStore()?.admitted !== false;
  const admitDiagnostics = task => diagnosticTasks.set(task,{enabled:detailedAllowed(),generation});
  function faultFor(error, task, context) {
    const consent = diagnosticTasks.get(task);
    return detailedAllowed() && consent?.enabled && consent.generation === generation ? faults.packet(error,task,context) : null;
  }
  const elapsed = start => Math.max(0, Math.min(30 * DAY, now() - start));
  function enqueue(event, status = 'running', code = 'none', stageOverride, details = EMPTY_DETAILS, taskOverride, fault = null) {
    if (!allowed()) return;
    const task = taskOverride || state.active;
    const global = ['launcher_first_seen', 'runtime_first_ready', 'setup_waiting'].includes(event);
    const record = {
      schema_version: 3, fault: detailedAllowed() ? fault : null, event_id: randomUUID(), installation_id: state.id, operation_id: global ? '' : task.id,
      sequence: ++state.sequence, event, occurred_at: now(), platform, arch,
      launcher_version: version(launcherVersion), product_version: productVersion, cohort: state.cohort,
      action: global ? 'none' : task.action, stage: stageOverride || (global ? 'idle' : task.stage), status, error_code: code,
      elapsed_ms: global ? 0 : elapsed(task.started), stage_elapsed_ms: global ? 0 : Math.min(elapsed(task.stageStarted), elapsed(task.started)),
      progress_age_ms: global || task.lastProgress === null ? null : Math.min(elapsed(task.lastProgress), elapsed(task.stageStarted)),
      ...details,
    };
    state.queue = state.queue.filter(e => e.occurred_at >= now() - 7 * DAY);
    // Prefer dropping old heartbeats over terminal/error evidence when the queue is full.
    while (state.queue.length >= 500) {
      const i = state.queue.findIndex(e => e.event === 'heartbeat'); state.queue.splice(i < 0 ? 0 : i, 1);
    }
    state.queue.push(record);
    if (task && !global && !['heartbeat','launcher_error'].includes(event)) {
      task.history = [...(task.history || []), {event,stage:record.stage,status,elapsed_ms:record.elapsed_ms}].slice(-16);
    }
    while (Buffer.byteLength(JSON.stringify(state.queue)) > 1024 * 1024) {
      const i = state.queue.findIndex(e => e.event === 'heartbeat'); state.queue.splice(i < 0 ? 0 : i, 1);
    }
  }
  function stage(id) {
    if (!allowed() || !currentScope() || !state.active || !contract.stages.includes(id) || state.active.stage === id) return;
    enqueue('stage_finished', 'succeeded');
    Object.assign(state.active, { stage: id, stageStarted: now(), lastProgress: null }); progressValue = null;
    enqueue('stage_started'); save();
  }
  function finish(status, error) {
    if (!allowed() || !currentScope() || !state.active) return;
    if (status === 'failed' && errorCode(error) === 'cancelled') status = 'cancelled';
    const details = status === 'failed' ? describeError(error) : EMPTY_DETAILS;
    const code = status === 'failed' ? details.error_code : 'none';
    enqueue('stage_finished', status, code, undefined, details); enqueue('operation_finished', status, code, undefined, details, undefined, status === 'failed' ? faultFor(error,state.active) : null);
    if (status === 'handoff') state.active.handoff = true;
    else state.active = null;
    save();
  }
  const api = {
    // Explicit launcher callers only. observe() intentionally ignores logs/error text
    // from Tavern, Hermes, plugins and model output.
    report: protect((error, context = {}) => {
      if (!allowed()) return;
      const scoped = operations.getStore();
      if (scoped?.admitted === false) return;
      const task = scoped?.task || state.active || {id:randomUUID(),action:'launcher',stage:'idle',started:now(),stageStarted:now(),lastProgress:null};
      if (!scoped?.task && !state.active) admitDiagnostics(task);
      const details = describeError(error, context);
      if (error && typeof error === 'object') {
        const key = `${scoped?.task?.id || state.active?.id || 'standalone'}:${details.attempt}`;
        if (reported.get(error) === key) return;
        reported.set(error,key);
      }
      enqueue('launcher_error','failed',details.error_code,undefined,details,task,faultFor(error,task,context)); save();
    }),
    scope(work) { return operations.run({task:state.active,admitted:allowed()},work); },
    async track(action, stageId, work) {
      // Short independent UI requests must not replace an ongoing install task.
      const task = {id:randomUUID(),action,stage:stageId,started:now(),stageStarted:now(),lastProgress:null};
      if (!contract.actions.includes(action) || !contract.stages.includes(stageId)) return work();
      const admitted = allowed(); admitDiagnostics(task);
      const emit = protect((status, error) => {
        if (!admitted || !allowed()) return;
        const details = error ? describeError(error) : EMPTY_DETAILS;
        enqueue(status === 'running' ? 'operation_started' : 'operation_finished', status,
          error ? details.error_code : 'none', undefined, details, task, error ? faultFor(error,task) : null); save();
      });
      emit('running');
      try { const result = await operations.run({task,admitted},work);
        const error = result?.diagnosticError, cancelled = error && errorCode(error) === 'cancelled';
        emit(cancelled ? 'cancelled' : error ? 'failed' : 'succeeded',cancelled ? undefined : error); return result; }
      catch (error) { const cancelled = errorCode(error) === 'cancelled'; emit(cancelled ? 'cancelled' : 'failed',cancelled ? undefined : error); throw error; }
    },
    settings: () => ({ enabled: enabled && state.enabled && state.consentVersion === 3 && !broken, available: enabled && !broken, installationId: state.id || '' }),
    setEnabled: protect(value => {
      if (typeof value !== 'boolean' || broken || !enabled) return api.settings();
      if (state.enabled === value && state.consentVersion === 3) return api.settings();
      generation++; controller?.abort(); state.enabled = value; state.consentVersion = 3;
      state.diagnosticConsentId = value ? randomUUID() : '';
      if (!value) stripFaults();
      // Preserve basic statistics and task ownership; old tasks cannot gain consent.
      save(); return api.settings();
    }),
    begin: protect(action => {
      if (!allowed() || !contract.actions.includes(action) || action === 'none') return;
      state.waiting = null;
      if (state.active?.handoff && action === 'update') {
        state.active.handoff = false;
        if (state.active.diagnosticConsentId && state.active.diagnosticConsentId === state.diagnosticConsentId) admitDiagnostics(state.active);
        stage('prepare'); save(); return state.active.id;
      }
      if (state.active) finish('interrupted');
      state.active = { id: randomUUID(), action, started: now(), stage: 'prepare', stageStarted: now(), lastProgress: null,
        diagnosticConsentId: detailedAllowed() ? state.diagnosticConsentId : '' };
      admitDiagnostics(state.active);
      enqueue('operation_started'); enqueue('stage_started'); save();
      return state.active.id;
    }),
    stage: protect(stage),
    observe: protect(message => {
      if (!allowed() || !currentScope() || !state.active) return;
      if (message.stage_id) stage(message.stage_id);
      if (message.event === 'progress' && Number.isFinite(message.current) && message.current >= 0 && message.current !== progressValue) {
        progressValue = message.current; state.active.lastProgress = now();
      }
    }),
    finish: protect(finish),
    status: protect(result => {
      productVersion = version(result?.version);
      if (!allowed()) return;
      if (result.systemReady && result.running && result.gatewayRunning && result.clawchatConnected && !state.ready) {
        enqueue('runtime_first_ready', 'succeeded', 'none', 'health_check'); state.ready = true; save();
      }
      if (!state.active && result.installed && !result.setupCompleted && !['error','cancelled'].includes(result.installer?.phase)) {
        const waiting = !result.modelConfigured ? 'wait_model' : !result.clawchatPaired ? 'wait_pair' : 'wait_start';
        if (state.waiting !== waiting) { state.waiting = waiting; enqueue('setup_waiting', 'waiting', 'none', waiting); save(); }
      }
    }),
    pulse: protect(() => { if (allowed() && state.active && !state.active.handoff) { enqueue('heartbeat'); save(); } }),
    relocate: protect(next => {
      if (next === file || broken) return;
      const previous = file;
      if (fs.existsSync(next)) throw Error('destination already has statistics');
      file = next; save(); fs.rmSync(previous, { force: true });
    }),
    async flush() {
      if (!allowed() || sending || now() < due || !state.queue.length) return;
      sending = true; controller = new AbortController();
      const sentGeneration = generation;
      const timeout = setTimeout(() => controller?.abort(), 10000); timeout.unref?.();
      try {
        state.queue = state.queue.filter(e => e.occurred_at >= now() - 7 * DAY);
        const batch = [];
        for (const event of state.queue.slice(0,20)) {
          if (Buffer.byteLength(JSON.stringify({events:[...batch,event]})) > contract.faultLimits.batchBytes) break;
          batch.push(event);
        }
        if (!batch.length) { save(); return; }
        const response = await fetcher(ENDPOINT, { method: 'POST', headers: {'Content-Type':'application/json'},
          body: JSON.stringify({events:batch}), signal: controller.signal, redirect:'error', credentials:'omit' });
        if (!allowed() || sentGeneration !== generation) return;
        if (response.status === 429) {
          const retry = Number(response.headers.get('Retry-After'));
          if (Number.isFinite(retry) && retry > 0) due = now() + Math.min(retry,300) * 1000;
          throw Error('retry');
        }
        if (!response.ok) throw Error('http');
        const result = await response.json();
        if (!allowed() || sentGeneration !== generation) return;
        if (result.paused === true) {
          state.queue = []; state.active = null; state.pauseUntil = now() + 3600000; save(); return;
        }
        if (!Array.isArray(result.accepted_event_ids) || !Array.isArray(result.rejected_event_ids)) throw Error('response');
        const sent = new Set(batch.map(e => e.event_id));
        const done = new Set([...result.accepted_event_ids, ...result.rejected_event_ids.filter(e => ['invalid_event','identity_conflict'].includes(e.reason)).map(e => e.event_id)].filter(id => sent.has(id)));
        if (!done.size) throw Error('unacknowledged');
        state.queue = state.queue.filter(e => !done.has(e.event_id)); save(); attempts = 0; due = now() + 1000;
      } catch {
        if (sentGeneration !== generation) { due = 0; attempts = 0; }
        else {
          due = Math.max(due, now() + Math.min(300000, 2000 * 2 ** Math.min(++attempts,8)) * (0.8 + random() * 0.2));
          report('upload_deferred');
        }
      } finally { clearTimeout(timeout); controller = null; sending = false; }
    },
    close() { clearInterval(timer); controller?.abort(); },
  };
  protect(() => {
    if (!allowed()) return;
    if (!state.seen) { enqueue('launcher_first_seen'); state.seen = true; }
    if (state.active && !state.active.handoff) finish('interrupted');
    save();
  })();
  if (automatic && enabled) {
    let lastPulse = now();
    timer = setInterval(() => {
      if (now() - lastPulse >= 30000) { lastPulse = now(); api.pulse(); }
      void api.flush();
    }, 5000); timer.unref?.();
  }
  return api;
}

module.exports = { createTelemetry, errorCode };
