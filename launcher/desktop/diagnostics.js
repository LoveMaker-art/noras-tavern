const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

// Explicit fields avoid accidentally serializing request bodies or environments.
function errorDetails(error, seen = new Set()) {
  if (!error || typeof error !== 'object') return { message: String(error) };
  if (seen.has(error)) return { message: '[circular error]' };
  seen.add(error);
  const details = {};
  for (const key of ['name', 'message', 'stack', 'code', 'errno', 'syscall', 'path', 'dest', 'signal', 'exitCode', 'context']) {
    if (error[key] !== undefined) details[key] = error[key];
  }
  if (error.cause) details.cause = errorDetails(error.cause, seen);
  if (error.errors) details.errors = Array.from(error.errors, item => errorDetails(item, seen));
  if (error.secondaryErrors) details.secondaryErrors = error.secondaryErrors.map(item => ({
    operation: item.operation, error: errorDetails(item.error, seen),
  }));
  return details;
}

function createDiagnostics({ primary, fallback }) {
  const secrets = new Set();
  let runId = `startup-${randomUUID()}`;
  let started = Date.now();
  let stage = 'startup';
  let lastFile = '';
  const sensitive = /^(?:.*[_-])?(?:api[_-]?key|access[_-]?token|refresh[_-]?token|token|secret|password|authorization|cookie|pair[_-]?code)$/i;
  function addSecret(value) { if (typeof value === 'string' && value) secrets.add(value); }
  function text(value) {
    let result = String(value);
    for (const secret of [...secrets].sort((a, b) => b.length - a.length)) {
      for (const form of new Set([secret, JSON.stringify(secret).slice(1, -1), encodeURIComponent(secret)])) {
        result = result.split(form).join('[REDACTED]');
      }
    }
    return result
      .replace(/\b(?:sk|sk-ant)-[A-Za-z0-9_-]+/g, '[REDACTED]')
      .replace(/\b(Bearer|Basic)\s+[^\s"'<>]+/gi, '$1 [REDACTED]')
      .replace(/((?:[\w-]*(?:api[_-]?key|token|secret|password|pair[_-]?code)|authorization|cookie)["']?\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;}]+)/gi, '$1[REDACTED]')
      .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, '$1[REDACTED]@')
      .replace(/([?&][\w.-]+=)[^\s&#"'<>]+/g, '$1[REDACTED]');
  }
  function clean(value, key = '') {
    if (sensitive.test(key) || key === 'code' && typeof value === 'string' && !/^[A-Z_]+$/.test(value)) return '[REDACTED]';
    if (typeof value === 'string') return text(value);
    if (Array.isArray(value)) return value.map((item, index) => {
      if (key === 'command' && index > 0 && /^--?(?:key|api-key|token|password|code|pair-code)$/.test(String(value[index - 1]))) return '[REDACTED]';
      return clean(item);
    });
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([name, item]) => [name, clean(item, name)]));
    return value;
  }
  function write(event, fields = {}) {
    const record = { ...fields, timestamp: new Date().toISOString(), runId, stage, elapsedMs: Date.now() - started, event };
    const append = file => {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.appendFileSync(file, `${JSON.stringify(clean(record))}\n`, { mode: 0o600 });
      lastFile = file;
    };
    try { append(primary()); }
    catch (error) {
      record.logWriteError = errorDetails(error);
      try { append(fallback); }
      catch (fallbackError) {
        // Logging failure must not replace the installation's original error.
        try { process.stderr.write(`${JSON.stringify(clean({ ...record, fallbackError: errorDetails(fallbackError) }))}\n`); } catch {}
      }
    }
  }
  return {
    addSecret, clean, write,
    get lastFile() { return lastFile; },
    begin(id, fields) { runId = id; started = Date.now(); stage = 'starting'; write('run.start', fields); },
    event(message) {
      if (message.event === 'heartbeat' || message.event === 'result') return;
      if (message.task) stage = message.task;
      write(message.event, message);
    },
    error(event, error, fields = {}) { write(event, { ...fields, error: errorDetails(error) }); },
    finish(outcome) { write('run.end', { outcome, durationMs: Date.now() - started }); },
  };
}

module.exports = { createDiagnostics, errorDetails };
