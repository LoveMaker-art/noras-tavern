import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { auditWorldArchitecture } from '../../../../ops/scripts/audit-world-architecture.mjs';

const fixture = JSON.parse(fs.readFileSync(
    new URL('./fixtures/nora-world-phase0/known-failures.json', import.meta.url),
    'utf8',
));

test('the architecture audit proves every Phase 0 failure has a current resolution seam', () => {
    const audit = auditWorldArchitecture(fileURLToPath(new URL('../../../..', import.meta.url)));
    const expectedIds = fixture.scenarios.map(scenario => scenario.id).sort();
    const auditedIds = audit.findings.map(finding => finding.id).sort();

    assert.deepEqual(auditedIds, expectedIds);
    assert.equal(audit.resolved, audit.total);
    for (const finding of audit.findings) {
        assert.equal(finding.resolved, true, `${finding.id} has no complete resolution evidence`);
        assert.ok(finding.evidence.length > 0, `${finding.id} must cite current source evidence`);
    }
});

test('every known failure defines an observable target outcome', () => {
    assert.equal(fixture.schema, 'nora-world-phase0-known-failures/v1');
    assert.equal(fixture.scenarios.length, 4);
    for (const scenario of fixture.scenarios) {
        assert.ok(scenario.runtime_observation.length > 20);
        assert.ok(scenario.target_outcome.length > 20);
    }
});
