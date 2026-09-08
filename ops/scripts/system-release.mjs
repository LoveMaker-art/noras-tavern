import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

// Each platform publishes unique names; no shared manifest is overwritten by another build.
export function writeSystemRelease({ release, payload, identity, launcherVersion }) {
    const runtime = identity.hermesRuntime;
    if (!runtime) return null;
    const platform = `${runtime.platform}-${runtime.arch}`;
    const output = path.join(release, 'system-assets');
    fs.mkdirSync(output, { recursive: true });
    const files = {};
    for (const name of fs.readdirSync(payload)) {
        const file = path.join(payload, name);
        if (!fs.statSync(file).isFile() || name === 'nora-system.json') continue;
        const bytes = fs.readFileSync(file);
        const asset = `${platform}-${name}`;
        fs.copyFileSync(file, path.join(output, asset));
        files[name] = { asset, sha256: crypto.createHash('sha256').update(bytes).digest('hex'), size: bytes.length };
    }
    const manifest = {
        schema: 'nora-system/v1', version: identity.versions.tavern, commit: identity.commit,
        candidate: Boolean(identity.candidate), platform: runtime.platform, arch: runtime.arch,
        channel: /-beta\./.test(identity.versions.tavern) ? 'beta' : 'stable',
        launcherVersion, minimumLauncherVersion: '0.3.0', components: identity.versions, files,
    };
    const bytes = JSON.stringify(manifest, null, 2) + '\n';
    fs.writeFileSync(path.join(output, `nora-system-${platform}.json`), bytes);
    fs.writeFileSync(path.join(payload, 'nora-system.json'), bytes);
    return output;
}
