const fs = require('node:fs');
const http = require('node:http');
const https = require('node:https');
const path = require('node:path');

const PROVIDERS = Object.freeze([
  {
    id: 'openrouter',
    label: 'OpenRouter',
    keyEnv: 'OPENROUTER_API_KEY',
    signupUrl: 'https://openrouter.ai/keys',
    modelsUrl: 'https://openrouter.ai/api/v1/models',
    verifyUrl: 'https://openrouter.ai/api/v1/key',
    recommended: true,
  },
  {
    id: 'deepseek',
    label: 'DeepSeek',
    keyEnv: 'DEEPSEEK_API_KEY',
    signupUrl: 'https://platform.deepseek.com/api_keys',
    modelsUrl: 'https://api.deepseek.com/models',
    recommended: true,
  },
  {
    id: 'anthropic',
    label: 'Anthropic',
    keyEnv: 'ANTHROPIC_API_KEY',
    signupUrl: 'https://console.anthropic.com/settings/keys',
    modelsUrl: 'https://api.anthropic.com/v1/models?limit=1000',
    recommended: true,
  },
  {
    id: 'openai-api',
    label: 'OpenAI',
    keyEnv: 'OPENAI_API_KEY',
    signupUrl: 'https://platform.openai.com/api-keys',
    modelsUrl: 'https://api.openai.com/v1/models',
    recommended: true,
  },
  {
    id: 'gemini',
    label: 'Google Gemini',
    keyEnv: 'GEMINI_API_KEY',
    signupUrl: 'https://aistudio.google.com/app/apikey',
    modelsUrl: 'https://generativelanguage.googleapis.com/v1beta/models',
    recommended: true,
  },
  {
    id: 'custom',
    label: '自定义模型',
    keyEnv: '',
    signupUrl: '',
    custom: true,
  },
]);

const PROVIDER_BY_ID = new Map(PROVIDERS.map((provider) => [provider.id, provider]));

function publicProviders() {
  return PROVIDERS.map(({ id, label, keyEnv, signupUrl, recommended, custom }) => ({
    id,
    label,
    keyEnv,
    signupUrl,
    recommended,
    custom: Boolean(custom),
  }));
}

function requireProvider(id) {
  const provider = PROVIDER_BY_ID.get(String(id || '').trim());
  if (!provider) throw new Error('不支持这个模型服务。');
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
  return text;
}

function requestHeaders(provider, key) {
  const headers = { Accept: 'application/json', 'User-Agent': 'Nora-Tavern-Launcher/0.1' };
  if (provider.id === 'anthropic') {
    headers['x-api-key'] = key;
    headers['anthropic-version'] = '2023-06-01';
  } else if (provider.id !== 'gemini') {
    headers.Authorization = `Bearer ${key}`;
  }
  return headers;
}

function requestJson(url, headers, secret, timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    const request = https.get(url, { headers, timeout: timeoutMs }, (response) => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => {
        body += chunk;
        if (body.length > 4 * 1024 * 1024) request.destroy(new Error('模型列表过大。'));
      });
      response.on('end', () => {
        let data;
        try {
          data = body ? JSON.parse(body) : {};
        } catch {
          reject(new Error('模型服务返回了无法识别的内容。'));
          return;
        }
        if ((response.statusCode || 500) < 200 || (response.statusCode || 500) >= 300) {
          const detail = String(data?.error?.message || data?.message || `HTTP ${response.statusCode}`)
            .replaceAll(secret, '***')
            .slice(0, 180);
          reject(new Error(`Key 验证失败：${detail}`));
          return;
        }
        resolve(data);
      });
    });
    request.on('timeout', () => request.destroy(new Error('连接模型服务超时。')));
    request.on('error', (error) => reject(new Error(String(error.message || error).replaceAll(secret, '***'))));
  });
}

function testCustomModel(baseUrl, key, model, protocol = 'openai') {
  return new Promise((resolve, reject) => {
    const secret = String(key || '').trim();
    const normalizedBaseUrl = normalizeCustomBaseUrl(baseUrl);
    const endpoint = new URL(protocol === 'anthropic' ? `${normalizedBaseUrl}/messages`
      : protocol === 'gemini' ? `${normalizedBaseUrl}/models/${encodeURIComponent(model)}:generateContent`
      : normalizedBaseUrl.endsWith('/chat/completions') ? normalizedBaseUrl : `${normalizedBaseUrl}/chat/completions`);
    const prompt = 'Reply with exactly: NORA_OK';
    const body = JSON.stringify(protocol === 'gemini' ? {
      contents: [{ role: 'user', parts: [{ text: prompt }] }], generationConfig: { maxOutputTokens: 1024 },
    } : {
      model,
      messages: [{ role: 'user', content: prompt }],
      stream: false,
      ...(protocol === 'anthropic' ? { max_tokens: 128 } : {}),
    });
    const transport = endpoint.protocol === 'http:' ? http : https;
    const request = transport.request(endpoint, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        ...(protocol === 'anthropic' ? { 'x-api-key': secret, 'anthropic-version': '2023-06-01' }
          : protocol === 'gemini' ? { 'x-goog-api-key': secret } : { Authorization: `Bearer ${secret}` }),
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        'User-Agent': 'Nora-Tavern-Launcher/0.1',
      },
      timeout: 120000,
    }, (response) => {
      let responseBody = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => {
        responseBody += chunk;
        if (responseBody.length > 4 * 1024 * 1024) request.destroy(new Error('模型回复过大。'));
      });
      response.on('end', () => {
        let payload;
        try {
          payload = responseBody ? JSON.parse(responseBody) : {};
        } catch {
          reject(new Error('中转服务返回了无法识别的内容。'));
          return;
        }
        if ((response.statusCode || 500) < 200 || (response.statusCode || 500) >= 300) {
          const detail = String(payload?.error?.message || payload?.message || `HTTP ${response.statusCode}`)
            .replaceAll(secret, '***')
            .slice(0, 180);
          reject(new Error(`中转模型连接失败：${detail}`));
          return;
        }
        const textParts = parts => Array.isArray(parts) ? parts.filter(part => part && !part.thought && typeof part.text === 'string').map(part => part.text).join('') : '';
        const content = protocol === 'anthropic' ? textParts(payload?.content)
          : protocol === 'gemini' ? textParts(payload?.candidates?.[0]?.content?.parts)
          : payload?.choices?.[0]?.message?.content ?? payload?.choices?.[0]?.text;
        if (typeof content !== 'string' || !content.trim()) {
          reject(new Error('中转服务已响应，但没有返回模型内容。'));
          return;
        }
        resolve({ ok: true });
      });
    });
    request.on('timeout', () => request.destroy(new Error('模型响应超时，请检查中转地址。')));
    request.on('error', (error) => reject(new Error(String(error.message || error).replaceAll(secret, '***'))));
    request.end(body);
  });
}

function testProviderModel(providerId, key, model) {
  requireProvider(providerId);
  const endpoints = {
    openrouter: ['https://openrouter.ai/api/v1', 'openai'],
    deepseek: ['https://api.deepseek.com', 'openai'],
    'openai-api': ['https://api.openai.com/v1', 'openai'],
    anthropic: ['https://api.anthropic.com/v1', 'anthropic'],
    gemini: ['https://generativelanguage.googleapis.com/v1beta', 'gemini'],
  };
  const endpoint = endpoints[providerId];
  if (!endpoint) throw new Error('这个模型服务需要填写自定义接口地址。');
  // A credential test has no agent tools, stored credentials, or fallback model.
  return testCustomModel(endpoint[0], key, model, endpoint[1]);
}

function normalizeModels(provider, payload) {
  const rows = provider.id === 'gemini' ? payload?.models : payload?.data;
  if (!Array.isArray(rows)) return [];
  const values = rows.flatMap((item) => {
    if (!item || typeof item !== 'object') return [];
    if (provider.id === 'gemini') {
      const methods = item.supportedGenerationMethods || [];
      if (!methods.includes('generateContent')) return [];
      return [String(item.name || '').replace(/^models\//, '')];
    }
    return [String(item.id || '')];
  });
  const nonChatOpenAi = /(embedding|whisper|tts|dall-e|image|moderation|transcri|audio|realtime)/i;
  return [...new Set(values.filter((value) => (
    value
    && value.length <= 240
    && (provider.id !== 'openai-api' || !nonChatOpenAi.test(value))
  )))].slice(0, 2000);
}

async function loadProviderModels(providerId, key) {
  const provider = requireProvider(providerId);
  if (provider.custom) throw new Error('请直接输入自定义模型名称。');
  const secret = String(key || '').trim();
  if (!secret || secret.length > 8192 || /[\r\n]/.test(secret)) {
    throw new Error('请输入有效的 API Key。');
  }
  const headers = requestHeaders(provider, secret);
  if (provider.verifyUrl) await requestJson(provider.verifyUrl, headers, secret);
  const modelsUrl = provider.id === 'gemini'
    ? `${provider.modelsUrl}?key=${encodeURIComponent(secret)}&pageSize=1000`
    : provider.modelsUrl;
  const payload = await requestJson(modelsUrl, headers, secret);
  const models = normalizeModels(provider, payload);
  if (!models.length) throw new Error('Key 已连接，但没有读取到可用模型。');
  return { provider: provider.id, keyEnv: provider.keyEnv, models };
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
    provider: value.provider,
    model: value.model,
    keyEnv: value.keyEnv || '',
    ...(value.baseUrl ? { baseUrl: normalizeCustomBaseUrl(value.baseUrl) } : {}),
    verifiedAt: new Date().toISOString(),
  }, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, target);
}

function readVerifiedModel(noraHome) {
  try {
    const value = JSON.parse(fs.readFileSync(verifiedModelPath(noraHome), 'utf8'));
    if (value.schema !== 1 || !PROVIDER_BY_ID.has(value.provider) || !value.model) return null;
    if (value.provider === 'custom') value.baseUrl = normalizeCustomBaseUrl(value.baseUrl);
    return value;
  } catch {
    return null;
  }
}

module.exports = {
  loadProviderModels,
  normalizeCustomBaseUrl,
  normalizeModels,
  publicProviders,
  readVerifiedModel,
  requireProvider,
  testCustomModel,
  testProviderModel,
  writeVerifiedModel,
};
