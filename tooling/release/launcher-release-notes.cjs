const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');

function downloadSection(repository, tag, assetNames) {
  assert.match(repository, /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/);
  assert.match(tag, /^v\d+\.\d+\.\d+(?:-beta\.\d+)?$/);
  const platforms = [
    ['Windows x64', 'win-x64-setup.exe'],
    ['Mac Apple 芯片', 'mac-arm64.dmg'],
    ['Mac Intel', 'mac-x64.dmg'],
  ];
  const base = `https://github.com/${repository}`;
  const rows = platforms.map(([label, suffix]) => {
    const matches = assetNames.filter(name => /^Nora-Tavern-Launcher-[A-Za-z0-9.+-]+$/.test(name) && name.endsWith(`-${suffix}`));
    assert.equal(matches.length, 1, `Expected exactly one installer for ${label}`);
    const url = `${base}/releases/download/${encodeURIComponent(tag)}/${encodeURIComponent(matches[0])}`;
    return `| **${label}** | **[下载安装包](${url})** |`;
  });
  return [
    '## 下载', '',
    '**选择你的电脑，点击即可下载。无需在下方 Assets 中查找文件。**', '',
    '| 你的电脑 | 直接下载 |', '| :--- | :--- |', ...rows, '',
    `**[安装步骤](${base}/blob/${tag}/docs/install-nora-tavern.md)** · [版本记录](${base}/releases)`, '',
    'Mac：在苹果菜单“关于本机”中查看芯片。Windows：选择 x64 安装包；Windows ARM 暂不作为原生支持平台。', '',
    '打开启动器后，按界面完成安装、模型配置和 IM 平台连接。支持的平台及连接方式见安装步骤。', '',
    '> 下方其他附件供自动安装、更新和校验使用，普通用户无需逐个下载。`Source code` 是源码，不是启动器安装包。',
  ].join('\n');
}

function renderReleaseNotes({ repository, tag, assetNames, notes }) {
  const section = downloadSection(repository, tag, assetNames);
  const lines = notes.trim().split(/\r?\n/);
  const headings = lines.flatMap((line, index) => /^## 下载\s*$/.test(line) ? [index] : []);
  assert.ok(headings.length <= 1, 'Multiple download sections');
  if (headings.length) {
    const start = headings[0];
    const next = lines.findIndex((line, index) => index > start && /^#{1,2} /.test(line));
    lines.splice(start, (next < 0 ? lines.length : next) - start, section, '');
  } else {
    const insertion = lines[0]?.startsWith('# ') ? 1 : 0;
    lines.splice(insertion, 0, '', section, '');
  }
  return lines.join('\n').trim() + '\n';
}

if (require.main === module) {
  const [root, tag, repository, notesFile, outputFile] = process.argv.slice(2);
  assert.ok(root && notesFile && outputFile, 'Usage: <artifacts> <tag> <owner/repo> <notes> <output>');
  const assetNames = fs.readdirSync(root, { recursive: true })
    .filter(name => fs.statSync(path.join(root, name)).isFile()).map(name => path.basename(name));
  const notes = fs.existsSync(notesFile) ? fs.readFileSync(notesFile, 'utf8') : null;
  assert.ok(notes || tag.includes('-beta.'), 'Stable releases require authored release notes');
  fs.writeFileSync(outputFile, renderReleaseNotes({ repository, tag, assetNames, notes: notes ||
    `# 诺拉·酒馆 ${tag}\n\n## 测试说明\n\n三平台启动器测试版，包含完整 Nora 系统，不含个人密钥或用户数据。安装后仍需配置模型和连接 IM 平台。未签名或未公证的平台包可能出现系统安全提示。\n` }));
}

module.exports = { renderReleaseNotes };
