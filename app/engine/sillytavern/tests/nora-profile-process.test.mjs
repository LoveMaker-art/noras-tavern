import assert from 'node:assert/strict';
import fs from 'node:fs';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import test from 'node:test';

function fixture() {
    const source = fs.readFileSync(new URL('../src/nora-story-profile-adapter.js', import.meta.url), 'utf8');
    const start = source.indexOf('export function runStoryProfileAdapter(');
    const child = Object.assign(new EventEmitter(), {
        stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
        killed: [], kill(signal) { this.killed.push(signal); return true; },
    });
    const timers = [];
    const delays = [];
    const run = new Function('spawn', 'adapterPath', 'setTimeout', 'clearTimeout', `${source.slice(start).replace('export function', 'function')}; return runStoryProfileAdapter;`)(
        () => child, 'fixture.py', (callback, delay) => { timers.push(callback); delays.push(delay); return timers.length; }, () => {},
    );
    return { child, timers, delays, run };
}

test('paid reflection preview uses the model deadline, not the short read deadline', async () => {
    const { child, delays, run } = fixture();
    const pending = run('reflect-preview', {});
    assert.equal(delays[0], 360000);
    child.stdout.write('{}'); child.emit('close', 0);
    await pending;
});

test('Story Profile child process has a wall-clock deadline and termination escalation', async () => {
    const { child, timers, run } = fixture();
    const pending = run('reflect', {});
    assert.ok(timers.length, 'a socket timeout in Python is not a total process deadline');
    const rejected = assert.rejects(pending, /deadline/);
    timers[0]();
    await rejected;
    assert.deepEqual(child.killed, ['SIGTERM']);
    timers[1]();
    assert.deepEqual(child.killed, ['SIGTERM', 'SIGKILL']);
    child.emit('close', null, 'SIGKILL');
});

test('Story Profile child signal exit is not reported as successful code zero', async () => {
    const { child, run } = fixture();
    const pending = run('reflect', {});
    const rejected = assert.rejects(pending, /terminated/);
    child.emit('close', null, 'SIGTERM');
    await rejected;
});

test('Story Profile output is bounded without echoing raw child output', async () => {
    const { child, run } = fixture();
    const pending = run('reflect', {});
    const rejected = assert.rejects(pending, /output limit/);
    child.stderr.write('x'.repeat(256 * 1024 + 1));
    await rejected;
    child.emit('close', 1);
});
