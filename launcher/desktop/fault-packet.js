const { createHash } = require('node:crypto');
const os = require('node:os');
const contract = require('./telemetry-contract.json');
const { programFacts, programIdentity } = require('./launcher-errors');

// Separate from the local logger: only explicitly supplied launcher evidence
// enters this projection. Never read install.log, settings, or service logs.
function createFaultPackets({ clean = value => value, roots = () => [], environment = {} } = {}) {
  function text(value, limit = 1200, state = null) {
    try {
    let result = String(clean(String(value ?? '')));
    result = result.replace(/\x1b\[[0-9;]*m/g, '');
    result = result.replace(/(?:https?|wss?):\/\/[^\s"'<>]+/gi, '[URL]')
      .replace(/\b(?:Bearer|Basic)\s+[^\s"'<>]+/gi, '[AUTH]')
      .replace(/((?:[\w-]*(?:api[_-]?key|token|secret|password|authorization|cookie|pair[_-]?code))["']?\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;}]+)/gi, '$1[REDACTED]')
      .replace(/\b(?:sk-|ghp_|gho_)[A-Za-z0-9_-]+/g, '[REDACTED]')
      .replace(/[A-Za-z0-9_-]{32,}/g, '[OPAQUE]')
      .replace(/[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/g, '[EMAIL]');
    // Retain source locations, never an absolute directory or a data filename.
    for (const root of roots()) {
      if (typeof root === 'string' && root) result = result.split(root).join('<root>');
    }
    const locationText = location => {
      const normalized = location.replaceAll('\\', '/');
      const source = normalized.match(/(?:^|\/)([\w.-]+\.(?:js|cjs|mjs|py))(?::\d+(?::\d+)?)?$/);
      return source ? `<source>/${source[1]}${normalized.slice(normalized.lastIndexOf(source[1]) + source[1].length)}` : '[PATH]';
    };
    result = result.replace(/(["'])((?:[A-Za-z]:[\\/]|\\\\|\/)[^\r\n]*?)\1/g, (_all, quote, location) => quote + locationText(location) + quote)
      .replace(/[A-Za-z]:[\\/][^\r\n"'<>)]*|\\\\[^\r\n"'<>)]*/g, locationText)
      .replace(/(?:<root>|(?<![>])\/)[^\r\n"'<>)]*/g, locationText);
    // Configuration / conversation fragments are not useful installer evidence.
    result = result.split(/\r?\n/).map(line => /(?:["'](?:messages|content|prompt|api_key|apiKey)["']\s*:|\b(?:chat|conversation)\b|聊天|模型回复)/i.test(line)
      ? '[CONTENT OMITTED]' : line).join('\n');
    if (Buffer.byteLength(result) > limit && state) state.truncated = true;
    result = result.slice(0,limit);
    while (Buffer.byteLength(result) > limit) result = result.slice(0,-1);
    if (/[\uD800-\uDBFF]$/.test(result)) result = result.slice(0, -1);
    return result;
    } catch { return '[EVIDENCE UNAVAILABLE]'; }
  }
  function frames(value, state) {
    const locations = String(value || '').split(/\r?\n/).filter(line => /^\s*(?:at\s|File\s+["'])/.test(line));
    if (locations.length > 12 && state) state.truncated = true;
    return locations.slice(-12).map(line => text(line.trim(), 240, state));
  }
  function evidence(error, output = false, localFacts = false) {
    const errors = [], seen = new Set(), state = { truncated: false };
    const modelFailure = error?.source === 'model_service';
    function visit(e, relation = 'error') {
      if (e == null || seen.has(e)) return;
      if (errors.length >= 4) { state.truncated = true; return; }
      if (typeof e !== 'object') e = {name:'Error',message:String(e)};
      seen.add(e);
      state.truncated ||= e.truncated === true;
      const local = localFacts ? {...programFacts(e),...programIdentity(e)} : {};
      state.truncated ||= local.truncated === true;
      const kind = contract.faultKinds.includes(e.name) ? e.name : 'Error';
      const type = kind === 'Error' && e.name !== 'Error' && /^[A-Za-z][A-Za-z0-9_]{0,79}$/.test(e.name || '') ? `${e.name}: ` : '';
      errors.push({ relation, kind,
        message: modelFailure || e.source === 'model_service' ? 'Model request failed; see technical status.' : text((localFacts ? '' : type) + (e.remoteMessage ?? e.message), 1200, state),
        frames: frames(e.stack, state), code: contract.systemCodes.includes(e.code) ? e.code : '',
        syscall: /^[a-z_]{1,32}$/.test(e.syscall || '') ? e.syscall : '',
        path: e.path ? frames(`at file (${String(e.path)})`, state)[0]?.match(/<source>\/[^)]+/)?.[0] || '[PATH]' : '',
        ...local });
      visit(e.cause, 'cause');
      const secondaryErrors = Array.isArray(e.secondaryErrors) ? e.secondaryErrors : [];
      if (secondaryErrors.length > 2) state.truncated = true;
      for (const secondary of secondaryErrors.slice(0, 2)) visit(secondary.error, 'secondary');
    }
    const child = error?.launcherEvidence;
    // The collector accepts bridge-owned structured errors independently of
    // installer output. Prefer these roots before the generic JS exit wrapper.
    if (child) {
      for (const item of child.errors || []) visit(item, item.evidenceRelation || 'child');
    }
    visit(error);
    const lines = output && Array.isArray(child?.output) ? child.output : [];
    if (lines.length > 12) state.truncated = true;
    const projectedOutput = lines.slice(-12).map(line => text(line, 500, state));
    return { errors, output: projectedOutput,
      truncated: state.truncated || Boolean(child?.truncated) };
  }
  function packet(error, task, context = {}) {
    const supplied = Object.hasOwn(context, 'operation') || Object.hasOwn(context, 'evidence');
    const stored = context.evidence?.operationId === task.id ? context.evidence : null;
    const restore = value => value && typeof value === 'object' ? { name: value.name, message: value.message,
      code: value.code, stack: Array.isArray(value.frames) ? value.frames.join('\n') : '', cause: restore(value.cause) } : null;
    const original = stored?.primary ? restore(stored.primary) : error;
    if (stored?.primary) original.secondaryErrors = (stored.secondary || []).map(item => ({ error: restore(item.error) }));
    // Only the explicitly reviewed projection is durable. Never upload a raw
    // log file or a legacy unreviewed `output` field from stored metadata.
    const data = evidence(original, !supplied && ['install', 'update', 'repair'].includes(task.action));
    if (Array.isArray(stored?.reviewedOutput)) {
      if (stored.reviewedOutput.length > 12) data.truncated = true;
      data.output = stored.reviewedOutput.slice(-12).map(line => text(line, 500, data));
    }
    data.truncated ||= stored?.truncated === true;
    let operation = null, evidenceInfo = null;
    if (supplied) {
      const source = context.operation;
      const id = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
      const version = value => typeof value === 'string' && /^v?\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]{1,40})?$/.test(value) ? value.replace(/^v/,'') : null;
      const code = value => /^[A-Z][A-Z0-9_]{0,99}$/.test(value || '') ? value : null;
      const integer = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
      const member = (value, list) => contract[list].includes(value) ? value : null;
      if (source && id.test(source.operationId || '') && source.operationId === task.id) {
        operation = { operation_id: source.operationId, snapshot_sequence: integer(source.snapshotSequence),
          target_version: version(source.target?.releasePlan?.tag || source.target?.tag),
          current_version: version(source.currentVersion || source.target?.currentVersion),
          plan_digest: /^[a-f0-9]{64}$/.test(source.planDigest || '') ? source.planDigest : null,
          stage_id: member(stored?.context?.stage, 'faultOperationStages') || member(source.stageId, 'faultOperationStages'), effect_state: member(source.effectState, 'faultEffectStates'),
          recovery_outcome: member(source.recoveryOutcome, 'faultRecoveryOutcomes'), verification: member(source.verification, 'faultVerifications'),
          attempt: integer(source.attempt), total_attempts: integer(source.totalAttempts),
          primary_code: code(source.primaryFailure?.code), secondary_codes: (source.secondaryFailures || []).slice(0,8).map(item => code(item.code)).filter(Boolean) };
        if (source.secondaryFailures?.length > 8) data.truncated = true;
      }
      const missing = [...(stored?.missingReasons || []),...(source?.evidenceMissingReasons || [])].map(reason => contract.faultMissingReasons.includes(reason)
        || /^(?:save_failed|evidence_read_failed):[A-Z_]{1,32}$/.test(reason) ? reason : 'unknown_evidence_gap');
      if (!operation) missing.push('operation_context_missing');
      else for (const key of ['target_version','current_version','plan_digest']) if (operation[key] === null) missing.push(key + '_missing');
      if (!data.errors.length || stored && !stored.primary) missing.push('primary_detail_missing');
      if (!data.errors[0]?.frames.length) missing.push('primary_frames_missing');
      const unique = [...new Set(missing)]; if (unique.length > 16) data.truncated = true;
      evidenceInfo = { local_status: member(source?.evidenceStatus, 'faultEvidenceStatuses') || 'unknown',
        missing_reasons: unique.slice(0,16), primary_error_index: data.errors.length ? 0 : null,
        secondary_error_indexes: data.errors.flatMap((item,index) => item.relation === 'secondary' ? [index] : []) };
    }
    const env = { os_release: text(environment.os_release || os.release(), 80, data),
      node: text(environment.node || process.versions.node, 40, data), electron: text(environment.electron || process.versions.electron || '', 40, data),
      launcher_build: /^[a-f0-9]{64}$/.test(environment.launcher_build || '') ? environment.launcher_build : '' };
    const history = (Array.isArray(task.history) ? task.history : []).filter(item => item
      && contract.events.includes(item.event) && contract.stages.includes(item.stage) && contract.statuses.includes(item.status)
      && Number.isSafeInteger(item.elapsed_ms) && item.elapsed_ms >= 0 && item.elapsed_ms <= 30 * 86400000);
    if (history.length > 16) data.truncated = true;
    const breadcrumbs = history.slice(-16).map(item => ({
      event: item.event, stage: item.stage, status: item.status, elapsed_ms: item.elapsed_ms,
    }));
    const fingerprint = createHash('sha256').update(JSON.stringify({site: context.site || error?.site || '',
      errors: data.errors.map(e => ({kind:e.kind,code:e.code,syscall:e.syscall,frames:e.frames,
        message:e.message.replace(/\b\d+\b/g, '#')}))})).digest('hex');
    const result = { schema: supplied ? 2 : 1, fingerprint, environment: env, ...data, breadcrumbs,
      ...(supplied ? { operation, evidence: evidenceInfo } : {}) };
    while (Buffer.byteLength(JSON.stringify(result)) > contract.faultLimits.packetBytes) {
      result.truncated = true;
      if (result.output.length) result.output.shift();
      else if (result.errors.some(e => e.frames.length)) result.errors.slice().reverse().find(e => e.frames.length).frames.shift();
      else if (result.errors.some(e => e.message.length > 80)) {
        const e = result.errors.slice().reverse().find(e => e.message.length > 80); e.message = e.message.slice(0,Math.floor(e.message.length/2));
      } else break;
    }
    return result;
  }
  // Per child, bounded in memory and captured before UI summary truncation.
  function collector(enabled, { output: captureOutput = true, components } = {}) {
    const output = [], errors = []; let truncated = false, structured = false;
    components ||= captureOutput ? ['bridge','installer','updater','native','runtime'] : ['bridge'];
    const reviewed=new Set(components.filter(value=>['bridge','installer','updater','native','runtime'].includes(value)));
    return {
      observe(message) {
        if (!enabled) return;
        if (message.event === 'diagnostic' && !reviewed.has(message.component)) return;
        if (!captureOutput && !(message.event === 'diagnostic' && reviewed.has(message.component))) return;
        if (message.event === 'error' && structured) return;
        const e = message.event === 'diagnostic' ? message.error : message.event === 'error' ? {message:message.message,code:message.code} : null;
        if (e && typeof e === 'object') {
          if (message.event === 'diagnostic' && e.truncated === true) truncated = true;
          if (message.event === 'diagnostic') {
            // The install/update script projects its final primary cause and
            // rollback branches together. Prefer that group over earlier
            // scalar summaries or cleanup events, then keep it ahead of the
            // outer bridge's generic exit wrapper. Service commands still
            // accept only bridge-owned projections above.
            if (!structured || ['installer','updater'].includes(message.component)) errors.length = 0;
            structured = true;
          }
          const projected = evidence(e, false, true);
          truncated ||= projected.truncated;
          for (const item of projected.errors) {
            const value = {name:item.name,message:item.message,stack:item.frames.join('\n'),
              code:item.code,syscall:item.syscall,path:item.path,evidenceRelation:item.relation === 'error' ? 'child' : item.relation,
              ...programFacts(item)};
            if (!errors.some(saved => JSON.stringify(saved) === JSON.stringify(value))) errors.push(value);
          }
        }
        if (captureOutput && message.event === 'log' && ['stdout','stderr','combined'].includes(message.stream)) {
          const state = { truncated };
          output.push(text(message.line, 500, state));
          truncated = state.truncated;
        }
        if (output.length > 12) { output.shift(); truncated = true; }
        while (errors.length > 4) { errors.pop(); truncated = true; }
      },
      attach(error) {
        if (enabled) {
          const facts = [];
          const exitCode = error?.exitCode ?? error?.context?.exitCode;
          if (Number.isSafeInteger(exitCode)) facts.push(`[ERROR] subprocess exitCode=${exitCode}`);
          if (/^SIG[A-Z0-9]{1,16}$/.test(error?.signal || '')) facts.push(`[ERROR] subprocess signal=${error.signal}`);
          for (const item of errors) {
            if (item.context?.stage) facts.push(`[INFO] failure stage=${item.context.stage}`);
            if (Number.isSafeInteger(item.context?.exitCode)) facts.push(`[ERROR] subprocess exitCode=${item.context.exitCode}`);
            for (const reason of item.missingReasons || []) facts.push(`[WARNING] evidence omitted: ${reason}`);
          }
          const combined = [...output, ...new Set(facts)];
          const reviewedOutput = combined.slice(-12);
          error.launcherEvidence = { output: reviewedOutput, reviewedOutput, errors,
            truncated: truncated || combined.length > 12 };
        }
        return error;
      },
    };
  }
  return { packet, collector, text };
}

// A corrupt persisted packet is never sent. The receiver repeats validation.
function validFaultPacket(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const keys = (v, expected) => v && typeof v === 'object' && !Array.isArray(v)
    && Object.keys(v).length === expected.length && expected.every(k => Object.hasOwn(v,k));
  const string = (v,n) => typeof v === 'string' && v.length <= n
    && !/(?:https?|wss?):\/\/|[A-Za-z]:[\\/]|\\\\|\/(?:Users|home|tmp|private|var|etc)\/|\b(?:Bearer|Basic)\s+(?!\[)|\b(?:sk-|ghp_|gho_)[A-Za-z0-9_-]+|["'](?:messages|content|prompt)["']\s*:/i.test(v);
  if (!keys(value,['schema','fingerprint','environment','errors','output','breadcrumbs','truncated',...(value.schema === 2 ? ['operation','evidence'] : [])]) || ![1,2].includes(value.schema) || typeof value.truncated !== 'boolean'
    || !/^[a-f0-9]{64}$/.test(value.fingerprint)) return false;
  if (value.schema === 2) {
    const integer = value => value === null || Number.isSafeInteger(value) && value >= 0;
    const member = (value,list) => value === null || contract[list].includes(value);
    const version = value => value === null || typeof value === 'string' && /^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]{1,40})?$/.test(value);
    const code = value => value === null || typeof value === 'string' && /^[A-Z][A-Z0-9_]{0,99}$/.test(value);
    const operation = value.operation;
    if (operation !== null && (!keys(operation,['operation_id','snapshot_sequence','target_version','current_version','plan_digest','stage_id','effect_state','recovery_outcome','verification','attempt','total_attempts','primary_code','secondary_codes'])
      || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(operation.operation_id)
      || !integer(operation.snapshot_sequence) || !integer(operation.attempt) || !integer(operation.total_attempts)
      || !version(operation.target_version) || !version(operation.current_version)
      || !(operation.plan_digest === null || /^[a-f0-9]{64}$/.test(operation.plan_digest))
      || !member(operation.stage_id,'faultOperationStages') || !member(operation.effect_state,'faultEffectStates')
      || !member(operation.recovery_outcome,'faultRecoveryOutcomes') || !member(operation.verification,'faultVerifications')
      || !code(operation.primary_code) || !Array.isArray(operation.secondary_codes) || operation.secondary_codes.length > 8 || !operation.secondary_codes.every(code))) return false;
    const info = value.evidence;
    if (!keys(info,['local_status','missing_reasons','primary_error_index','secondary_error_indexes']) || !contract.faultEvidenceStatuses.includes(info.local_status)
      || !Array.isArray(info.missing_reasons) || info.missing_reasons.length > 16 || !info.missing_reasons.every(reason => contract.faultMissingReasons.includes(reason) || /^(?:save_failed|evidence_read_failed):[A-Z_]{1,32}$/.test(reason))
      || !(info.primary_error_index === null || Number.isInteger(info.primary_error_index) && info.primary_error_index >= 0 && info.primary_error_index < value.errors?.length)
      || !Array.isArray(info.secondary_error_indexes) || info.secondary_error_indexes.length > 4 || !info.secondary_error_indexes.every(index => Number.isInteger(index) && index >= 0 && index < value.errors?.length && value.errors[index].relation === 'secondary')) return false;
  }
  const env = value.environment;
  if (!keys(env,['os_release','node','electron','launcher_build']) || !string(env.os_release,80)
    || !string(env.node,40) || !string(env.electron,40) || !/^(?:[a-f0-9]{64})?$/.test(env.launcher_build)) return false;
  if (!Array.isArray(value.errors) || value.errors.length > 4 || !value.errors.every(e =>
    keys(e,['relation','kind','message','frames','code','syscall','path']) && ['error','cause','secondary','child'].includes(e.relation)
    && contract.faultKinds.includes(e.kind) && string(e.message,1200) && Array.isArray(e.frames) && e.frames.length <= 12
    && e.frames.every(f => string(f,240)) && (e.code === '' || contract.systemCodes.includes(e.code))
    && /^(?:[a-z_]{1,32})?$/.test(e.syscall) && string(e.path,240))) return false;
  if (!Array.isArray(value.output) || value.output.length > 12 || !value.output.every(s => string(s,500))) return false;
  return Array.isArray(value.breadcrumbs) && value.breadcrumbs.length <= 16 && value.breadcrumbs.every(b =>
    keys(b,['event','stage','status','elapsed_ms']) && contract.events.includes(b.event)
    && contract.stages.includes(b.stage) && contract.statuses.includes(b.status)
    && Number.isSafeInteger(b.elapsed_ms) && b.elapsed_ms >= 0 && b.elapsed_ms <= 30 * 86400000);
}
module.exports = { createFaultPackets, validFaultPacket };
