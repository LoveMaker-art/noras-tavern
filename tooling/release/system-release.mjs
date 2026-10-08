import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

// Released launchers through 2.0.2 predate the registered executor protocol.
// Candidate labels may be reused locally; they cannot establish compatibility
// for a public release. The first public version is chosen at delivery.
const LAST_LEGACY_LAUNCHER = [2, 0, 2];
const compareVersion = (left, right) => {
    for (let index = 0; index < 3; index++) if (left[index] !== right[index]) return Math.sign(left[index] - right[index]);
    return 0;
};
export function assertMaintenanceVersions({ launcherVersion, minimumLauncherVersion, candidate = false }) {
    const parse = value => {
        if (typeof value !== 'string' || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value))
            throw new Error('Missing or invalid maintenance launcher version');
        const parts = value.split('.').map(Number);
        if (!parts.every(Number.isSafeInteger)) throw new Error('Invalid maintenance launcher version');
        return parts;
    };
    const launcher = parse(launcherVersion), minimum = parse(minimumLauncherVersion);
    if (compareVersion(minimum, launcher) > 0) throw new Error('Maintenance minimum exceeds the bundled launcher version');
    if (!candidate && compareVersion(minimum, LAST_LEGACY_LAUNCHER) <= 0)
        throw new Error('The new maintenance protocol cannot advertise legacy launchers through 2.0.2; choose a new public launcher version');
    return minimumLauncherVersion;
}

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

export function configureCandidateLauncher({ packageFile, payload, identity, telemetryEnabled = false }) {
    if (!identity.candidate) return;
    const systemBytes = fs.readFileSync(path.join(payload, 'nora-system.json'));
    const system = JSON.parse(systemBytes);
    if (system.candidate !== true || system.commit !== identity.commit || system.version !== identity.versions.tavern) {
        throw new Error('Candidate launcher identity does not match its payload');
    }
    const desktop = JSON.parse(fs.readFileSync(packageFile, 'utf8'));
    const installationId = desktop.noraTestInstallationId || `candidate-${identity.commit.slice(0, 12)}${telemetryEnabled ? '-telemetry' : ''}`;
    if (!/^[a-zA-Z0-9-]{1,64}$/.test(installationId)) throw new Error('Invalid candidate installation identity');
    delete desktop.noraReleaseChannel;
    desktop.noraLocalTest = { schema: 1, buildId: installationId,
        systemManifestSha256: crypto.createHash('sha256').update(systemBytes).digest('hex'),
        ...(telemetryEnabled ? { telemetryEnabled: true } : {}) };
    desktop.build.appId = 'art.lovemaker.nora-tavern-launcher.local-test';
    desktop.build.productName = '诺拉·酒馆测试版';
    desktop.build.artifactName = `Nora-Tavern-${system.version}-test-\${os}-\${arch}.\${ext}`;
    desktop.build.nsis.artifactName = `Nora-Tavern-${system.version}-test-win-\${arch}-setup.\${ext}`;
    fs.writeFileSync(packageFile, JSON.stringify(desktop, null, 2) + '\n');
}

// Each platform publishes unique names; no shared manifest is overwritten by another build.
export function writeSystemRelease({ release, payload, identity, launcherVersion, minimumLauncherVersion = identity.bootstrap?.minimumLauncherVersion }) {
    const runtime = identity.hermesRuntime;
    if (!runtime) return null;
    assertMaintenanceVersions({ launcherVersion, minimumLauncherVersion, candidate: identity.candidate === true });
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
        launcherCapabilities:identity.launcherCapabilities,
    };
    const bytes = JSON.stringify(manifest, null, 2) + '\n';
    fs.writeFileSync(path.join(output, `nora-system-${platform}.json`), bytes);
    fs.writeFileSync(path.join(payload, 'nora-system.json'), bytes);
    return output;
}
