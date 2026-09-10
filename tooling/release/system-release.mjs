import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export function fileDigest(file) {
    const hash = crypto.createHash('sha256');
    const fd = fs.openSync(file, 'r');
    const buffer = Buffer.alloc(1024 * 1024);
    try {
        let length;
        while ((length = fs.readSync(fd, buffer, 0, buffer.length, null))) hash.update(buffer.subarray(0, length));
    } finally { fs.closeSync(fd); }
    return hash.digest('hex');
}

export function configureCandidateLauncher({ packageFile, payload, identity }) {
    if (!identity.candidate) return;
    const systemBytes = fs.readFileSync(path.join(payload, 'nora-system.json'));
    const system = JSON.parse(systemBytes);
    if (system.candidate !== true || system.commit !== identity.commit || system.version !== identity.versions.tavern) {
        throw new Error('Candidate launcher identity does not match its payload');
    }
    const desktop = JSON.parse(fs.readFileSync(packageFile, 'utf8'));
    const installationId = desktop.noraTestInstallationId || `candidate-${identity.commit.slice(0, 12)}`;
    if (!/^[a-zA-Z0-9-]{1,64}$/.test(installationId)) throw new Error('Invalid candidate installation identity');
    delete desktop.noraReleaseChannel;
    desktop.noraLocalTest = { schema: 1, buildId: installationId,
        systemManifestSha256: crypto.createHash('sha256').update(systemBytes).digest('hex') };
    desktop.build.appId = 'art.lovemaker.nora-tavern-launcher.local-test';
    desktop.build.productName = '诺拉·酒馆测试版';
    desktop.build.artifactName = `Nora-Tavern-${system.version}-test-\${os}-\${arch}.\${ext}`;
    desktop.build.nsis.artifactName = `Nora-Tavern-${system.version}-test-win-\${arch}-setup.\${ext}`;
    fs.writeFileSync(packageFile, JSON.stringify(desktop, null, 2) + '\n');
}

// Each platform publishes unique names; no shared manifest is overwritten by another build.
export function writeSystemRelease({ release, payload, identity, launcherVersion, minimumLauncherVersion = '0.3.0' }) {
    const runtime = identity.hermesRuntime;
    if (!runtime) return null;
    const platform = `${runtime.platform}-${runtime.arch}`;
    const output = path.join(release, 'system-assets');
    fs.mkdirSync(output, { recursive: true });
    const files = {};
    for (const name of fs.readdirSync(payload)) {
        const file = path.join(payload, name);
        if (!fs.statSync(file).isFile() || name === 'nora-system.json') continue;
        const asset = `${platform}-${name}`;
        fs.copyFileSync(file, path.join(output, asset));
        files[name] = { asset, sha256: fileDigest(file), size: fs.statSync(file).size };
    }
    const manifest = {
        schema: 'nora-system/v1', version: identity.versions.tavern, commit: identity.commit,
        candidate: Boolean(identity.candidate), platform: runtime.platform, arch: runtime.arch,
        channel: /-beta\./.test(identity.versions.tavern) ? 'beta' : 'stable',
        launcherVersion, minimumLauncherVersion, components: identity.versions, files,
    };
    const bytes = JSON.stringify(manifest, null, 2) + '\n';
    fs.writeFileSync(path.join(output, `nora-system-${platform}.json`), bytes);
    fs.writeFileSync(path.join(payload, 'nora-system.json'), bytes);
    return output;
}
