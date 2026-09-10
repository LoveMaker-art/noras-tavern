const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL, fileURLToPath } = require('node:url');
const showdown = require('../app/engine/sillytavern/vendor/showdown/index.cjs');
const cheerio = require('../app/engine/sillytavern/node_modules/cheerio');

const root = path.resolve(__dirname, '..');
const pages = [
  'README.md', 'docs/README.md', 'docs/install-nora-tavern.md', 'docs/install-tavern.md',
  'docs/update-nora-tavern.md', 'docs/update-standalone-tavern.md', 'docs/launcher-uninstall.md',
  'docs/launcher-managed-files.md', 'docs/verification/launcher-uninstall.md',
];
const source = file => fs.readFileSync(path.join(root, file), 'utf8');
const parse = file => cheerio.load(new showdown.Converter({ tables: true, ghCompatibleHeaderId: true }).makeHtml(source(file)));

test('all local links and section anchors in user journeys resolve', () => {
  let checked = 0;
  for (const file of pages) {
    const $ = parse(file);
    $('a[href]').each((_index, element) => {
      const href = $(element).attr('href');
      if (/^[a-z][a-z0-9+.-]*:/i.test(href)) return;
      const url = new URL(href, pathToFileURL(path.join(root, file)));
      const target = fileURLToPath(url);
      assert.ok(fs.existsSync(target), `${file} -> ${href}`);
      if (url.hash && target.endsWith('.md')) {
        const targetDoc = parse(path.relative(root, target));
        const ids = targetDoc('[id]').map((_i, element) => targetDoc(element).attr('id')).get();
        assert.ok(ids.includes(decodeURIComponent(url.hash.slice(1))), `${file} -> ${href}: missing anchor`);
      }
      checked++;
    });
  }
  assert.ok(checked > 50);
});

test('primary download action stays on README and offers exactly three real installer links', () => {
  const $ = parse('README.md');
  const main = $('div[align="center"] a').filter((_i, e) => $(e).text() === '下载启动器');
  assert.equal(main.attr('href'), '#下载安装包');
  assert.equal($('[id="下载安装包"]').length, 1);
  const urls = $('a').filter((_i, e) => $(e).text() === '下载安装包').map((_i, e) => $(e).attr('href')).get();
  assert.equal(urls.length, 3);
  for (const suffix of ['mac-arm64.dmg', 'mac-x64.dmg', 'win-x64-setup.exe']) {
    assert.equal(urls.filter(url => url.startsWith('https://github.com/LoveMaker-art/noras-tavern/releases/download/') && url.endsWith(suffix)).length, 1);
  }
});

test('product previews use repository images and link to their originals', () => {
  const $ = parse('README.md');
  for (const name of ['tavern-desktop.png', 'tavern-mobile.png', 'story-profile.png']) {
    const file = `docs/images/${name}`;
    const img = $('img').filter((_i, e) => $(e).attr('src') === file);
    assert.equal(img.length, 1, name);
    assert.equal(img.closest('a').attr('href'), file);
    assert.ok(img.attr('alt'));
    const buffer = fs.readFileSync(path.join(root, file));
    assert.equal(buffer.subarray(1, 4).toString(), 'PNG');
    const width = buffer.readUInt32BE(16), height = buffer.readUInt32BE(20);
    assert.ok(name === 'tavern-desktop.png' ? width > height : height > width);
  }
});

test('update selector separates launcher, source checkout and legacy deployment', () => {
  const $ = parse('docs/update-nora-tavern.md');
  const destinations = $('table').first().find('a').map((_i, e) => $(e).attr('href')).get();
  assert.deepEqual(destinations, ['#启动器完全版', 'install-tavern.md#更新源码版', 'update-standalone-tavern.md']);
  assert.ok(!source('docs/update-nora-tavern.md').includes('curl -fsSL'));
  assert.ok(source('docs/update-standalone-tavern.md').includes('不是空白电脑的首次安装流程'));
});

test('source guide supplies prerequisites, PowerShell-safe npm, and non-destructive update commands', () => {
  const value = source('docs/install-tavern.md');
  for (const text of ['https://git-scm.com/install/windows', 'https://nodejs.org/en/download',
    'xcode-select --install', 'npm.cmd ci', 'git status --short', 'git pull --ff-only']) assert.ok(value.includes(text), text);
  assert.ok(!value.includes('git reset --hard'));
  assert.ok(!value.includes('Set-ExecutionPolicy'));
});

test('installation keeps actual pairing requirements and moves managed-file internals to reference', () => {
  const value = source('docs/install-nora-tavern.md');
  assert.ok(value.includes('本整合包当前的配对流程使用 ClawChat'));
  assert.ok(value.includes('https://clawling.com/zh/chat/docs/connect-code/'));
  assert.ok(!value.includes('AGENTS.md.bak'));
  assert.ok(value.includes('(launcher-managed-files.md)'));
});

test('uninstall exposes data consequences without obsolete deployment or test status', () => {
  const value = source('docs/launcher-uninstall.md');
  for (const text of ['保留数据卸载', '彻底卸载无法撤销', '取消', '删除本地 Key 文件不等于撤销 Key']) assert.ok(value.includes(text), text);
  assert.ok(!value.includes('尚未重新发布'));
  assert.ok(!value.includes('## 验证范围'));
  assert.ok(value.includes('(verification/launcher-uninstall.md)'));
});
