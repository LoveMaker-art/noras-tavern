const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  loadProviderModels,
  normalizeCustomBaseUrl,
  normalizeModels,
  publicProviders,
  readVerifiedModel,
  testCustomModel,
  writeVerifiedModel,
} = require('../installer/desktop/model-config');

test('exposes only the supported API-key providers', () => {
  const providers = publicProviders();
  assert.deepEqual(providers.map((provider) => provider.id), [
    'openrouter', 'deepseek', 'anthropic', 'openai-api', 'gemini', 'custom',
  ]);
  assert.equal(providers.some((provider) => provider.id === 'nous'), false);
  assert.ok(providers.filter((provider) => !provider.custom).every((provider) => provider.keyEnv && provider.signupUrl));
  assert.deepEqual(providers.at(-1), {
    id: 'custom',
    label: '自定义模型',
    keyEnv: '',
    signupUrl: '',
    recommended: undefined,
    custom: true,
  });
});

test('normalizes OpenAI-compatible and Gemini model responses', () => {
  const [openrouter, , , , gemini] = publicProviders();
  assert.deepEqual(normalizeModels(openrouter, { data: [{ id: 'a/model' }, { id: 'a/model' }, { id: '' }] }), ['a/model']);
  assert.deepEqual(normalizeModels(gemini, { models: [
    { name: 'models/gemini-pro', supportedGenerationMethods: ['generateContent'] },
    { name: 'models/embed', supportedGenerationMethods: ['embedContent'] },
  ] }), ['gemini-pro']);
  const openai = publicProviders().find((provider) => provider.id === 'openai-api');
  assert.deepEqual(normalizeModels(openai, { data: [
    { id: 'gpt-5' }, { id: 'text-embedding-3-large' }, { id: 'gpt-image-1' },
  ] }), ['gpt-5']);
});

test('rejects an empty key before making a network request', async () => {
  await assert.rejects(loadProviderModels('openrouter', ''), /API Key/);
});

test('normalizes and validates a custom OpenAI-compatible endpoint', () => {
  assert.equal(normalizeCustomBaseUrl('https://relay.example/v1///'), 'https://relay.example/v1');
  assert.throws(() => normalizeCustomBaseUrl('ftp://relay.example/v1'), /HTTP\/HTTPS/);
  assert.throws(() => normalizeCustomBaseUrl('https://user:pass@relay.example/v1'), /账号信息/);
});

test('tests a custom model through the OpenAI-compatible chat endpoint', async () => {
  let requestBody = '';
  let requestPath = '';
  let authorization = '';
  const server = http.createServer((request, response) => {
    requestPath = request.url;
    authorization = request.headers.authorization;
    request.setEncoding('utf8');
    request.on('data', (chunk) => { requestBody += chunk; });
    request.on('end', () => {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ choices: [{ message: { content: 'NORA_OK' } }] }));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const { port } = server.address();
    await testCustomModel(`http://127.0.0.1:${port}/v1`, 'relay-key', 'relay-model');
    assert.equal(requestPath, '/v1/chat/completions');
    assert.equal(authorization, 'Bearer relay-key');
    assert.equal(JSON.parse(requestBody).model, 'relay-model');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('verified model marker contains no secret', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nora-model-marker-'));
  try {
    writeVerifiedModel(root, {
      provider: 'deepseek',
      model: 'deepseek-chat',
      keyEnv: 'DEEPSEEK_API_KEY',
      key: 'must-not-be-written',
    });
    const text = fs.readFileSync(path.join(root, 'installer', 'model.json'), 'utf8');
    assert.doesNotMatch(text, /must-not-be-written/);
    assert.equal(readVerifiedModel(root).model, 'deepseek-chat');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

for (const provider of ['custom', 'custom:local-(127.0.0.1:8080)']) test(`${provider} marker stores its endpoint without storing the key`, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nora-custom-model-marker-'));
  try {
    writeVerifiedModel(root, {
      provider,
      model: 'relay-model',
      baseUrl: 'https://relay.example/v1/',
      key: 'must-not-be-written',
    });
    const text = fs.readFileSync(path.join(root, 'installer', 'model.json'), 'utf8');
    assert.doesNotMatch(text, /must-not-be-written/);
    assert.equal(readVerifiedModel(root).baseUrl, 'https://relay.example/v1');
    assert.equal(readVerifiedModel(root).provider, provider);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

for (const protocol of ['anthropic', 'gemini']) {
  test(`${protocol} credential test uses the native request format without tools`, async () => {
    let captured;
    const server = http.createServer((request, response) => {
      let body = '';
      request.on('data', chunk => { body += chunk; });
      request.on('end', () => {
        captured = { url: request.url, headers: request.headers, body: JSON.parse(body) };
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify(protocol === 'anthropic' ? { content: [{ type: 'text', text: 'NORA_OK' }] }
          : { candidates: [{ content: { parts: [{ text: 'NORA_OK' }] } }] }));
      });
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
      await testCustomModel(`http://127.0.0.1:${server.address().port}/v1`, 'test-secret', 'test-model', protocol);
      assert.equal(captured.headers[protocol === 'anthropic' ? 'x-api-key' : 'x-goog-api-key'], 'test-secret');
      assert.ok(!captured.body.tools);
      assert.ok(!captured.url.includes('test-secret'));
      assert.equal(captured.url, protocol === 'anthropic' ? '/v1/messages' : '/v1/models/test-model:generateContent');
    } finally { await new Promise(resolve => server.close(resolve)); }
  });
}
