"""Browser evidence is not a release gate; automated failures still block."""
import json
from pathlib import Path
import subprocess
import unittest


ROOT = Path(__file__).resolve().parents[2]


class ReleaseGateTests(unittest.TestCase):
    def run_node(self, source):
        return subprocess.run(['node', '--input-type=module', '-e', source],
                              cwd=ROOT, capture_output=True, text=True, timeout=15)

    def test_stable_packaging_without_browser_report_still_enforces_audit(self):
        # Run the real packager with isolated process boundaries. No npm install,
        # network request or publication is performed by this policy test.
        result = self.run_node('''
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
childProcess.execFileSync = (command, args) => {
    if (command === 'git') {
        if (args[0] === 'rev-parse') return 'a'.repeat(40);
        if (['status', 'ls-tree'].includes(args[0])) return '';
        if (args[0] === 'archive') return Buffer.alloc(0);
    }
    if (command === 'tar') return Buffer.alloc(0);
    if (command === 'npm' && args[0] === 'ci') return Buffer.alloc(0);
    if (command === 'npm' && args.join(' ') === 'audit --omit=dev --audit-level=moderate') {
        throw new Error('TEST_AUDIT_REFUSED');
    }
    throw new Error('Unexpected process: ' + command + ' ' + args.join(' '));
};
syncBuiltinESMExports();
await import('./ops/scripts/package-release.mjs');
''')
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('TEST_AUDIT_REFUSED', result.stderr)

    def run_workflows(self, fail_call=0):
        # Isolate child test results to exercise the real workflow aggregator's
        # success/failure contract, not the product workflows themselves.
        return self.run_node('''
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
let calls = 0;
childProcess.spawnSync = () => ({
    status: ++calls === FAIL_CALL ? 1 : 0, stdout: '', stderr: '',
});
syncBuiltinESMExports();
await import('./ops/scripts/verify-product-workflows.mjs');
'''.replace('FAIL_CALL', str(fail_call)))

    def test_automated_success_does_not_claim_browser_acceptance(self):
        result = self.run_workflows()
        self.assertEqual(result.returncode, 0, result.stderr)
        report = json.loads(result.stdout)
        self.assertTrue(report['technical']['passed'])
        self.assertEqual(len(report['technical']['workflows']), 5)
        self.assertTrue(report['technical']['architectureContracts']['passed'])
        self.assertFalse(report['browser']['required'])
        self.assertFalse(report['browser']['passed'])
        self.assertIsNone(report['browser']['report'])

    def test_automated_workflow_failure_still_blocks(self):
        result = self.run_workflows(fail_call=1)
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse(json.loads(result.stdout)['technical']['passed'])

    def test_architecture_contract_failure_still_blocks(self):
        result = self.run_workflows(fail_call=6)
        self.assertNotEqual(result.returncode, 0)
        report = json.loads(result.stdout)
        self.assertEqual(len(report['technical']['workflows']), 5)
        self.assertFalse(report['technical']['passed'])
        self.assertFalse(report['technical']['architectureContracts']['passed'])


if __name__ == '__main__':
    unittest.main()
