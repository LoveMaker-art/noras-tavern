import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import path from 'node:path';import {fileURLToPath} from 'node:url';
import {digest} from '../../tooling/release/core-assets.mjs';
import {readConsumerAsar} from '../../tooling/release/legacy-core-consumer.mjs';
const root=fileURLToPath(new URL('../../',import.meta.url));
const expected={"2.1.1": {"commit": "2b2e34c10348527fc8b30d2e73bd496106a7415c", "selectorSha256": "676e4c99ad76555355f324b2ccbc304baa52d00ebf922e28e3890c912b38f0c7"}, "2.2.8": {"commit": "928d9d802b6e58760f3d45a05c1d4d3deb384c9e", "selectorSha256": "16374119069d907ce74a840e035ea4c2f33e29e11499005aecab69c152550709"}};
for(const [version,identity]of Object.entries(expected))test(`frozen ${version} core-producer consumer retains its original identity`,()=>{
 const base=path.join(root,'tests/fixtures/legacy-core-consumers',version),proof=JSON.parse(fs.readFileSync(path.join(base,'provenance.json')));
 assert.equal(proof.commit,identity.commit);assert.equal(proof.version,version);assert.equal(proof.files['deployment/update/releases.js'],identity.selectorSha256);
 assert.equal(Object.keys(proof.files).length,7);
 for(const [source,hash]of Object.entries(proof.files))assert.equal(digest(fs.readFileSync(path.join(base,path.basename(source)))),hash);
});
test('legacy ASAR reader rejects truncated, oversized and malformed headers before reading modules',()=>{
 for(const bytes of [Buffer.alloc(0),Buffer.alloc(8),Buffer.alloc(16),Buffer.alloc(64*1024*1024+1)])assert.throws(()=>readConsumerAsar(bytes));
});
