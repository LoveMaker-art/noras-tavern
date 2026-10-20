import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { COMPONENT_PLATFORMS, sealComponentAcceptance } from '../../tooling/release/component-acceptance.mjs';

const sha = value => createHash('sha256').update(value).digest('hex');
const bytes = value => typeof value === 'string' ? value : JSON.stringify(value, null, 2) + '\n';

// Synthetic evidence exercises the publication verifier's contract only. It
// does not claim a native process or an actual application upgrade occurred.
export function componentAcceptanceFixture(root, commit = 'a'.repeat(40)) {
    const delivery = path.join(root, 'delivery'), reports = path.join(root, 'acceptance'), planRoot = path.join(root, 'plan');
    for (const directory of [delivery, reports, planRoot]) fs.mkdirSync(directory, { recursive: true });
    const write = (directory, name, value) => {
        const file = path.join(directory, name); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, bytes(value)); return file;
    };
    const actors = Object.fromEntries(['operation_control.py', 'operation_cli.py', 'operation_evidence.py', 'desktop/operation-delegate.js'].map(name => [name, sha(name)]));
    const product = { schema: 'tavern-release/v2', commit, candidate: false, dirty: false, versions: { tavern: '2.5.5' },
        artifacts: Object.fromEntries(Object.entries(actors).map(([name, hash]) => ['ops/installer/' + name, hash])) };
    write(delivery, 'release-manifest.json', product);
    const baselineTag = 'v2.5.4', baselineCommit = 'b'.repeat(40), tag = 'v2.5.5';
    const plan = { schema: 'nora-release-plan/v1', source: { commit }, baseline: { ref: baselineTag, commit: baselineCommit }, mode: 'components', requiresReview: false };
    write(planRoot, 'release-plan.json', plan);
    for (const platform of COMPONENT_PLATFORMS) {
        const [os, arch] = platform.split('-');
        const runtime = { schema: 1, platform: os, arch, archive: 'runtime.tar.gz', sha256: sha('runtime'), size: 7 };
        const dependencies = { schema: 1, platform: os, arch, archive: 'dependencies.tar.gz', sha256: sha('dependencies'), size: 12 };
        const payload = { ...product, hermesRuntime: runtime, dependencies };
        const contents = { 'release-manifest.json': payload, 'nora-hermes-runtime.json': runtime,
            'nora-tavern-dependencies.json': dependencies, 'runtime.tar.gz': 'runtime', 'dependencies.tar.gz': 'dependencies' };
        const files = {};
        for (const [name, value] of Object.entries(contents)) {
            const content = bytes(value), asset = `${platform}-${name}`; write(delivery, asset, content);
            files[name] = { asset, size: Buffer.byteLength(content), sha256: sha(content) };
        }
        const system = { schema: 'nora-system/v1', platform: os, arch, commit, candidate: false, channel: 'stable', version: '2.5.5', files };
        const systemFile = write(delivery, `nora-system-${platform}.json`, system);
        const directory = path.join(reports, `nora-component-native-${platform}`); fs.mkdirSync(directory);
        const source = { schema: 'nora-acceptance-baseline/1', mode: 'materialized', platform, tag: baselineTag, commit: baselineCommit,
            version: '2.5.4', payloadManifestSha256: sha('baseline'), verifiedFiles: 1, declaredFiles: 1,
            verifiedNames: ['release-manifest.json'], files: { 'release-manifest.json': { sha256: sha('baseline') } } };
        const receiptFile = write(directory, 'baseline-source-receipt.json', source);
        const identity = { platform, commit, baselineTag, baselineCommit, baselineVersion: '2.5.4', baselineManifestSha256: source.payloadManifestSha256,
            sourceReceiptSha256: sha(fs.readFileSync(receiptFile)), targetVersion: '2.5.5', targetManifestSha256: sha(bytes(payload)),
            systemManifestSha256: sha(fs.readFileSync(systemFile)), runtimeSha256: runtime.sha256 };
        const states = {};
        for (const state of ['fresh', 'running', 'stopped']) {
            const value = { schema: 'nora-launcher-products-smoke/1', outcome: 'passed', platform: os, arch,
                releaseManifestSha256: identity.targetManifestSha256, runtimeSha256: runtime.sha256,
                actorSourceBinding: 'verified-selected-candidate-manifest', actorSourceFiles: actors,
                operation: 'verified', runtime: 'verified', firstInstall: 'verified', http: 'verified', hermesSkills: 'verified', mcp: 'verified', stop: 'verified',
                executorHandles: 'verified-closed', userData: 'retained', userConfigurationDigest: sha('configuration'),
                update: 'verified-content-transition', changedSourceArtifacts: 1, releaseAcceptance: 'isolated-version-transition', updateInitialService: state,
                componentTransition: { ...identity, startState: state, installedVersion: '2.5.5' } };
            if (state === 'fresh') {
                delete value.componentTransition;
                Object.assign(value, { committedFirstInstall: 'verified-real-resume-without-reinstall',
                    missingSystemReceipt: 'verified-bound-repair-and-preserved-user-data', update: 'verified-noop', changedSourceArtifacts: 0,
                    releaseAcceptance: 'isolated-same-version-repair', updateInitialService: 'running',
                    componentInstallation: { platform, commit, targetVersion: '2.5.5', targetManifestSha256: identity.targetManifestSha256, installedVersion: '2.5.5' } });
            }
            const file = write(directory, `${state}/harness-result.json`, value); states[state] = sha(fs.readFileSync(file));
        }
        write(directory, 'component-native-acceptance.json', { schema: 'nora-component-native-acceptance/1', outcome: 'passed', identity, states });
    }
    const output = path.join(reports, 'component-acceptance.json');
    const receipt = sealComponentAcceptance({ delivery, reports, plan, output, commit, tag });
    return { delivery, reports, planRoot, plan, commit, baselineTag, baselineCommit, tag, receipt, output, write };
}
