const { test } = require('node:test');
const assert = require('node:assert/strict');
const { renderReleaseNotes } = require('../tooling/release/launcher-release-notes.cjs');
const inputs = {
  repository: 'LoveMaker-art/noras-tavern', tag: 'v2.2.12',
  assetNames: ['mac-arm64.dmg', 'mac-x64.dmg', 'win-x64-setup.exe']
    .map(suffix => `Nora-Tavern-Launcher-0.4.0-${suffix}`),
  notes: '# Release\n\n## 下载\n\nOld filenames.\n\n## 本次更新\n\nKeep this change.\n\n## 安全提醒\n\nKeep this warning.\n',
};

test('download links use actual build names and current tag, preserving all other sections', () => {
  const result = renderReleaseNotes(inputs);
  for (const name of inputs.assetNames) assert.ok(result.includes(`/releases/download/v2.2.12/${name}`));
  assert.ok(!result.includes('Old filenames'));
  assert.ok(result.endsWith('## 本次更新\n\nKeep this change.\n\n## 安全提醒\n\nKeep this warning.\n'));
  assert.equal((result.match(/\*\*\[下载安装包\]/g) || []).length, 3);
  assert.equal(renderReleaseNotes({ ...inputs, notes: result }), result);
});

test('missing, duplicated or portable-only installers stop note generation', () => {
  assert.throws(() => renderReleaseNotes({ ...inputs, assetNames: inputs.assetNames.slice(1) }), /exactly one installer/);
  assert.throws(() => renderReleaseNotes({ ...inputs, assetNames: [...inputs.assetNames, inputs.assetNames[0]] }), /exactly one installer/);
  assert.throws(() => renderReleaseNotes({ ...inputs, assetNames: inputs.assetNames.map(name => name + '.zip') }), /exactly one installer/);
});

test('beta release gets the same download entry without redirecting to latest stable', () => {
  const result = renderReleaseNotes({ ...inputs, tag: 'v2.2.12-beta.1', notes: '# Beta\n\nTesting notice.\n' });
  assert.match(result, /releases\/download\/v2\.2\.12-beta\.1\//);
  assert.ok(result.includes('Testing notice.'));
  assert.ok(!result.includes('/latest/'));
});

test('invalid destinations and ambiguous download sections fail closed', () => {
  assert.throws(() => renderReleaseNotes({ ...inputs, repository: 'https://example.invalid' }));
  assert.throws(() => renderReleaseNotes({ ...inputs, tag: 'latest' }));
  assert.throws(() => renderReleaseNotes({ ...inputs, notes: '## 下载\nFirst\n## 下载\nSecond' }), /Multiple/);
});

test('component updates link to actual baseline installers, never nonexistent new-tag installers', () => {
  const result = renderReleaseNotes({ ...inputs, tag: 'v2.3.1', installerTag: 'v2.3.0' });
  for (const name of inputs.assetNames) assert.ok(result.includes(`/releases/download/v2.3.0/${name}`));
  assert.ok(!result.includes('/releases/download/v2.3.1/'));
  assert.match(result, /v2.3.1 发布系统更新组件/);
  assert.match(result, /完整安装包沿用 v2.3.0/);
});
