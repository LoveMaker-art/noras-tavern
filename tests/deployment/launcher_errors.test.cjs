const assert = require('node:assert/strict');
const test = require('node:test');
const { describeError, launcherError } = require('../installer/desktop/launcher-errors');

test('an explicit native process exit retains its classification when the OS status exceeds the wire range', () => {
  const error = launcherError('Native child process failure', {
    code: 'PROCESS_EXIT', source: 'launcher_process', site: 'launcher.window', exitCode: 1073807364,
  });
  const result = describeError(error);
  assert.equal(result.error_code, 'process_failed');
  assert.equal(result.exit_code, null, 'the existing receiver accepts only exit codes from 0 to 65535');
  assert.equal(result.system_code, '', 'PROCESS_EXIT is not added to the receiver system-code contract');
  assert.equal(error.exitCode, 1073807364, 'local evidence retains the complete OS status');
  assert.equal(result.error_source, 'launcher_process');
  assert.equal(result.error_site, 'launcher.window');

  const wrapped = launcherError('Native failure wrapper', {}, error);
  assert.equal(describeError(wrapped).error_code, 'process_failed');
  assert.equal(describeError(wrapped).exit_code, null);
});

test('native process classification preserves bounded exit facts and stronger technical evidence', () => {
  for (const exitCode of [1, 65535]) {
    const result = describeError({ code: 'PROCESS_EXIT', exitCode });
    assert.equal(result.error_code, 'process_failed');
    assert.equal(result.exit_code, exitCode);
  }
  const permission = launcherError('Native failure', { code: 'PROCESS_EXIT', exitCode: 1073807364 },
    Object.assign(new Error('Permission denied'), { code: 'EACCES' }));
  assert.equal(describeError(permission).error_code, 'permission_denied');
  assert.equal(describeError({ code: 'RENDERER_GONE', exitCode: 1073807364 }).error_code, 'renderer_gone');
});

test('unrecognized text or out-of-range numbers do not invent a native process failure', () => {
  for (const error of [{ message: 'PROCESS_EXIT' }, { exitCode: 1073807364 }, { code: 'UNKNOWN_NATIVE_FAILURE' }]) {
    const result = describeError(error);
    assert.equal(result.error_code, 'unknown');
    assert.equal(result.exit_code, null);
  }
});
