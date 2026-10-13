const fs = require('node:fs');
const path = require('node:path');
const { Readable } = require('node:stream');
const { sourceCandidates } = require('./release-sources');

// Explicit local acceptance transport; verification and update planning stay in releases.js.
function createLocalRelease(directory, sourceOptions = {}) {
  if (!path.isAbsolute(directory)) throw new Error('Local release directory must be absolute');
  const root = fs.realpathSync(directory);
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'release-manifest.json'), 'utf8'));
  const tag = `v${manifest.versions.tavern.replace(/^v/, '')}`;
  const base = 'https://github.com/LoveMaker-art/noras-tavern/releases/download/';
  const api = 'https://api.github.com/repos/LoveMaker-art/noras-tavern/releases/';
  const assets = fs.readdirSync(root).filter(name => /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(name)
    && fs.lstatSync(path.join(root, name)).isFile());
  const release = { tag_name: tag, draft: false, prerelease: false,
    assets: assets.map(name => ({ name, browser_download_url: `${base}${encodeURIComponent(tag)}/${name}` })) };
  const filesByUrl = new Map();
  for (const asset of release.assets) for (const candidate of sourceCandidates(asset.browser_download_url, sourceOptions)) {
    if (filesByUrl.has(candidate.url) && filesByUrl.get(candidate.url) !== asset.name)
      throw new Error('Local acceptance source has conflicting asset URLs');
    filesByUrl.set(candidate.url, asset.name);
  }
  const catalogues = new Set([`${api}latest`, `${api}tags/${encodeURIComponent(tag)}`]
    .flatMap(url => sourceCandidates(url, sourceOptions).map(candidate => candidate.url)));
  const response = (body, url, headers) => {
    const value = new Response(body, { headers });
    Object.defineProperty(value, 'url', { value: url });
    return value;
  };
  return async (url, options = {}) => {
    options.signal?.throwIfAborted();
    url = String(url);
    if (catalogues.has(url)) {
      return response(JSON.stringify(release), url, { 'Content-Type': 'application/json' });
    }
    const name = filesByUrl.get(url);
    if (!name) throw new Error('Local acceptance source rejected an unexpected URL');
    const file = path.join(root, name);
    if (fs.realpathSync(file) !== file || !fs.lstatSync(file).isFile()) throw new Error('Local release file changed');
    return response(Readable.toWeb(fs.createReadStream(file, { signal: options.signal })), url,
      { 'Content-Length': String(fs.statSync(file).size) });
  };
}
module.exports = { createLocalRelease };
