import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import path from 'node:path';import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('../../',import.meta.url));
const current=['README.md','README.en.md','CONTRIBUTING.md','AGENTS.md','docs/README.md','docs/REPOSITORY.md','docs/core-maintenance.md','docs/release-process.md','docs/install-nora-tavern.md','docs/install-tavern.md','docs/update-nora-tavern.md','docs/update-standalone-tavern.md','docs/product/README.md','docs/product/nora.md','docs/product/tavern.md','docs/product/requirements.md','nora/README.md','deployment/README.md'];
test('current core documentation resolves local files and offers no retired desktop entry',()=>{
 const errors=[];for(const file of current){const bytes=fs.readFileSync(path.join(root,file),'utf8');for(const match of bytes.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)){const target=match[1].split('#')[0];if(!target||/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(target))continue;if(!fs.existsSync(path.resolve(root,path.dirname(file),target)))errors.push(file+' -> '+target);}
 if(['README.md','README.en.md','docs/README.md','CONTRIBUTING.md'].includes(file))assert.doesNotMatch(bytes,/下载启动器|打开启动器|launcher\/desktop|launcher\/README/);
 }assert.deepEqual(errors,[]);
});
