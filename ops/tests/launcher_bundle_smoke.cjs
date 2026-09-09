// Real payload test: no model key, activation code, or existing user installation.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawnSync } = require('node:child_process');
const { installBundledHermes, validateRuntimeLinks } = require('../installer/desktop/runtime');

async function main() {
  if (!process.argv[2]) throw new Error('Pass the candidate launcher payload directory');
  const payload = path.resolve(process.argv[2]);
  const runtimeOnly = process.argv.includes('--runtime-only');
  const release = runtimeOnly ? {} : JSON.parse(fs.readFileSync(path.join(payload, 'nora-system.json'), 'utf8'));
  const testBase = process.platform === 'win32'
    ? path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'NoraTavern-Tests')
    : os.tmpdir();
  fs.mkdirSync(testBase, { recursive: true });
  // Match the desktop candidate home depth, including the isolated cache directory.
  const root = fs.mkdtempSync(path.join(testBase, 'launcher-candidate-000000'));
  const temporary = path.join(root, 'cache', 'tmp');
  fs.mkdirSync(temporary, { recursive: true });
  const home = path.join(root, 'hermes');
  const tavern = path.join(root, 'tavern');
  const server = net.createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  console.log(`Isolated test: ${root}, port: ${port}`);
  let python;
  const env = {
    HOME: home, USERPROFILE: home, HERMES_HOME: home, NORA_HERMES_HOME: home,
    NORA_TAVERN_HOME: root, TAVERN_DATA_ROOT: tavern,
    NORA_RELEASE_CHANNEL: release.channel || 'stable',
    XDG_CACHE_HOME: path.join(root, 'cache'), XDG_DATA_HOME: path.join(root, 'data'),
    APPDATA: path.join(root, 'appdata'), LOCALAPPDATA: path.join(root, 'localappdata'),
    TMP: temporary, TEMP: temporary, TMPDIR: temporary, PYTHONDONTWRITEBYTECODE: '1', PYTHONNOUSERSITE: '1',
    PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8',
    SystemRoot: process.env.SystemRoot || '', WINDIR: process.env.WINDIR || '',
    PYTHONPATH: path.join(home, 'hermes-agent'),
    PATH: [path.join(home, 'clawchat/liveware'), path.join(home, '.local/bin'), path.join(home, 'node/bin'), path.join(home, 'node'),
      path.join(home, 'hermes-agent/venv/bin'), process.env.PATH || ''].join(path.delimiter),
  };
  const run = (args, timeout = 180000) => {
    const result = spawnSync(python, ['-B', ...args], { env, encoding: 'utf8', timeout });
    assert.equal(result.status, 0, result.error?.message || result.stderr || result.stdout);
    return result.stdout;
  };
  try {
    const manifest = installBundledHermes({ payloadRoot: payload, noraHome: root, hermesHome: home,
      onEvent: event => console.log(event.task) });
    python = path.join(home, manifest.venvPython);
    validateRuntimeLinks(home);
    const envLines = fs.readFileSync(path.join(home, '.env'), 'utf8').trim().split('\n').filter(Boolean);
    assert.ok(envLines.every(line => line === 'CLAWCHAT_ALLOW_ALL_USERS=true'), 'Unexpected credential/config in fresh install');
    const probe = run([path.join(home, manifest.componentProbe)], 60000);
    const readiness = JSON.parse(probe.trim().split('\n').pop());
    assert.equal(readiness.ok, true);
    console.log(JSON.stringify(readiness));
    if (runtimeOnly) {
      console.log('PASS: bundled runtime works without the original Hermes build directory');
      return;
    }
    const installer = process.argv.includes('--source-installer') ? path.resolve(__dirname, '../installer/first_install.py')
      : path.join(payload, 'nora-tavern-first-install-bootstrap.py');
    const output = run([installer,
      '--nora-home', root, '--hermes-home', home, '--install-root', tavern,
      '--port', String(port), '--release-dir', payload, '--allow-candidate',
      '--skip-liveware', '--dedicated-nora', '--apply', '--confirm']);
    assert.ok(output.includes('installed'), output.slice(-3000));
    const events = output.split('\n').filter(line => line.startsWith('{"event"')).map(line => JSON.parse(line));
    assert.equal(events.some(event => event.event === 'milestone' && event.index === 4 && event.state === 'done'), false);
    const noraDone = events.findIndex(event => event.event === 'milestone' && event.index === 0 && event.state === 'done');
    const tavernBegin = events.findIndex(event => event.event === 'milestone' && event.index === 1 && event.state === 'running');
    assert.ok(noraDone >= 0 && tavernBegin > noraDone, 'Nora must light before Tavern installation');
    const response = await fetch(`http://127.0.0.1:${port}/`);
    assert.equal(response.status, 200);
    const userRoot = path.join(tavern, 'tavern-state/native/default-user');
    const welcome = JSON.parse(fs.readFileSync(path.join(userRoot, 'nora-world-core/builtin-welcome.json'), 'utf8'));
    assert.equal(welcome.status, 'complete');
    const bootstrapResponse = await fetch(`http://127.0.0.1:${port}/api/nora-boot/bootstrap`);
    assert.equal(bootstrapResponse.status, 200);
    assert.equal((await bootstrapResponse.json()).lastWorldId, welcome.worldId);
    const worldFiles = fs.readdirSync(path.join(userRoot, 'nora-world-core/worlds'));
    const welcomeWorld = worldFiles.map(file => JSON.parse(fs.readFileSync(path.join(userRoot, 'nora-world-core/worlds', file), 'utf8')))
      .find(world => world.world_id === welcome.worldId);
    assert.equal(welcomeWorld.name, '新手引导');
    const session = welcomeWorld.sessions.items.find(item => item.session_id === welcomeWorld.sessions.default_session_id);
    const chatFile = path.join(userRoot, 'chats', path.parse(session.binding.avatar).name, `${session.binding.chat_id}.jsonl`);
    const chat = fs.readFileSync(chatFile, 'utf8').trim().split('\n').map(line => JSON.parse(line));
    const expectedOpening = fs.readFileSync(path.join(tavern, 'apps/tavern-runtime/engine/sillytavern/src/nora-world-core/builtin/welcome-zh.md'), 'utf8').trim();
    assert.equal(chat.length, 2);
    assert.equal(chat[1].mes, expectedOpening);
    assert.ok(expectedOpening.includes('欢迎来到酒馆。'));
    console.log('PASS: installed Tavern creates the Chinese welcome and bootstrap selects it');
    const receipt = JSON.parse(fs.readFileSync(path.join(tavern, 'tavern-updates/installed.json'), 'utf8'));
    const system = JSON.parse(fs.readFileSync(path.join(tavern, 'tavern-updates/nora-system.json'), 'utf8'));
    assert.ok(receipt.version);
    assert.equal(system.proof.hermesContext, true);
    assert.equal(system.proof.mcpInstanceRead, true);
    assert.equal(system.proof.managedConfiguration, true);
    assert.equal(system.proof.clawchatRegistration, true);
    assert.equal(system.setupCompleted, false, 'Model and ClawChat have not been configured');
    assert.ok(fs.readFileSync(path.join(home, 'SOUL.md'), 'utf8').includes('你是 Nora'));
    const status = JSON.parse(run([path.resolve(__dirname, '../installer/launcher_bridge.py'),
      '--nora-home', root, '--hermes-home', home, '--install-root', tavern, '--port', String(port), 'status']).trim());
    assert.equal(status.systemReady, true, JSON.stringify(status.systemProblems));
    assert.equal(status.noraInstalled, true);
    const greeting = fs.readFileSync(path.join(home, 'clawchat/greeting.md'), 'utf8');
    for (const phrase of ['我叫诺拉。', '陈屿的苏州雨巷', '许清禾的厦门海风', 'nora-instance.py', 'app-link']) assert.ok(greeting.includes(phrase));
    assert.equal(greeting.includes('tavern_cli.py'), false);
    assert.equal(fs.existsSync(path.join(tavern, 'tavern-state/imports')), false, 'Samples must not be pre-imported');
    console.log(run([path.resolve(__dirname, 'verify_starter_stories.py')], 120000).trim());
    assert.equal(status.setupCompleted, false);
    assert.equal(status.version, receipt.version);
    const cron = run(['-c', `
import json, os
from pathlib import Path
from cron.scheduler_script import _run_job_script
home = Path(os.environ['HERMES_HOME'])
fixture = home / 'release-fixture.json'
release = {'tag_name': ${JSON.stringify(receipt.version)}, 'prerelease': True, 'draft': False}
fixture.write_text(json.dumps([release] if os.environ['NORA_RELEASE_CHANNEL'] == 'beta' else release))
os.environ['TAVERN_RELEASE_API_URL'] = fixture.as_uri()
ok, output = _run_job_script('nora-tavern-update-check.py')
assert ok, output
print('PASS: actual Hermes cron script execution, local release fixture, no model or notification')
`]);
    console.log(cron.trim());
    console.log('PASS: real runtime, Nora identity / skills / Hook loader, ClawChat registration, cron execution, MCP instance read; setup still pending');
  } finally {
    const lifecycle = path.join(tavern, 'apps/tavern-runtime/native_lifecycle.py');
    if (python && fs.existsSync(lifecycle)) {
      run(['-c', 'from pathlib import Path; import sys; from ops.installer.first_install import stop_install_runtime; stop_install_runtime(Path(sys.argv[1]))', tavern], 30000);
      console.log('Test Tavern stopped');
    }
    fs.rmSync(root, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
