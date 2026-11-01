const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { Readable } = require('node:stream');
const { sourceCandidates,releaseListUrl } = require('./release-sources');

function digestFile(file){
  const digest=crypto.createHash('sha256'),buffer=Buffer.alloc(1024*1024),fd=fs.openSync(file,'r');
  try{let count;while((count=fs.readSync(fd,buffer,0,buffer.length,null))>0)digest.update(buffer.subarray(0,count));}
  finally{fs.closeSync(fd);}
  return digest.digest('hex');
}

// Explicit local acceptance transport; verification and update planning stay in releases.js.
function createLocalRelease(directory, sourceOptions = {}) {
  if (!path.isAbsolute(directory)) throw new Error('Local release directory must be absolute');
  const root = fs.realpathSync(directory);
  const api = 'https://api.github.com/repos/LoveMaker-art/noras-tavern/releases/';
  const base = 'https://github.com/LoveMaker-art/noras-tavern/releases/download/';
  const catalogue = directory => {
    const stat=fs.lstatSync(directory);if(!stat.isDirectory()||stat.isSymbolicLink())throw new Error('Local release directory must not be linked');
    const manifest=JSON.parse(fs.readFileSync(path.join(directory,'release-manifest.json'),'utf8'));
    const tag=require('./releases').publicationTag(manifest);
    const assets=fs.readdirSync(directory).filter(name=>/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(name)
      &&fs.lstatSync(path.join(directory,name)).isFile());
    return {directory,release:{tag_name:tag,draft:false,prerelease:tag.includes('-beta.'),
      assets:assets.map(name=>({name,browser_download_url:`${base}${encodeURIComponent(tag)}/${name}`,
        state:'uploaded',size:fs.statSync(path.join(directory,name)).size,digest:'sha256:'+digestFile(path.join(directory,name))}))}};
  };
  const core=catalogue(root),child=path.join(root,'launcher-stable');
  // This layout belongs only to the explicitly selected local acceptance
  // transport. Public discovery still comes from the sealed provider channels.
  const app=fs.existsSync(child)?catalogue(child):null;
  if(app&&app.release.tag_name===core.release.tag_name)throw new Error('Local split catalogues must have distinct fixed tags');
  const filesByUrl=new Map(),catalogues=new Map();
  for(const item of [core,...(app?[app]:[])]){
    for(const asset of item.release.assets)for(const candidate of sourceCandidates(asset.browser_download_url,sourceOptions)){
      const file=path.join(item.directory,asset.name);
      if(filesByUrl.has(candidate.url)&&filesByUrl.get(candidate.url)!==file)throw new Error('Local acceptance source has conflicting asset URLs');
      filesByUrl.set(candidate.url,file);
    }
    for(const candidate of sourceCandidates(`${api}tags/${encodeURIComponent(item.release.tag_name)}`,sourceOptions))catalogues.set(candidate.url,item.release);
  }
  for(const candidate of sourceCandidates(`${api}latest`,sourceOptions))catalogues.set(candidate.url,core.release);
  const lists=new Set([releaseListUrl(),`${api.slice(0,-1)}?per_page=100&page=1`]
    .flatMap(url=>sourceCandidates(url,sourceOptions).map(candidate=>candidate.url)));
  const response = (body, url, headers) => {
    const value = new Response(body, { headers });
    Object.defineProperty(value, 'url', { value: url });
    return value;
  };
  return async (url, options = {}) => {
    options.signal?.throwIfAborted();
    url = String(url);
    if (lists.has(url)) return response(JSON.stringify([app?.release||core.release]),url,{'Content-Type':'application/json'});
    if (catalogues.has(url)) {
      return response(JSON.stringify(catalogues.get(url)), url, { 'Content-Type': 'application/json' });
    }
    const file = filesByUrl.get(url);
    if (!file) throw new Error('Local acceptance source rejected an unexpected URL');
    if (fs.realpathSync(file) !== file || !fs.lstatSync(file).isFile()) throw new Error('Local release file changed');
    return response(Readable.toWeb(fs.createReadStream(file, { signal: options.signal })), url,
      { 'Content-Length': String(fs.statSync(file).size) });
  };
}
module.exports = { createLocalRelease };
