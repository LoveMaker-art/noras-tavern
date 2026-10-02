const { createHash } = require('node:crypto');
const os = require('node:os');
const contract = require('./telemetry-contract.json');

// Separate from the local logger: only explicitly supplied launcher evidence
// enters this projection. Never read install.log, settings, or service logs.
function createFaultPackets({ clean = value => value, roots = () => [], environment = {} } = {}) {
  function text(value, limit = 1200) {
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
    result = result.slice(0,limit);
    while (Buffer.byteLength(result) > limit) result = result.slice(0,-1);
    return result;
    } catch { return '[EVIDENCE UNAVAILABLE]'; }
  }
  function frames(value) {
    return String(value || '').split(/\r?\n/).filter(line => /^\s*(?:at\s|File\s+["'])/.test(line))
      .slice(-12).map(line => text(line.trim(), 240));
  }
  function evidence(error, output = false) {
    const errors = [], seen = new Set();
    const modelFailure = error?.source === 'model_service';
    function visit(e, relation = 'error') {
      if (e == null || seen.has(e) || errors.length >= 4) return;
      if (typeof e !== 'object') e = {name:'Error',message:String(e)};
      seen.add(e);
      const kind = contract.faultKinds.includes(e.name) ? e.name : 'Error';
      const type = kind === 'Error' && e.name !== 'Error' && /^[A-Za-z][A-Za-z0-9_]{0,79}$/.test(e.name || '') ? `${e.name}: ` : '';
      errors.push({ relation, kind,
        message: modelFailure || e.source === 'model_service' ? 'Model request failed; see technical status.' : text(type + (e.remoteMessage ?? e.message)),
        frames: frames(e.stack), code: contract.systemCodes.includes(e.code) ? e.code : '',
        syscall: /^[a-z_]{1,32}$/.test(e.syscall || '') ? e.syscall : '',
        path: e.path ? frames(`at file (${String(e.path)})`)[0]?.match(/<source>\/[^)]+/)?.[0] || '[PATH]' : '' });
      visit(e.cause, 'cause');
      for (const secondary of (Array.isArray(e.secondaryErrors) ? e.secondaryErrors : []).slice(0, 2)) visit(secondary.error, 'secondary');
    }
    const child = error?.launcherEvidence;
    // The collector accepts bridge-owned structured errors independently of
    // installer output. Prefer these roots before the generic JS exit wrapper.
    if (child) {
      for (const item of child.errors || []) visit(item, item.evidenceRelation || 'child');
    }
    visit(error);
    return { errors, output: output && child ? child.output.slice(-12).map(line => text(line, 500)) : [],
      truncated: Boolean(child?.truncated) || errors.length === 4 };
  }
  function packet(error, task, context = {}) {
    const childAllowed = ['install', 'update', 'repair'].includes(task.action);
    const data = evidence(error, childAllowed);
    const env = { os_release: text(environment.os_release || os.release(), 80),
      node: text(environment.node || process.versions.node, 40), electron: text(environment.electron || process.versions.electron || '', 40),
      launcher_build: /^[a-f0-9]{64}$/.test(environment.launcher_build || '') ? environment.launcher_build : '' };
    const breadcrumbs = (Array.isArray(task.history) ? task.history : []).filter(item => item
      && contract.events.includes(item.event) && contract.stages.includes(item.stage) && contract.statuses.includes(item.status)
      && Number.isSafeInteger(item.elapsed_ms) && item.elapsed_ms >= 0 && item.elapsed_ms <= 30 * 86400000).slice(-16).map(item => ({
      event: item.event, stage: item.stage, status: item.status, elapsed_ms: item.elapsed_ms,
    }));
    const fingerprint = createHash('sha256').update(JSON.stringify({site: context.site || error?.site || '',
      errors: data.errors.map(e => ({kind:e.kind,code:e.code,syscall:e.syscall,frames:e.frames,
        message:e.message.replace(/\b\d+\b/g, '#')}))})).digest('hex');
    const result = { schema: 1, fingerprint, environment: env, ...data, breadcrumbs };
    while (Buffer.byteLength(JSON.stringify(result)) > contract.faultLimits.packetBytes) {
      result.truncated = true;
      if (result.output.length) result.output.shift();
      else if (result.errors.some(e => e.frames.length)) result.errors.find(e => e.frames.length).frames.shift();
      else if (result.errors.some(e => e.message.length > 80)) {
        const e = result.errors.find(e => e.message.length > 80); e.message = e.message.slice(0,Math.floor(e.message.length/2));
      } else break;
    }
    return result;
  }
  // Per child, bounded in memory and captured before UI summary truncation.
  function collector(enabled, { output: captureOutput = true } = {}) {
    const output = [], errors = []; let truncated = false, structured = false;
    return {
      observe(message) {
        if (!enabled) return;
        if (!captureOutput && !(message.event === 'diagnostic' && message.component === 'bridge')) return;
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
          const projected = evidence(e).errors;
          for (const item of projected) {
            const value = {name:item.kind,message:item.message,stack:item.frames.join('\n'),
              code:item.code,syscall:item.syscall,path:item.path,evidenceRelation:item.relation === 'error' ? 'child' : item.relation};
            if (!errors.some(saved => JSON.stringify(saved) === JSON.stringify(value))) errors.push(value);
          }
        }
        if (captureOutput && message.event === 'log' && ['stderr','combined'].includes(message.stream)) output.push(text(message.line, 500));
        if (output.length > 12) { output.shift(); truncated = true; }
        while (errors.length > 4) { errors.pop(); truncated = true; }
      },
      attach(error) { if (enabled) error.launcherEvidence = {output, errors, truncated}; return error; },
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
  if (!keys(value,['schema','fingerprint','environment','errors','output','breadcrumbs','truncated']) || value.schema !== 1 || typeof value.truncated !== 'boolean'
    || !/^[a-f0-9]{64}$/.test(value.fingerprint)) return false;
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
