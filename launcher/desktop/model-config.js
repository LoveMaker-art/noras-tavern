const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { createHash, createHmac } = require('node:crypto');
const { launcherError } = require('./launcher-errors');

function modelCredential(provider, payload) {
  if ((provider.custom && payload?.authMode === 'none') || provider.keyless) return '';
  if (payload?.authMode === 'oauth' || payload?.authMode === 'external') return '';
  if (provider.authenticated && !String(payload?.key || '').trim()) return '';
  const key = String(payload?.key || '').trim();
  const invalid = cause => launcherError('API Key 格式不正确，请从服务商后台重新复制。',
    {userCode:'MODEL_KEY_INVALID',source:'model_service'},cause);
  if (!key || key.length > 8192 || /[\r\n]/.test(key)) throw invalid();
  // Use the transport's validator for every protocol, including providers
  // whose list API places the key in a URL but whose model test uses a header.
  try { http.validateHeaderValue('Authorization',`Bearer ${key}`); }
  catch (error) { throw invalid(error); }
  return key;
}

function configurationFingerprint({provider,model,key,baseUrl='',authMode='key'},salt){
  if(typeof salt!=='string'||salt.length<16)throw new TypeError('Installation identity is required for model conditions');
  return createHmac('sha256',salt).update(JSON.stringify([provider,model,key,baseUrl,authMode])).digest('hex');
}

// Provider capabilities and transport behavior belong to the installed Hermes.
// This module only validates UI input and the launcher's non-secret checkpoint.
function requireProvider(id, providers) {
  const provider = providers?.find(item => item.id === String(id || '').trim());
  if (!provider) throw new Error('当前 Hermes 不支持这个模型服务。');
  if (provider.available === false) throw new Error(provider.reason || '这个模型服务当前不可用。');
  return provider;
}

function normalizeCustomBaseUrl(value) {
  const text = String(value || '').trim().replace(/\/+$/, '');
  if (!text || text.length > 2048 || /[\r\n]/.test(text)) {
    throw new Error('请输入有效的中转地址。');
  }
  let url;
  try {
    url = new URL(text);
  } catch {
    throw new Error('中转地址格式不正确。');
  }
  if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password) {
    throw new Error('中转地址必须是不含账号信息的 HTTP/HTTPS 地址。');
  }
  if (url.search || url.hash) throw new Error('接口地址不能包含查询参数或片段，请填写基础地址。');
  return text.replace(/\/chat\/completions$/, '');
}

function verifiedModelPath(noraHome) {
  return path.join(noraHome, 'installer', 'model.json');
}

function writeVerifiedModel(noraHome, value) {
  const target = verifiedModelPath(noraHome);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const temporary = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify({
    schema: 1,
    hermesNative: true,
    provider: value.provider,
    model: value.model,
    keyEnv: value.keyEnv || '',
    ...(value.baseUrl ? { baseUrl: normalizeCustomBaseUrl(value.baseUrl) } : {}),
    authMode: String(value.authMode || 'key'),
    ...(value.credentialRef ? { credentialRef: value.credentialRef } : {}),
    tavernSyncUnsupported: Boolean(value.tavernSyncUnsupported),
    ...(value.tavernSyncReason ? {tavernSyncReason: String(value.tavernSyncReason)} : {}),
    toolSupport: 'unverified',
    tavernSyncPending: Boolean(value.tavernSyncPending),
    ...(value.key ? { credentialSha256: createHash('sha256').update(value.key).digest('hex') }
      : value.credentialSha256 ? { credentialSha256: value.credentialSha256 } : {}),
    verifiedAt: new Date().toISOString(),
  }, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, target);
}

function readVerifiedModel(noraHome) {
  try {
    const value = JSON.parse(fs.readFileSync(verifiedModelPath(noraHome), 'utf8'));
    const custom = value.provider === 'custom' || (typeof value.provider === 'string'
      && value.provider.startsWith('custom:') && Boolean(value.provider.slice(7).trim()));
    if (value.schema !== 1 || typeof value.provider !== 'string' || !value.provider.trim()
      || value.provider.length > 200 || /[\r\n\0]/.test(value.provider) || typeof value.model !== 'string' || !value.model.trim()
      || value.model.length > 240 || /[\r\n\0]/.test(value.model)) return null;
    if (custom && value.baseUrl) value.baseUrl = normalizeCustomBaseUrl(value.baseUrl);
    return value;
  } catch {
    return null;
  }
}

module.exports = {
  configurationFingerprint,
  modelCredential,
  normalizeCustomBaseUrl,
  readVerifiedModel,
  requireProvider,
  writeVerifiedModel,
};
