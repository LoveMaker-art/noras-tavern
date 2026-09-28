const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const MAX_LOG_BYTES = 10 * 1024 * 1024;

function trimLegacyLog(file) {
  const size = fs.statSync(file).size;
  if (size <= MAX_LOG_BYTES) return;
  const marker = Buffer.from(`${JSON.stringify({ event: 'log.history-trimmed', timestamp: new Date().toISOString(), originalBytes: size })}\n`);
  const tail = Buffer.alloc(MAX_LOG_BYTES - marker.length);
  const fd = fs.openSync(file, 'r');
  let read;
  try { read = fs.readSync(fd, tail, 0, tail.length, size - tail.length); }
  finally { fs.closeSync(fd); }
  // Drop the partial first record, retaining only complete recent JSONL lines.
  const bytes = tail.subarray(0, read);
  const newline = bytes.indexOf(10);
  fs.writeFileSync(file, Buffer.concat([marker, newline < 0 ? Buffer.alloc(0) : bytes.subarray(newline + 1)]), { mode: 0o600 });
}

function appendLogLine(file, line) {
  let size = 0;
  try { size = fs.statSync(file).size; }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (size && size + Buffer.byteLength(line) > MAX_LOG_BYTES) {
    for (const name of [file, `${file}.1`]) {
      try { trimLegacyLog(name); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    fs.rmSync(`${file}.2`, { force: true });
    try { fs.renameSync(`${file}.1`, `${file}.2`); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    fs.renameSync(file, `${file}.1`);
  }
  fs.appendFileSync(file, line, { mode: 0o600 });
}

function appendRecord(file, record) {
  const json = JSON.stringify(record);
  if (Buffer.byteLength(json) + 1 <= MAX_LOG_BYTES) {
    appendLogLine(file, `${json}\n`);
    return;
  }
  // Oversized records remain recoverable without splitting UTF-8 or JSON escapes.
  const encoded = Buffer.from(json).toString('base64');
  const chunkSize = MAX_LOG_BYTES - 1024;
  const id = randomUUID();
  const total = Math.ceil(encoded.length / chunkSize);
  for (let index = 0; index < total; index++) {
    appendLogLine(file, `${JSON.stringify({ event: 'log.fragment', id, index, total, encoding: 'base64-json',
      data: encoded.slice(index * chunkSize, (index + 1) * chunkSize) })}\n`);
  }
}

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
      appendRecord(file, clean(record));
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
