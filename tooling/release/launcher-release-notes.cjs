const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');

function validateInstallers(repository, tag, assetNames) {
  assert.match(repository, /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/);
  assert.match(tag, /^v\d+\.\d+\.\d+(?:-beta\.\d+)?$/);
  const platforms = [
    ['Windows x64', 'win-x64-setup.exe'],
    ['Mac Apple 芯片', 'mac-arm64.dmg'],
    ['Mac Intel', 'mac-x64.dmg'],
  ];
  for (const [label, suffix] of platforms) {
    const matches = assetNames.filter(name => /^Nora-Tavern-Launcher-[A-Za-z0-9.+-]+$/.test(name) && name.endsWith(`-${suffix}`));
    assert.equal(matches.length, 1, `Expected exactly one installer for ${label}`);
  }
}

function renderReleaseNotes({ repository, tag, assetNames, notes, installerTag = tag }) {
  assert.match(tag, /^v\d+\.\d+\.\d+(?:-beta\.\d+)?$/);
  validateInstallers(repository, installerTag, assetNames);
  assert.ok(typeof notes === 'string' && notes.trim(), 'Release notes require an authored summary');
  return notes.trim().replace(/\r\n/g, '\n') + '\n';
}

if (require.main === module) {
  const [root, tag, repository, notesFile, outputFile] = process.argv.slice(2);
  assert.ok(root && notesFile && outputFile, 'Usage: <artifacts> <tag> <owner/repo> <notes> <output>');
  const assetNames = fs.readdirSync(root, { recursive: true })
    .filter(name => fs.statSync(path.join(root, name)).isFile()).map(name => path.basename(name));
  const notes = fs.existsSync(notesFile) ? fs.readFileSync(notesFile, 'utf8') : null;
  const updateFile = path.join(root, 'component-release.json');
  const update = fs.existsSync(updateFile) ? JSON.parse(fs.readFileSync(updateFile)) : null;
  assert.ok(notes || tag.includes('-beta.'), 'Stable releases require authored release notes');
  fs.writeFileSync(outputFile, renderReleaseNotes({ repository, tag,
    assetNames: update ? update.installers : assetNames, installerTag: update?.installerTag || tag, notes: notes ||
    `# 诺拉·酒馆 ${tag}\n\n## 测试说明\n\n三平台启动器测试版，包含完整 Nora 系统，不含个人密钥或用户数据。未签名或未公证的平台包可能出现系统安全提示。\n` }));
}

module.exports = { renderReleaseNotes };
