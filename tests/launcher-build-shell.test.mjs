import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('native packaging scripts preserve empty optional arguments under the actual platform Bash', t => {
    const caller = fs.readFileSync(path.join(root, '.github/workflows/build-integrated-launcher.yml'), 'utf8');
    assert.ok(caller.includes('uses: ./.github/workflows/launcher-platform-stages.yml'));
    const workflow = fs.readFileSync(path.join(root, '.github/workflows/launcher-platform-stages.yml'), 'utf8');
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'launcher-shell-arguments-'));
    t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
    const capture = path.join(temporary, 'arguments.bin');
    const runtime = path.join(temporary, 'runtime with spaces').replaceAll('\\', '/');
    // Match the workflow shell; Windows PATH may also contain the WSL stub.
    const bash = process.platform === 'win32'
        ? path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Git', 'bin', 'bash.exe') : '/bin/bash';
    assert.ok(fs.existsSync(bash), `Native workflow Bash is unavailable: ${bash}`);
    const script = name => {
        const section = workflow.split(`      - name: ${name}\n`)[1]?.split('\n      - ')[0];
        assert.ok(section, name);
        const block = section.split('        run: |\n')[1];
        assert.ok(block, name);
        return block.trimEnd().split('\n').map(line => line.slice(10)).join('\n')
            .replaceAll('${{ inputs.platform }}', 'darwin').replaceAll('${{ inputs.arch }}', 'arm64');
    };
    const run = (name, env = {}) => {
        fs.writeFileSync(capture, '');
        const output = execFileSync(bash, ['--noprofile', '--norc', '-c',
            'node() { printf "%s\\0" "$@" >> "$NORA_TEST_ARGV_CAPTURE"; }\nprintf "%s\\n" "$PWD"\n' + script(name)], {
            cwd: temporary, encoding: 'utf8', env: { ...process.env,
                NORA_TEST_ARGV_CAPTURE: capture.replaceAll('\\', '/'), RUNNER_TEMP: runtime,
                NORA_APP_ONLY: 'false', PRODUCTION_MODE: 'true', GITHUB_REF_TYPE: 'branch',
                NORA_COMPONENT_PUBLICATION_TAG: '', NORA_UPDATE_COMPATIBILITY_FILE: '',
                LAUNCHER_BASELINE: '', BASELINE_TAG: 'v2.5.2', ...env }, timeout: 10000,
        });
        const args = fs.readFileSync(capture, 'utf8').split('\0');
        assert.equal(args.pop(), '');
        return { cwd: output.trim(), args };
    };
    const payload = 'Build release payload';
    let result = run(payload);
    assert.deepEqual(result.args, [`${result.cwd}/tooling/release/package-release.mjs`, '--hermes-runtime-manifest', `${runtime}/hermes-runtime/nora-hermes-runtime.json`]);
    result = run(payload, { PRODUCTION_MODE: 'false' });
    assert.deepEqual(result.args, [`${result.cwd}/tooling/release/package-release.mjs`, '--candidate', '--hermes-runtime-manifest', `${runtime}/hermes-runtime/nora-hermes-runtime.json`]);
    result = run(payload, { LAUNCHER_BASELINE: 'v2.5.2' });
    assert.deepEqual(result.args, [`${result.cwd}/tooling/release/package-release.mjs`, '--launcher-baseline', `${runtime}/launcher-baseline`]);
    const compatibility = 'tooling/release/compatibility/reviewed file.json';
    result = run(payload, { NORA_APP_ONLY: 'true', LAUNCHER_BASELINE: 'v2.5.2',
        NORA_COMPONENT_PUBLICATION_TAG: 'v2.5.4', NORA_UPDATE_COMPATIBILITY_FILE: compatibility });
    assert.deepEqual(result.args, [`${result.cwd}/tooling/release/package-release.mjs`, '--app-only', '--publication-tag', 'v2.5.4',
        '--update-compatibility', compatibility, '--launcher-baseline', `${runtime}/launcher-baseline`]);
    for (const appOnly of ['false', 'true']) {
        result = run('Download and verify unchanged published components', { NORA_APP_ONLY: appOnly });
        assert.deepEqual(result.args, [`${result.cwd}/tooling/release/launcher-build-baseline.mjs`, 'v2.5.2', 'darwin-arm64',
            `${runtime}/launcher-baseline`, ...(appOnly === 'true' ? ['--app-only'] : [])]);
    }
});

