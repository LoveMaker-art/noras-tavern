// Technical classification is independent from the separately sanitized fault packet.
const contract = require('./telemetry-contract.json');
const errno = new Set(Object.keys(require('node:os').constants.errno).concat(['CAPACITY','UNKNOWN','EVIDENCE_PATH','EVIDENCE_INVALID']));
const pick = (list, value, fallback = '') => list.includes(value) ? value : fallback;

// Native facts remain local. Share this allowlist across reconstruction,
// collection and persistence without adding these fields to the fault wire.
function programFacts(record) {
  const facts = {}, reasons = [];
  const reason = value => { if (!reasons.includes(value)) {
    if (reasons.length < 16) reasons.push(value); else facts.truncated = true;
  } };
  const context = record?.context;
  if (context && typeof context === 'object' && !Array.isArray(context)) {
    const projected = {}, bounds = { pid: [1,4294967295], exitCode: [-2147483648,4294967295], port: [1,65535] };
    for (const [key,[minimum,maximum]] of Object.entries(bounds)) {
      if (Number.isSafeInteger(context[key]) && context[key] >= minimum && context[key] <= maximum) projected[key] = context[key];
      else if (Object.hasOwn(context,key)) reason('unknown_evidence_gap');
    }
    if (typeof context.loopback === 'boolean') projected.loopback = context.loopback;
    else if (Object.hasOwn(context,'loopback')) reason('unknown_evidence_gap');
    if (['native_start','first_install','update_apply','restoring'].includes(context.stage)) projected.stage = context.stage;
    else if (Object.hasOwn(context,'stage')) reason('unknown_evidence_gap');
    if (Object.keys(context).some(key => !['pid','exitCode','port','loopback','stage'].includes(key))) reason('sensitive_fields_omitted');
    if (Object.keys(projected).length) facts.context = projected;
  } else if (context !== undefined) reason('unknown_evidence_gap');
  const nativeReasons = ['non_project_frames_omitted','program_message_unreviewed','program_error_missing','launch_log_empty_or_changed','launch_log_unavailable'];
  if (Array.isArray(record?.missingReasons)) {
    if (record.missingReasons.length > 16) facts.truncated = true;
    for (const value of record.missingReasons.slice(0,16)) {
      const failure = typeof value === 'string' && /^(?:save_failed|evidence_read_failed):([A-Z_]{1,32})$/.exec(value);
      reason(nativeReasons.includes(value) || contract.faultMissingReasons.includes(value) || failure && errno.has(failure[1])
        ? value : 'unknown_evidence_gap');
    }
  } else if (record?.missingReasons !== undefined) reason('unknown_evidence_gap');
  if (reasons.length) facts.missingReasons = reasons;
  if (record?.truncated === true) facts.truncated = true;
  return facts;
}
function programIdentity(record) {
  const http = Number.isInteger(record?.code) ? record.code : record?.status;
  return { name: typeof record?.name === 'string' && /^[A-Za-z][A-Za-z0-9_]{0,79}$/.test(record.name) ? record.name : 'Error',
    code: typeof record?.code === 'string' && /^[A-Z][A-Z0-9_]{0,79}$/.test(record.code) ? record.code
      : Number.isInteger(http) && http >= 100 && http <= 599 ? http : '' };
}
function isProxyConnectionFailure(error, context = {}) {
  if ((context.source || error?.source) !== 'release_service'
      || !['release.request','release.download'].includes(context.site || error?.site)) return false;
  const seen = new Set();
  for (let value = error, depth = 0; value && typeof value === 'object' && !seen.has(value) && depth < 4; value = value.cause, depth++) {
    seen.add(value);
    if (value.message === 'net::ERR_PROXY_CONNECTION_FAILED') return true;
  }
  return false;
}
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
  else if (['ECONNRESET','ERR_NETWORK_CHANGED'].includes(code) || isProxyConnectionFailure(error, context)) category = 'network';
  else if (['CERT_HAS_EXPIRED','UNABLE_TO_VERIFY_LEAF_SIGNATURE','ERR_CERT_AUTHORITY_INVALID'].includes(code)) category = 'tls_failed';
  else if (status === 401) category = 'http_unauthorized';
  else if (status === 403 && chain.some(error=>error.rateLimited===true)) category = 'rate_limited';
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
  for (const key of ['code','userCode','status','source','site','exitCode','signal','attempt','remoteMessage',
    'rateLimited','retryAfterMs','rateLimitRemaining','rateLimitReset']) {
    const value = fields[key] ?? cause?.[key] ?? cause?.cause?.[key];
    if (value !== undefined) error[key] = value;
  }
  if (cause?.name === 'TimeoutError' && !error.code) error.code = 'TIMEOUT';
  if (cause?.name === 'AbortError') error.name = 'AbortError';
  if(cause?.operation?.schema==='nora-operation/1')error.operation=cause.operation;
  return error;
}
function programError(record,depth=0){
  if(!record||typeof record!=='object'||depth>=4)return undefined;
  const cause=programError(record.cause,depth+1);
  const error=new Error(typeof record.message==='string'?record.message.slice(0,2000):'受管程序执行失败。',cause?{cause}:undefined);
  const identity=programIdentity(record);
  if(identity.code!=='')error.code=identity.code;
  if(Number.isInteger(record.code)&&record.code>=400&&record.code<=599)error.status=record.code;
  error.name=identity.name;
  if(typeof record.stack==='string')error.stack=record.stack.split(/\r?\n/).filter(line=>/^\s*File\s+"[A-Za-z0-9_.-]+\.(?:py|js|cjs|mjs)", line \d+, in [A-Za-z_<>][A-Za-z0-9_<>.]*$/.test(line)).slice(-12).join('\n');
  if(Array.isArray(record.secondaryErrors))error.secondaryErrors=record.secondaryErrors.slice(0,2)
    .map(item=>({operation:'child-secondary',error:programError(item?.error,depth+1)})).filter(item=>item.error);
  Object.assign(error,programFacts(record));
  return error;
}
module.exports = { describeError, launcherError, isProxyConnectionFailure,programError,programFacts,programIdentity };
