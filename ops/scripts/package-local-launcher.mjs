import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
if (!process.argv[2]) throw new Error('Pass an existing candidate nora-tavern-launcher directory');
const launcher = path.resolve(process.argv[2]);
const systemFile = path.join(launcher, 'payload/nora-system.json');
const systemBytes = fs.readFileSync(systemFile);
const system = JSON.parse(systemBytes);
if (system.candidate !== true || system.platform !== process.platform || system.arch !== process.arch) {
  throw new Error('Local test packaging requires a candidate for this host');
}
const source = path.join(root, 'ops/installer/desktop');
const desktop = path.join(launcher, 'desktop');
if (!fs.existsSync(path.join(desktop, 'node_modules'))) {
  fs.symlinkSync(path.join(source, 'node_modules'), path.join(desktop, 'node_modules'), 'junction');
}
const pkg = JSON.parse(fs.readFileSync(path.join(source, 'package.json')));
for (const file of ['package.json', ...pkg.build.files]) {
  fs.copyFileSync(path.join(source, file), path.join(desktop, file));
}
fs.copyFileSync(path.join(source, pkg.build.nsis.include), path.join(desktop, pkg.build.nsis.include));
// Refresh launcher resources too; the pinned system payload remains unchanged.
for (const resource of pkg.build.extraResources) {
  if (resource.to === 'payload') continue;
  fs.cpSync(path.resolve(source, resource.from), path.resolve(desktop, resource.from), { recursive: true });
}
const buildId = `local-${Date.now()}`;
const config = {
  ...pkg.build,
  appId: 'art.lovemaker.nora-tavern-launcher.local-test',
  productName: '诺拉·酒馆测试版',
  npmRebuild: false,
  electronDist: path.join(source, 'node_modules/electron/dist'),
  electronVersion: JSON.parse(fs.readFileSync(path.join(source, 'node_modules/electron/package.json'))).version,
  mac: { ...pkg.build.mac, identity: '-' },
  extraMetadata: { noraLocalTest: { schema: 1, buildId,
    systemManifestSha256: crypto.createHash('sha256').update(systemBytes).digest('hex') } },
};
const configFile = path.join(desktop, 'local-test-build.json');
fs.writeFileSync(configFile, JSON.stringify(config, null, 2));
execFileSync(process.execPath, [path.join(source, 'node_modules/electron-builder/cli.js'),
  '--projectDir', desktop, '--dir', '--config', configFile,
  ...(process.platform === 'darwin' ? ['--mac', `--${process.arch}`] : ['--win', '--x64'])],
{ stdio: 'inherit', env: { ...process.env, CSC_IDENTITY_AUTO_DISCOVERY: 'false' } });
console.log(JSON.stringify({ buildId, desktop, systemVersion: system.version, source: 'local-candidate' }));
