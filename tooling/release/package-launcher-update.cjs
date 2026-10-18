// Runs from staged launcher sources; no full desktop build is required.
// The update archive contains the shell, not Hermes or the Tavern payload.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');

function configuration(desktop, platform, arch) {
  const pkg = JSON.parse(fs.readFileSync(path.join(desktop, 'package.json')));
  let release = JSON.parse(fs.readFileSync(path.join(desktop, '../payload/release-manifest.json')));
  if(release.coreRelease)throw new Error('Platform core manifest cannot itself be a recursive core reference');
  const systemFile=path.join(desktop,'../payload/nora-system.json');
  if(fs.existsSync(systemFile)){const system=JSON.parse(fs.readFileSync(systemFile));
    if(system.coreRelease){const product=JSON.parse(fs.readFileSync(path.resolve(desktop,'../../release-manifest.json')));
      if(product.commit!==system.commit||JSON.stringify(product.coreRelease)!==JSON.stringify(system.coreRelease)
        ||product.versions?.tavern!==release.versions?.tavern)throw new Error('APP product source differs from bound system');
      release=product;}}
  const identity = { schema: 1, version: pkg.version, platform, arch, commit: release.commit };
  const identityFile = path.join(desktop, 'launcher-update-info.json');
  fs.writeFileSync(identityFile, JSON.stringify(identity));
  const asset = `Nora-Tavern-Launcher-${pkg.version}-${platform}-${arch}-update.zip`;
  return { pkg, release, identity, asset, config: { ...pkg.build,
    artifactName: asset, directories: { output: 'update-dist' },
    extraResources: pkg.build.extraResources.filter(item => item.to !== 'payload')
      .concat([{ from: identityFile, to: 'launcher-update-info.json' }]),
    mac: { ...pkg.build.mac, target: ['zip'] }, win: { ...pkg.build.win, target: ['zip'] },
  } };
}
function build(desktop, platform, arch) {
  if (!['darwin-arm64', 'darwin-x64', 'win32-x64'].includes(`${platform}-${arch}`)) throw new Error('Unsupported update target');
  const { pkg, release, identity, asset, config } = configuration(desktop, platform, arch);
  const configFile = path.join(desktop, 'update-builder.json');
  fs.writeFileSync(configFile, JSON.stringify(config));
  execFileSync(process.execPath, [require.resolve('electron-builder/cli.js', { paths: [desktop] }),
    '--config', configFile, platform === 'darwin' ? '--mac' : '--win', 'zip', `--${arch}`], { cwd: desktop, stdio: 'inherit' });
  const archive = path.join(desktop, 'update-dist', asset);
  const bytes = fs.readFileSync(archive);
  const manifest = { ...identity, schema: 'nora-launcher/v1', candidate: Boolean(release.candidate),
    asset, size: bytes.length, sha256: crypto.createHash('sha256').update(bytes).digest('hex') };
  const output = path.join(desktop, 'dist');
  fs.mkdirSync(output, { recursive: true });
  fs.copyFileSync(archive, path.join(output, asset));
  fs.writeFileSync(path.join(output, `nora-launcher-${platform}-${arch}.json`), JSON.stringify(manifest, null, 2));
  console.log(`Launcher ${pkg.version} lightweight update sealed: ${asset}`);
}
if (require.main === module) build(path.resolve(process.argv[2]), process.argv[3], process.argv[4]);
module.exports = { configuration, build };
