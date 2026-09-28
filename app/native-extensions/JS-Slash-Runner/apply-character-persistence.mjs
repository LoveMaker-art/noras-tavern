import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';

// Pin the upstream save function, not the whole bundle: other Nora transforms coexist.
const delegate = "async function oA(e,t,n,r=!0){return persistCharacterExtension(e,t,n,r,{getCharacter:id=>b[Number(id)],hydrate:Ue,currentId:()=>He,clone:Wk,paths:_,headers:pe,serialize:Uk.serialize,fetcher:(...args)=>fetch(...args),updateJson:value=>$(\"#character_json_data\").val(value)})}";
const originalHash = 'd10ac11b71ffa6c0662e0bb07ee381959fe977cb9e51d4e91763395d5710a5d9';

export function transformCharacterPersistence(source) {
    const start = source.indexOf('async function oA(');
    const end = source.indexOf('var sA=', start);
    if (start < 0 || end < 0 || source.indexOf('async function oA(', start + 1) !== -1) {
        throw new Error('Managed runner changed: review character persistence anchors');
    }
    const current = source.slice(start, end);
    if (current !== delegate && createHash('sha256').update(current).digest('hex') !== originalHash) {
        throw new Error('Managed runner changed: review character persistence function');
    }
    source = source.slice(0, start) + delegate + source.slice(end);
    const before = "import { createHelperControlAdapter, synchronizeHelperRuntimeReadiness } from '../nora-control-adapter.js';";
    const after = "import { createHelperControlAdapter, synchronizeHelperRuntimeReadiness, persistCharacterExtension } from '../nora-control-adapter.js';";
    const oldCount = source.split(before).length - 1;
    const newCount = source.split(after).length - 1;
    if (oldCount === 1 && newCount === 0) return source.replace(before, after);
    if (oldCount === 0 && newCount === 1) return source;
    throw new Error('Managed runner changed: review character persistence import');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    const file = new URL('./dist/index.js', import.meta.url);
    await fs.writeFile(file, transformCharacterPersistence(await fs.readFile(file, 'utf8')));
}
