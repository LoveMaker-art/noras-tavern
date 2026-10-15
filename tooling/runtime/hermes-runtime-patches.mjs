import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const originalSha256 = '3035ac7efd7b78f30d0b917b5bcba382f5ef792d8d82e4b97b1ad9dfd8094e6a';
const patchedSha256 = 'a12f92b7837209bf8f2189f6d74d9f204d016169c8474c472e97fde8b124d7d1';
const sha256 = value => createHash('sha256').update(value).digest('hex');
const importBlock = `# boto3 is not in the [all] extras; lazy_deps installs it on demand.
try:
    # --------------------------------------------------------------------------- Ensure boto3/botocore are
    # installed before any code in this module runs. Upstream removed boto3 from [all] extras (PRs #24220,
    # #24515); lazy_deps handles on-demand installation so the Bedrock provider still works in the EKS
    # deployment without baking boto3 into the base image.
    # ---------------------------------------------------------------------------
    from tools.lazy_deps import ensure
    ensure("provider.bedrock", prompt=False)
except Exception:
    pass  # let downstream imports surface the real error
`;
const entry = `def _require_boto3():
    """Import boto3; converse_stream() needs >= 1.34.59 (a system boto3 can shadow the venv pin)."""
`;

// Keep the 0.21.1 dependency mechanism, but run it only when a Bedrock client
// actually requests boto3. Merely importing adapters must never install packages.
export function deferBedrockInstall(source) {
    assert.equal(source.split(importBlock).length, 2, 'Unexpected Bedrock import-time installation block');
    assert.equal(source.split(entry).length, 2, 'Unexpected Bedrock client entry');
    return source.replace(importBlock, '').replace(entry, entry + `    try:
        from tools.lazy_deps import ensure
        ensure("provider.bedrock", prompt=False)
    except Exception:
        pass  # the boto3 import below reports a missing dependency
`);
}

// Called only on the disposable runtime copy, never on the official checkout
// or an installed user runtime. Drift is refused before any file is changed.
export function patchHermesRuntime(runtime) {
    const relative = 'hermes-agent/agent/bedrock_adapter.py';
    const file = path.join(runtime, relative);
    assert.ok(fs.lstatSync(file).isFile(), 'Hermes adapter must be an ordinary file');
    const source = fs.readFileSync(file);
    const current = sha256(source);
    assert.ok([originalSha256, patchedSha256].includes(current), 'Hermes 0.21.1 Bedrock source changed; review the runtime patch');
    const patched = current === patchedSha256 ? source : Buffer.from(deferBedrockInstall(source.toString('utf8')));
    assert.equal(sha256(patched), patchedSha256, 'Hermes patch output differs from the reviewed source');
    if (current !== patchedSha256) fs.writeFileSync(file, patched);
    return [{ id: 'nora-bedrock-on-use-1', file: relative, upstreamVersion: '0.21.1',
        upstreamRevision: '2237be355906fbe6065ce1815711eee52b2d646e', originalSha256,
        sha256: sha256(patched) }];
}
