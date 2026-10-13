const {test, after} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const source = fs.existsSync(path.resolve(__dirname, '../../launcher/desktop/release-network.js'))
  ? path.resolve(__dirname, '../../launcher/desktop') : path.resolve(__dirname, '../installer/desktop');
const modules = fs.mkdtempSync(path.join(os.tmpdir(), 'nora-static-catalogue-'));
for (const name of ['release-network.js', 'release-sources.js', 'release-sources.json', 'launcher-errors.js', 'telemetry-contract.json'])
  fs.copyFileSync(path.join(source, name), path.join(modules, name));
fs.copyFileSync(fs.existsSync(path.join(source, 'releases.js')) ? path.join(source, 'releases.js')
  : path.resolve(__dirname, '../../deployment/update/releases.js'), path.join(modules, 'releases.js'));
fs.cpSync(path.join(source, 'node_modules/semver'), path.join(modules, 'node_modules/semver'), {recursive:true});
after(() => fs.rmSync(modules, {recursive:true, force:true}));
const releases = require(path.join(modules, 'releases'));

test('a complete static beta catalogue never requires GitHub pagination even with 100 releases', async () => {
  const calls = [];
  const rows = Array.from({length:100}, (_, index) => ({tag_name:`v3.0.0-beta.${index + 1}`,
    draft:false, prerelease:true, assets:[]}));
  const fetcher = async value => {
    calls.push(String(value));
    assert.equal(String(value), 'https://distribution.example/channels/beta.json', 'no GitHub request is permitted');
    const response = Response.json(rows);
    Object.defineProperty(response, 'url', {value:String(value)});
    return response;
  };
  const result = await releases.latest(fetcher, undefined, 'beta', undefined, {networkPolicy:{maxAttempts:1,
    sources:{schema:1, mirrors:[{id:'domestic', baseUrl:'https://distribution.example/'}]}}});
  assert.equal(result.tag_name, 'v3.0.0-beta.100');
  assert.deepEqual(calls, ['https://distribution.example/channels/beta.json']);
});

test('stable discovery succeeds through a static catalogue with GitHub completely unavailable', async () => {
  const calls = [];
  const fetcher = async value => {
    calls.push(String(value));
    assert.equal(String(value), 'https://distribution.example/channels/stable.json');
    const response = Response.json({tag_name:'v3.0.0', draft:false, prerelease:false, assets:[]});
    Object.defineProperty(response, 'url', {value:String(value)});
    return response;
  };
  const result = await releases.latest(fetcher, undefined, 'stable', undefined, {networkPolicy:{maxAttempts:1,
    sources:{schema:1, mirrors:[{id:'domestic', baseUrl:'https://distribution.example/'}]}}});
  assert.equal(result.tag_name, 'v3.0.0');
  assert.equal(calls.length, 1);
});
