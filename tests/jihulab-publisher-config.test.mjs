import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {test} from 'node:test';
import * as publisher from '../tooling/release/publish-release.mjs';
import {createJihuTransport} from '../tooling/release/jihulab-transport.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repository = 'LoveMaker-art/noras-tavern';
const source = {id: 'jihulab', provider: 'jihulab',
  baseUrl: 'https://jihulab.com/api/v4/projects/378185/packages/generic/nora-tavern/',
  channelBaseUrl: 'https://jihulab.com/LoveMaker-art/nora-tavern/-/raw/main/'};
const legacy = {schema: 1, primary: 'github', mirrors: [{id: 'sourceforge', provider: 'sourceforge',
  baseUrl: 'https://downloads.sourceforge.net/project/nora-tavern/'}]};
function fixture(t, sources = {schema: 1, primary: 'jihulab', mirrors: [source]}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'nora-publisher-config-'));
  t.after(() => fs.rmSync(directory, {recursive: true, force: true}));
  for (const name of ['release-sources.js', 'launcher-errors.js', 'telemetry-contract.json']) {
    const target = path.join(directory, 'launcher/desktop', name);
    fs.mkdirSync(path.dirname(target), {recursive: true});
    fs.copyFileSync(path.join(root, 'launcher/desktop', name), target);
  }
  fs.writeFileSync(path.join(directory, 'launcher/desktop/release-sources.json'), JSON.stringify(sources));
  const tokenFile = path.join(directory, 'token'), configPath = path.join(directory, 'publisher.json');
  fs.writeFileSync(tokenFile, 'test-private-token\n', {mode: 0o600});
  const config = {projectId: 378185, projectPath: 'LoveMaker-art/nora-tavern', packageName: 'nora-tavern', branch: 'main', tokenFile};
  fs.writeFileSync(configPath, JSON.stringify(config), {mode: 0o600});
  return {directory, configPath, config};
}

test('destination selectors retain legacy all and expose explicit Jihu combinations in canonical order', () => {
  for (const [selector, expected] of Object.entries({all: ['github', 'sourceforge'], github: ['github'],
    jihulab: ['jihulab'], 'github-jihulab': ['github', 'jihulab'],
    'all-with-jihulab': ['github', 'jihulab', 'sourceforge']})) {
    const destinations = publisher.publicationDestinations(selector);
    assert.deepEqual(destinations, expected);
    destinations.push('mutated caller');
    assert.deepEqual(publisher.publicationDestinations(selector), expected);
  }
  assert.deepEqual(publisher.publicationDestinations(), ['github', 'sourceforge']);
  for (const invalid of ['', 'sourceforge', 'unknown', null, ['github'], {}])
    assert.throws(() => publisher.publicationDestinations(invalid), /destinations/i);
});

test('automatic publication includes the primary domestic channel and resumes the original sealed destinations',t=>{
  const f=fixture(t);
  assert.equal(publisher.resolvePublicationDestinationSelection('auto',{sourceRoot:f.directory}),'github-jihulab');
  const file=path.join(f.directory,'launcher/desktop/release-sources.json');
  fs.writeFileSync(file,JSON.stringify({schema:1,mirrors:[source]}));
  assert.equal(publisher.resolvePublicationDestinationSelection('auto',{sourceRoot:f.directory}),'github-jihulab');
  fs.writeFileSync(file,JSON.stringify({schema:1,mirrors:[]}));
  assert.equal(publisher.resolvePublicationDestinationSelection('auto',{sourceRoot:f.directory}),'all');
  assert.equal(publisher.resolvePublicationDestinationSelection('auto',{resumePlan:{destinations:['github']}}),'github');
  assert.equal(publisher.resolvePublicationDestinationSelection('auto',{resumePlan:{}}),'all');
  assert.equal(publisher.resolvePublicationDestinationSelection('all',{sourceRoot:f.directory}),'all');
  fs.writeFileSync(path.join(f.directory,'launcher/desktop/release-sources.json'),JSON.stringify(legacy));
  assert.equal(publisher.resolvePublicationDestinationSelection('auto',{sourceRoot:f.directory}),'all');
  assert.throws(()=>publisher.resolvePublicationDestinationSelection('auto',{resumePlan:{destinations:['unknown']}}),/destinations/);
});

test('Jihu roots come from the current build-owned JSON and its shared validator', t => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.directory, 'release-manifest.json'), JSON.stringify({source: {baseUrl: 'https://evil.example/'}}));
  assert.deepEqual(publisher.buildOwnedJihuSource(f.directory), source);
  const configuration = path.join(f.directory, 'launcher/desktop/release-sources.json');
  fs.writeFileSync(configuration, JSON.stringify(legacy));
  assert.throws(() => publisher.buildOwnedJihuSource(f.directory), /build-owned.*Jihu|Jihu.*configured/i);
  fs.writeFileSync(configuration, JSON.stringify({schema: 1, mirrors: [{...source, baseUrl: 'https://evil.example/packages/'}]}));
  assert.throws(() => publisher.buildOwnedJihuSource(f.directory), /来源配置/);
});

test('seal validates configured roots without constructing any transport or reading credential paths', t => {
  const f = fixture(t);
  const environment = new Proxy({}, {get() {throw new Error('Seal must not read credentials');}});
  const providers = publisher.publicationProviders({stage: 'seal', destinations: 'all-with-jihulab', repository,
    sourceRoot: f.directory, environment}, {createTransport() {throw new Error('Seal must not build a transport');}});
  assert.equal(providers, undefined);
  const missing = fixture(t, legacy);
  assert.throws(() => publisher.publicationProviders({stage: 'seal', destinations: 'jihulab', repository,
    sourceRoot: missing.directory, environment}), /build-owned.*Jihu|Jihu.*configured/i);
});

test('GitHub-only preparation does not need Jihu roots or a Jihu token', () => {
  const environment = new Proxy({}, {get() {throw new Error('GitHub-only must not read other credentials');}});
  const providers = publisher.publicationProviders({stage: 'prepare', destinations: 'github', repository,
    sourceRoot: '/no-jihu-config-needed', environment}, {createTransport() {throw new Error('Unexpected Jihu transport');}});
  assert.deepEqual(Object.keys(providers), ['github']);
  assert.equal(typeof providers.github.begin, 'function');
});

test('prepare and promote forward only the protected config path and the validated source into the real adapter', async t => {
  const f = fixture(t);
  for (const stage of ['prepare', 'promote']) {
    const calls = [];
    const createTransport = (input, options) => {
      calls.push({input, options});
      return {preflight: async () => calls.push('gate'), verifyIdentity: async () => {},
        upload: async () => {}, readPublic: async () => {}, verifyObject: async () => {},
        channelPromotion: {check: async () => calls.push('promotion-gate'), promote: async () => {}, verify: async () => {}}};
    };
    const providers = publisher.publicationProviders({stage, destinations: 'github-jihulab', repository,
      sourceRoot: f.directory, environment: {NORA_JIHULAB_UPLOAD_CONFIG: f.configPath,
        NORA_JIHULAB_BASE_URL: 'https://evil.example/'}}, {createTransport});
    assert.deepEqual(Object.keys(providers).sort(), ['github', 'jihulab']);
    assert.equal(calls[0].input, f.configPath);
    assert.deepEqual(calls[0].options.source, source);
    assert.deepEqual(Object.keys(calls[0].options), ['source']);
    if (stage === 'prepare') await providers.jihulab.begin({plan: {}});
    else await providers.jihulab.checkPromotion({plan: {channel: 'stable', objects: [{phase: 'channel', key: 'channels/stable.json'}]}});
    assert.ok(calls.includes(stage === 'prepare' ? 'gate' : 'promotion-gate'));
  }
});

test('a protected uploader identity cannot replace the build-owned project or package root', t => {
  const f = fixture(t);
  for (const changes of [{projectId: 1}, {packageName: 'other'}, {branch: 'other'}]) {
    fs.writeFileSync(f.configPath, JSON.stringify({...f.config, ...changes}));
    assert.throws(() => publisher.publicationProviders({stage: 'prepare', destinations: 'jihulab', repository,
      sourceRoot: f.directory, environment: {NORA_JIHULAB_UPLOAD_CONFIG: f.configPath}}), /root.*identity/i);
  }
});

test('real transport project-policy rejection occurs before any publisher write', async t => {
  const f = fixture(t), calls = [];
  const providers = publisher.publicationProviders({stage: 'prepare', destinations: 'jihulab', repository,
    sourceRoot: f.directory, environment: {NORA_JIHULAB_UPLOAD_CONFIG: f.configPath}}, {
    createTransport: (input, options) => createJihuTransport(input, {...options, fetcher: async (url, request = {}) => {
      calls.push({url, method: request.method || 'GET'});
      return new Response('{}', {status: 404});
    }, log: () => {}}),
  });
  await assert.rejects(providers.jihulab.begin({plan: {}}), /Jihu|project|HTTP/i);
  assert.ok(calls.length > 0);
  assert.ok(calls.every(call => call.method === 'GET' && String(call.url).startsWith('https://jihulab.com/api/')));
});
