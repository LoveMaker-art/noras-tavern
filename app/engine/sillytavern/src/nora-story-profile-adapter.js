import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const adapterPath = fileURLToPath(new URL('../../../story_profile_runtime/adapters/nora/cli.py', import.meta.url));

export function runStoryProfileAdapter(command, payload, { env = process.env } = {}) {
    const input = payload === undefined ? '' : JSON.stringify(payload);
    return new Promise((resolve, reject) => {
        const child = spawn(env.TAVERN_PYTHON || 'python3', [adapterPath, command], {
            env,
            stdio: ['pipe', 'pipe', 'pipe'],
        });
        let stdout = '';
        let stderr = '';
        let stdoutBytes = 0;
        let stderrBytes = 0;
        let settled = false;
        let closed = false;
        let killTimer;
        // Reflection can perform three 90-second model calls. This is a total
        // process deadline, unlike Python's per-socket timeout.
        const timeoutMs = ['reflect', 'reflect-preview', 'learn', 'refresh-taste'].includes(command) ? 360_000 : 30_000;
        const deadline = setTimeout(() => fail(new Error('Story Profile adapter deadline exceeded.')), timeoutMs);
        function fail(error) {
            if (settled) return;
            settled = true;
            clearTimeout(deadline);
            if (!closed) {
                child.kill('SIGTERM');
                killTimer = setTimeout(() => { if (!closed) child.kill('SIGKILL'); }, 1000);
            }
            reject(error);
        }
        child.stdout.setEncoding('utf8');
        child.stderr.setEncoding('utf8');
        child.stdout.on('data', chunk => {
            if (settled) return;
            stdoutBytes += Buffer.byteLength(chunk);
            if (stdoutBytes > 16 * 1024 * 1024) return fail(new Error('Story Profile adapter output limit exceeded.'));
            stdout += chunk;
        });
        child.stderr.on('data', chunk => {
            if (settled) return;
            stderrBytes += Buffer.byteLength(chunk);
            if (stderrBytes > 256 * 1024) return fail(new Error('Story Profile adapter output limit exceeded.'));
            stderr += chunk;
        });
        child.on('error', fail);
        child.stdin.on('error', fail);
        child.on('close', (code, signal) => {
            closed = true;
            clearTimeout(deadline);
            clearTimeout(killTimer);
            if (settled) return;
            if (signal || code === null) return fail(new Error('Story Profile adapter terminated before completion.'));
            try {
                const value = JSON.parse(stdout || '{}');
                settled = true;
                resolve({ code, value, stderr });
            } catch {
                fail(new Error('Story Profile adapter returned invalid JSON.'));
            }
        });
        child.stdin.end(input);
    });
}
