const { test } = require('node:test');
const assert = require('node:assert/strict');
const { renderReleaseNotes } = require('../tooling/release/launcher-release-notes.cjs');
const inputs = {
  repository: 'LoveMaker-art/noras-tavern', tag: 'v2.2.12',
  assetNames: ['mac-arm64.dmg', 'mac-x64.dmg', 'win-x64-setup.exe']
    .map(suffix => `Nora-Tavern-Launcher-0.4.0-${suffix}`),
  notes: '# Release\n\n## 下载\n\nOld filenames.\n\n## 本次更新\n\nKeep this change.\n\n## 安全提醒\n\nKeep this warning.\n',
};

test('release notes contain only the authored summary, without generated download instructions', () => {
  const notes = '# Release\n\n## 本次更新\n\nKeep this change.\n\n## 安全提醒\n\nKeep this warning.\n';
  const result = renderReleaseNotes({ ...inputs, notes });
  assert.equal(result, notes);
  assert.equal(renderReleaseNotes({ ...inputs, notes: result }), result);
});

test('authored sections are preserved without rewriting historical release notes', () => {
  const result = renderReleaseNotes(inputs);
  assert.equal(result, inputs.notes);
  assert.equal(renderReleaseNotes({ ...inputs, notes: result }), result);
});

test('missing, duplicated or portable-only installers stop note generation', () => {
  assert.throws(() => renderReleaseNotes({ ...inputs, assetNames: inputs.assetNames.slice(1) }), /exactly one installer/);
  assert.throws(() => renderReleaseNotes({ ...inputs, assetNames: [...inputs.assetNames, inputs.assetNames[0]] }), /exactly one installer/);
  assert.throws(() => renderReleaseNotes({ ...inputs, assetNames: inputs.assetNames.map(name => name + '.zip') }), /exactly one installer/);
});

test('beta releases preserve only their authored testing notice', () => {
  const result = renderReleaseNotes({ ...inputs, tag: 'v2.2.12-beta.1', notes: '# Beta\n\nTesting notice.\n' });
  assert.equal(result, '# Beta\n\nTesting notice.\n');
});

test('invalid release identities and empty summaries fail closed', () => {
  assert.throws(() => renderReleaseNotes({ ...inputs, repository: 'https://example.invalid' }));
  assert.throws(() => renderReleaseNotes({ ...inputs, tag: 'latest' }));
  assert.throws(() => renderReleaseNotes({ ...inputs, installerTag: 'latest' }));
  assert.throws(() => renderReleaseNotes({ ...inputs, notes: '  ' }), /summary/);
});

test('component updates do not append baseline installer reminders', () => {
  const result = renderReleaseNotes({ ...inputs, tag: 'v2.3.1', installerTag: 'v2.3.0' });
  assert.equal(result, inputs.notes);
});

test('v2.3.5 contains changes and relevant notices, not installation guidance', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const notes = fs.readFileSync(path.join(__dirname, '../docs/releases/v2.3.5.md'), 'utf8');
  const result = renderReleaseNotes({ ...inputs, tag: 'v2.3.5', installerTag: 'v2.3.3', notes });
  assert.equal(result, notes);
  assert.match(result, /## 本次更新/);
  assert.doesNotMatch(result, /下载安装|## 下载|Assets|<details>|完整安装包沿用/);
});
