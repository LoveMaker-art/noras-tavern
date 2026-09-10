const fs = require('node:fs');
const path = require('node:path');
const { hash, compare } = require('./releases');

function testBuild(metadata) {
  const value = metadata.noraLocalTest;
  if (value === undefined) return null;
  if (value?.schema !== 1 || !/^[a-zA-Z0-9-]{1,64}$/.test(value.buildId || '') ||
      !/^[a-f0-9]{64}$/.test(value.systemManifestSha256 || '')) {
    throw new Error('本地测试包标识无效。');
  }
  return value;
}

async function prepareTestPayload(root, build, launcherVersion, onEvent = () => {}) {
  if (!build) throw new Error('只有明确标识的本地测试包可以使用候选内容。');
  const manifestPath = path.join(root, 'nora-system.json');
  if (await hash(manifestPath) !== build.systemManifestSha256) throw new Error('测试包清单校验失败。');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  if (manifest.schema !== 'nora-system/v1' || manifest.candidate !== true ||
      manifest.platform !== process.platform || manifest.arch !== process.arch ||
      compare(launcherVersion, manifest.minimumLauncherVersion) === null ||
      compare(launcherVersion, manifest.minimumLauncherVersion) < 0) throw new Error('测试包平台或版本不兼容。');
  for (const required of ['release-manifest.json', 'SHA256SUMS', 'nora-tavern-app.tar.gz',
    'nora-tavern-ops.tar.gz', 'nora-tavern-nora-mcp.tar.gz', 'nora-hermes-runtime.json',
    'nora-tavern-dependencies.json', 'nora-tavern-first-install-bootstrap.py']) {
    if (!manifest.files?.[required]) throw new Error(`测试包缺少 ${required}`);
  }
  for (const [name, item] of Object.entries(manifest.files)) {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(name)) throw new Error('测试包文件路径无效。');
    const file = path.join(root, name);
    const stat = fs.lstatSync(file);
    onEvent({ event: 'task', task: `校验本地测试内容：${name}` });
    if (!stat.isFile() || stat.size !== item.size || await hash(file) !== item.sha256) {
      throw new Error(`测试包文件校验失败：${name}`);
    }
  }
  return root;
}

module.exports = { testBuild, prepareTestPayload };
