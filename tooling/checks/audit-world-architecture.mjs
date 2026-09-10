#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const scriptRoot = path.dirname(fileURLToPath(import.meta.url));
const defaultProjectRoot = path.resolve(scriptRoot, '..', '..');

const checks = [
    {
        id: 'duplicate-world-on-retry',
        explanation: 'One durable backend operation owns World identity and repeated transport requests reuse its idempotency key.',
        evidence: [
            ['app/engine/sillytavern/src/nora-world-core/service.js', /operationIdForKey\(key\)/],
            ['app/engine/sillytavern/src/nora-world-core/service.js', /worldId:\s*this\.#createId\('world'\)/],
            ['app/native-extensions/nora-ui/world-creation-controller.js', /worldRuntime\.importCard\(file/],
        ],
        absence: [
            ['app/engine/sillytavern/public/scripts/nora-worlds/world-runtime.js', /createId|provisional|\.claim\(/],
            ['app/native-extensions/nora-ui/world-creation-controller.js', /runtime\.importCharacter|worldRuntime\.create\(/],
        ],
    },
    {
        id: 'world-hidden-by-projection-order',
        explanation: 'The UI lists authoritative manifests directly; opening hydrates the complete Runtime Card from the authoritative snapshot.',
        evidence: [
            ['app/engine/sillytavern/public/scripts/nora-worlds/world-core-runtime.js', /manifests = await client\.list\(\)/],
            ['app/engine/sillytavern/public/scripts/nora-worlds/world-core-runtime.js', /available:\s*lifecycleReady/],
            ['app/engine/sillytavern/public/scripts/nora-worlds/world-core-client.js', /runtime\.ensureCharacter\(snapshot\.character\)/],
        ],
        absence: [
            ['app/native-extensions/nora-ui/ui-store.js', /recentWorlds/],
            ['app/native-extensions/nora-ui/world-controller.js', /listRecentWorlds|recentWorlds/],
        ],
    },
    {
        id: 'empty-opening-looks-like-missing-world',
        explanation: 'A header-only Story Session is represented explicitly as an empty opening state and receives Nora product copy.',
        evidence: [
            ['app/engine/sillytavern/src/nora-world-core/domain.js', /opening_state:\s*materialization\.defaultSession\.openingState/],
            ['app/engine/sillytavern/public/scripts/nora-worlds/world-core-runtime.js', /openingState = session\?\.opening_state === 'empty'/],
            ['app/native-extensions/nora-ui/message-controller.js', /故事尚未开始/],
        ],
    },
    {
        id: 'capability-timeout-blocks-world-open',
        explanation: 'Base activation completes before capability work, whose failure is persisted as DEGRADED.',
        evidence: [
            ['app/native-extensions/nora-ui/world-controller.js', /worldRuntime\.activate[\s\S]*scheduleSupportingContent/],
            ['app/engine/sillytavern/src/nora-world-core/domain.js', /\['PENDING', 'READY', 'DEGRADED'\]/],
        ],
        absence: [
            ['app/engine/sillytavern/public/scripts/nora-worlds/world-runtime.js', /cardRuntime|waitForCharacterRuntime/],
        ],
    },
];

function readSources(projectRoot) {
    const cache = new Map();
    return (relativePath, { allowMissing = false } = {}) => {
        if (!cache.has(relativePath)) {
            const filePath = path.join(projectRoot, relativePath);
            if (allowMissing && !fs.existsSync(filePath)) return '';
            cache.set(relativePath, fs.readFileSync(filePath, 'utf8'));
        }
        return cache.get(relativePath);
    };
}

export function auditWorldArchitecture(projectRoot = defaultProjectRoot) {
    const read = readSources(path.resolve(projectRoot));
    const findings = checks.map((check) => {
        const present = check.evidence.map(([file, pattern]) => ({
            file,
            pattern: String(pattern),
            matched: pattern.test(read(file)),
        }));
        const absent = (check.absence || []).map(([file, pattern]) => ({
            file,
            pattern: String(pattern),
            absent: !pattern.test(read(file, { allowMissing: true })),
        }));
        return {
            id: check.id,
            resolved: present.every(item => item.matched) && absent.every(item => item.absent),
            explanation: check.explanation,
            evidence: present,
            missingExpectedSeam: absent,
        };
    });
    return {
        schema: 'nora-world-architecture-audit/v2',
        projectRoot: path.resolve(projectRoot),
        findings,
        resolved: findings.filter(finding => finding.resolved).length,
        total: findings.length,
    };
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
    const result = auditWorldArchitecture(process.argv[2] || defaultProjectRoot);
    console.log(JSON.stringify(result, null, 2));
    if (result.resolved !== result.total) process.exitCode = 1;
}
