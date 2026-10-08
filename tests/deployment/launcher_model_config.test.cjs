const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { spawnSync } = require('node:child_process');

const {
  loadProviderModels,
  modelCredential,
  NO_AUTH_KEY,
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

test('invalid header characters are rejected as key input before list and protocol test requests', async () => {
  const {failureResult}=require('../installer/desktop/operation-result');
  const base='http://127.0.0.1:1/v1';
  for(const key of ['fake-密钥', 'fake-\u0001-key', 'fake-\r\n-key']) {
    for(const work of [()=>loadProviderModels('custom',key,base),
      ...['openai','anthropic','gemini'].map(protocol=>()=>testCustomModel(base,key,'fixture',protocol))]) {
      await assert.rejects(async()=>work(), error=>{
        assert.equal(error.userCode,'MODEL_KEY_INVALID');
        const result=failureResult(error,{action:'model'});
        assert.match(result.error.guidance.title,/API Key/);
        assert.match(result.error.guidance.next,/重新复制/);
        assert.doesNotMatch(JSON.stringify(result),/fake-|ERR_INVALID_CHAR|原因尚未确认/);
        return true;
      });
    }
  }
});

test('no-auth is explicit and cannot bypass a cloud provider key requirement', () => {
  const custom = publicProviders().find(p => p.custom);
  assert.equal(modelCredential(custom, { authMode: 'none' }), NO_AUTH_KEY);
  assert.throws(() => modelCredential(custom, {}), /API Key/);
  assert.throws(() => modelCredential(publicProviders()[0], { authMode: 'none' }), /API Key/);
});

test('local custom endpoint lists models and tests content without an Authorization header', async () => {
  const seen = [];
  const server = http.createServer((req, res) => {
    seen.push([req.url, req.headers.authorization]);
    req.resume();
    req.on('end', () => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(req.url.endsWith('/models') ? { data: [{ id: 'local-test' }] }
        : { choices: [{ message: { content: 'NORA_OK' } }] }));
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const base = `http://127.0.0.1:${server.address().port}/v1`;
    assert.deepEqual((await loadProviderModels('custom', '', base, 'none')).models, ['local-test']);
    assert.equal((await testCustomModel(base, NO_AUTH_KEY, 'local-test')).toolSupport, 'unverified');
    assert.deepEqual(seen, [['/v1/models', undefined], ['/v1/chat/completions', undefined]]);
  } finally { await new Promise(resolve => server.close(resolve)); }
});

test('local service refusal points to model service, not an invalid key', async () => {
  const server = http.createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  await assert.rejects(testCustomModel(`http://127.0.0.1:${port}/v1`, NO_AUTH_KEY, 'local'), /先启动 Ollama/);
});

for (const action of ['list', 'test']) test(`an interrupted ${action} response becomes a request failure without crashing the launcher`, () => {
  const script = `
    const http = require('node:http');
    const model = require(process.argv[1]);
    const server = http.createServer((request, response) => {
      request.resume();
      response.writeHead(200, {'Content-Type':'application/json'});
      response.write('{"partial":');
      setTimeout(() => response.destroy(), 10);
    });
    const deadline = setTimeout(() => process.exit(3), 2000);
    server.listen(0, '127.0.0.1', async () => {
      const base = 'http://127.0.0.1:' + server.address().port + '/v1';
      try {
        await (${JSON.stringify(action)} === 'list'
          ? model.loadProviderModels('custom', '', base, 'none')
          : model.testCustomModel(base, model.NO_AUTH_KEY, 'fixture-model'));
        process.exitCode = 2;
      } catch (error) {
        if (error.code !== 'ECONNRESET' || error.source !== 'model_service'
            || error.site !== ${JSON.stringify(action === 'list' ? 'model.list' : 'model.test')}) process.exitCode = 4;
        else process.stdout.write('REQUEST_FAILURE_CAPTURED\\n');
      } finally { clearTimeout(deadline); server.close(); }
    });
  `;
  const result = spawnSync(process.execPath, ['-e', script, require.resolve('../installer/desktop/model-config')],
    {encoding:'utf8', timeout:5000});
  assert.equal(result.status, 0, result.stderr || `fixture exit ${result.status}`);
  assert.match(result.stdout, /REQUEST_FAILURE_CAPTURED/);
});

test('response interruption handling preserves the model response size limit', async () => {
  const server = http.createServer((request, response) => {
    request.resume();
    response.writeHead(200, {'Content-Type':'application/json'});
    response.end('x'.repeat(4 * 1024 * 1024 + 1));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const base = `http://127.0.0.1:${server.address().port}/v1`;
    await assert.rejects(loadProviderModels('custom', '', base, 'none'), {code:'RESPONSE_TOO_LARGE'});
    await assert.rejects(testCustomModel(base, NO_AUTH_KEY, 'fixture-model'), {code:'RESPONSE_TOO_LARGE'});
  } finally { await new Promise(resolve => server.close(resolve)); }
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
