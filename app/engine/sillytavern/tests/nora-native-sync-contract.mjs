import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '../../..');
const lifecycle = fs.readFileSync(path.join(root, 'native_lifecycle.py'), 'utf8');
const runtimeScript = fs.readFileSync(path.resolve(root, '../ops/scripts/runtime.sh'), 'utf8');

assert.match(lifecycle, /sync\s*=\s*subparsers\.add_parser\("sync"\)/);
assert.match(lifecycle, /sync\.add_argument\("--native-data-root"\)/);
assert.match(lifecycle, /elif args\.command == "sync":\s*\n\s*result = runtime\.sync_assets\(args\.native_data_root\)/);
assert.match(lifecycle, /\("src\/server-main\.js", "computeBrowserAssetManifest"\)/);
assert.doesNotMatch(lifecycle, /\("src\/server-main\.js", "computeStaticAssetRelease"\)/);
assert.match(runtimeScript, /install\|prepare\|start\|stop\|restart\|status\|sync/);
assert.match(runtimeScript, /usage: runtime\.sh \{install\|prepare\|start\|stop\|restart\|status\|sync\}/);

console.log('nora-native-sync-contract=PASS');
