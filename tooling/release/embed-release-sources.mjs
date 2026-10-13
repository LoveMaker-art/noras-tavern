import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';

export const RELEASE_SOURCE_ENTRY_PATHS = [
  ['deployment/install/bootstrap.py', 'ops/installer/bootstrap.py'],
  ['deployment/update/bootstrap.py', 'ops/updater/bootstrap.py'],
  ['deployment/install/install.sh', 'ops/installer/install.sh'],
  ['deployment/update/install.sh', 'ops/updater/install.sh'],
  ['deployment/install/install.ps1', 'ops/installer/install.ps1'],
  ['deployment/runtime/nora-tavern-update-check.py', 'ops/scripts/nora-tavern-update-check.py'],
];
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const begin = '# BEGIN BUILD-OWNED RELEASE SOURCES';
const end = '# END BUILD-OWNED RELEASE SOURCES';
const block = /^# BEGIN BUILD-OWNED RELEASE SOURCES\r?\n[\s\S]*?^# END BUILD-OWNED RELEASE SOURCES/gm;
const helper = /\ndef validate_sources\(value\):[\s\S]*?raise RuntimeError\('资源响应偏离受信任来源，未使用下载内容。'\)\r?\n/;

function select(root, paths) {
  const candidates = paths.filter(relative => fs.existsSync(path.join(root, relative)));
  if (candidates.length !== 1) throw new Error(`Expected one release source entry: ${paths.join(', ')}`);
  const relative = candidates[0];
  if (!fs.lstatSync(path.join(root, relative)).isFile()) throw new Error(`Release source entry must be a regular file: ${relative}`);
  return relative;
}

// This is a build transform only. Downloaded entries execute their sealed copy;
// neither online metadata nor an environment variable can add trusted roots.
export function embedReleaseSources(root, {check = false} = {}) {
  const configurationPath = select(root, ['launcher/desktop/release-sources.json', 'ops/installer/desktop/release-sources.json']);
  const servicePath = select(root, ['launcher/desktop/release-sources.js', 'ops/installer/desktop/release-sources.js']);
  const raw = fs.readFileSync(path.join(root, configurationPath));
  if (raw.length > 64 * 1024) throw new Error('Release source configuration exceeds the build limit');
  const configuration = JSON.parse(raw);
  createRequire(import.meta.url)(path.join(root, servicePath)).validateSources(configuration);
  // JS transport fixtures may use local TLS ports. Published standalone
  // entries retain their HTTPS default/443 allowlist, so reject mismatches
  // at the build boundary rather than widening their response verification.
  for (const mirror of configuration.mirrors) {
    for (const value of [mirror.baseUrl, ...(mirror.channelBaseUrl ? [mirror.channelBaseUrl] : [])]) {
      const url = new URL(value);
      if (url.port && url.port !== '443') throw new Error('Standalone release sources require HTTPS default/443 ports');
    }
  }
  const json = JSON.stringify(configuration);
  const literal = "'" + json.replaceAll('\\', '\\\\').replaceAll("'", "\\'") + "'";
  const replacement = `${begin}\nRELEASE_SOURCES = json.loads(${literal})\n${end}`;
  let contract;
  const entries = RELEASE_SOURCE_ENTRY_PATHS.map(paths => {
    const relative = select(root, paths);
    const file = path.join(root, relative), before = fs.readFileSync(file);
    const text = before.toString('utf8');
    const matches = [...text.matchAll(block)];
    if (matches.length !== 1) throw new Error(`Missing or duplicate build-owned sources marker: ${relative}`);
    const implementation = text.match(helper)?.[0];
    if (!implementation || contract != null && contract !== implementation)
      throw new Error(`Standalone release source contracts differ: ${relative}`);
    contract = implementation;
    const after = Buffer.from(text.replace(block, () => replacement));
    return {file, before, after, record: {path: relative, beforeSha256: digest(before), afterSha256: digest(after),
      beforeSize: before.length, afterSize: after.length, changed: !before.equals(after)}};
  });
  const report = {schema: 'nora-embedded-release-sources/1', configurationPath,
    configurationSha256: digest(raw), files: entries.map(entry => entry.record)};
  if (check && report.files.some(file => file.changed))
    throw Object.assign(new Error('Standalone release source configuration is stale; regenerate before sealing'), {report});
  if (!check) for (const entry of entries) if (entry.record.changed) fs.writeFileSync(entry.file, entry.after);
  return report;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const check = args.includes('--check');
  const directories = args.filter(arg => arg !== '--check');
  if (directories.length > 1) throw new Error('Usage: node embed-release-sources.mjs [--check] [source-root]');
  console.log(JSON.stringify(embedReleaseSources(path.resolve(directories[0] || process.cwd()), {check})));
}
