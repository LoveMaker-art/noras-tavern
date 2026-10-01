// Technical classification is independent from the separately sanitized fault packet.
const contract = require('./telemetry-contract.json');
const pick = (list, value, fallback = '') => list.includes(value) ? value : fallback;
function describeError(error, context = {}) {
  const chain = []; const seen = new Set();
  for (let e = error; e && typeof e === 'object' && !seen.has(e) && chain.length < 4; e = e.cause) {
    seen.add(e); chain.push(e);
  }
  const source = pick(contract.sources, context.source || error?.source, 'launcher');
  const site = pick(contract.sites, context.site || error?.site, 'launcher.operation');
  const code = chain.map(e => e.code).find(c => contract.systemCodes.includes(c)) || '';
  const status = chain.map(e => e.status).find(s => Number.isInteger(s) && s >= 400 && s <= 599) ?? null;
  const exit = chain.map(e => e.exitCode).find(s => Number.isInteger(s) && s >= 0 && s <= 65535) ?? null;
  let category = 'unknown';
  if (['EACCES','EPERM'].includes(code)) category = 'permission_denied';
  else if (code === 'ENOENT') category = 'file_not_found';
  else if (code === 'ENOSPC') category = 'disk_full';
  else if (['ETIMEDOUT','TIMEOUT'].includes(code) || error?.name === 'TimeoutError') category = 'timeout';
  else if (code === 'ABORT_ERR' || error?.name === 'AbortError') category = 'cancelled';
  else if (['ENOTFOUND','EAI_AGAIN'].includes(code)) category = 'dns_failed';
  else if (code === 'ECONNREFUSED') category = 'connection_refused';
  else if (['ECONNRESET','ERR_NETWORK_CHANGED'].includes(code)) category = 'network';
  else if (['CERT_HAS_EXPIRED','UNABLE_TO_VERIFY_LEAF_SIGNATURE','ERR_CERT_AUTHORITY_INVALID'].includes(code)) category = 'tls_failed';
  else if (status === 401) category = 'http_unauthorized';
  else if (status === 403) category = 'http_forbidden';
  else if (status === 429) category = 'rate_limited';
  else if (status !== null) category = 'http_error';
  else if (code === 'INVALID_RESPONSE') category = 'invalid_response';
  else if (code === 'EMPTY_RESPONSE') category = 'empty_response';
  else if (code === 'RESPONSE_TOO_LARGE') category = 'response_too_large';
  else if (code === 'VERIFICATION_FAILED') category = 'verification_failed';
  else if (code === 'RENDERER_GONE') category = 'renderer_gone';
  else if (exit !== null) category = 'process_failed';
  return { error_code: category, error_source: source, error_site: site,
    system_code: code, http_status: status, exit_code: exit,
    exit_signal: pick(contract.signals, error?.signal),
    error_kind: pick(contract.kinds, error?.name, 'Error'),
    attempt: Number.isInteger(context.attempt ?? error?.attempt) ? Math.max(1, Math.min(10, context.attempt ?? error.attempt)) : 1 };
}

function launcherError(message, fields = {}, cause) {
  const error = new Error(message, cause ? {cause} : undefined);
  if (contract.kinds.includes(cause?.name)) error.name = cause.name;
  // Keep local UI text intact; only these technical properties cross layers.
  for (const key of ['code','userCode','status','source','site','exitCode','signal','attempt','remoteMessage']) {
    const value = fields[key] ?? cause?.[key] ?? cause?.cause?.[key];
    if (value !== undefined) error[key] = value;
  }
  if (cause?.name === 'TimeoutError' && !error.code) error.code = 'TIMEOUT';
  if (cause?.name === 'AbortError') error.name = 'AbortError';
  return error;
}
module.exports = { describeError, launcherError };
