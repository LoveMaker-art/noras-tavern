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
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nora-complete-smoke-'));
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
    XDG_CACHE_HOME: path.join(root, 'cache'), XDG_DATA_HOME: path.join(root, 'data'),
    APPDATA: path.join(root, 'appdata'), LOCALAPPDATA: path.join(root, 'localappdata'),
    TMP: root, TEMP: root, TMPDIR: root, PYTHONDONTWRITEBYTECODE: '1', PYTHONNOUSERSITE: '1',
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
    const installer = process.argv.includes('--source-installer') ? path.resolve(__dirname, '../installer/first_install.py')
      : path.join(payload, 'nora-tavern-first-install-bootstrap.py');
    const output = run([installer,
      '--nora-home', root, '--hermes-home', home, '--install-root', tavern,
      '--port', String(port), '--release-dir', payload, '--allow-candidate',
      '--skip-liveware', '--dedicated-nora', '--apply', '--confirm']);
    assert.ok(output.includes('installed'), output.slice(-3000));
    const events = output.split('\n').filter(line => line.startsWith('{"event"')).map(line => JSON.parse(line));
    assert.equal(events.some(event => event.event === 'milestone' && event.index === 4 && event.state === 'done'), false);
    const response = await fetch(`http://127.0.0.1:${port}/`);
    assert.equal(response.status, 200);
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
    assert.equal(status.setupCompleted, false);
    assert.equal(status.version, receipt.version);
    const cron = run(['-c', `
import json, os
from pathlib import Path
from cron.scheduler_script import _run_job_script
home = Path(os.environ['HERMES_HOME'])
fixture = home / 'release-fixture.json'
fixture.write_text(json.dumps({'tag_name': ${JSON.stringify(receipt.version)}}))
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
