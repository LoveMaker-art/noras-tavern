const fs = require('node:fs');
const path = require('node:path');
const { Readable } = require('node:stream');

// Explicit local acceptance transport; verification and update planning stay in releases.js.
function createLocalRelease(directory) {
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
  return async (url, options = {}) => {
    options.signal?.throwIfAborted();
    if (url === `${api}latest` || url === `${api}tags/${encodeURIComponent(tag)}`) {
      return Response.json(release);
    }
    const asset = release.assets.find(item => item.browser_download_url === url);
    if (!asset) throw new Error('Local acceptance source rejected an unexpected URL');
    const file = path.join(root, asset.name);
    if (fs.realpathSync(file) !== file || !fs.lstatSync(file).isFile()) throw new Error('Local release file changed');
    return new Response(Readable.toWeb(fs.createReadStream(file, { signal: options.signal })));
  };
}
module.exports = { createLocalRelease };
