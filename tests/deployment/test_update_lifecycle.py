import io
import json
import os
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from contextlib import ExitStack
from unittest.mock import patch

from ops.installer import launcher_bridge as bridge
from ops.updater import update


class UpdateLifecycleTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()
        self.args = SimpleNamespace(nora_home=self.root, hermes_home=self.root / 'hermes',
                                    install_root=self.root / 'tavern', port=18899, command='update-lifecycle')

    def run_phase(self, phase, before, state):
        plan = {'phase': phase, 'before': before, 'version': '2.3.8',
                'noraHome': str(self.root), 'hermesHome': str(self.args.hermes_home),
                'installRoot': str(self.args.install_root)}
        with patch.object(bridge.sys, 'stdin', io.StringIO(json.dumps(plan))), \
                patch.object(bridge, 'command_stop') as stop, \
                patch.object(bridge, 'command_start') as start, \
                patch.object(bridge, 'status_payload', return_value=state), \
                patch.object(bridge, 'emit'):
            bridge.command_update_lifecycle(self.args)
            return stop.call_count, start.call_count, self.args.service

    def test_restore_each_pre_update_service_combination(self):
        for tavern, nora, service in [(True, True, 'all'), (True, False, 'tavern'),
                                      (False, True, 'nora'), (False, False, 'all')]:
            with self.subTest(tavern=tavern, nora=nora):
                before = {'running': tavern, 'gatewayRunning': nora, 'version': '2.3.7'}
                state = {**before, 'version': '2.3.8', 'systemReady': True}
                self.assertEqual(self.run_phase('verify', before, state), (1, int(tavern or nora), service))

    def test_preflight_only_checks_captured_version_and_service_state(self):
        before = {'version': '2.3.7', 'running': True, 'gatewayRunning': False}
        self.args.service = 'all'
        self.assertEqual(self.run_phase('preflight', before, before), (0, 0, 'all'))
        for changed in ({'version': '2.3.8'}, {'running': False}, {'gatewayRunning': True}):
            with self.subTest(changed=changed), self.assertRaises(SystemExit):
                self.run_phase('preflight', before, {**before, **changed})

    def test_preflight_rejects_wrong_instance_without_service_commands(self):
        plan = {'phase': 'preflight', 'before': {}, 'noraHome': str(self.root / 'other')}
        with patch.object(bridge.sys, 'stdin', io.StringIO(json.dumps(plan))), \
                patch.object(bridge, 'command_stop') as stop, patch.object(bridge, 'command_start') as start:
            with self.assertRaises(SystemExit):
                bridge.command_update_lifecycle(self.args)
            stop.assert_not_called()
            start.assert_not_called()

    def damaged_rollback(self, *, changes=None, phase='rollback', services=(True, True), problems=None):
        journal = self.args.install_root / 'tavern-updates/transaction.json'
        journal.parent.mkdir(parents=True, exist_ok=True)
        journal.write_text('{"schema":1,"status":"prepared"}')
        if problems is None:
            problems = ['技能文件内容与安装记录不一致：skills/creative/tavern/SKILL.md']
        before = {'version': '2.3.7', 'systemReady': False, 'systemProblems': problems,
                  'running': services[0], 'gatewayRunning': services[1], 'clawchatConnected': services[1]}
        state = {**before, **(changes or {})}
        system = {'ready': False, 'version': state['version'], 'problems': state['systemProblems']}
        plan = {'phase': phase, 'before': before, 'version': '2.3.8',
                'noraHome': str(self.root), 'hermesHome': str(self.args.hermes_home),
                'installRoot': str(self.args.install_root)}
        with ExitStack() as stack:
            stack.enter_context(patch.object(bridge.sys, 'stdin', io.StringIO(json.dumps(plan))))
            stack.enter_context(patch.object(bridge, 'command_stop'))
            stack.enter_context(patch.object(bridge, 'installed', return_value=True))
            stack.enter_context(patch.object(bridge.nora_system, 'inspect', return_value=system))
            stack.enter_context(patch.object(bridge, 'status_payload', return_value=state))
            stack.enter_context(patch.object(bridge, 'read_verified_model', return_value=True))
            stack.enter_context(patch.object(bridge, 'clawchat_paired', return_value=True))
            stack.enter_context(patch.object(bridge, 'sync_nora_profile'))
            stack.enter_context(patch.object(bridge, 'env_for', return_value={}))
            stack.enter_context(patch.object(bridge, 'python_command', return_value='isolated-python'))
            run = stack.enter_context(patch.object(bridge, 'run_stream'))
            gateway = stack.enter_context(patch.object(bridge, 'start_gateway'))
            verify = stack.enter_context(patch.object(bridge.nora_system, 'verify_runtime'))
            mark = stack.enter_context(patch.object(bridge.nora_system, 'mark_setup_complete'))
            emit = stack.enter_context(patch.object(bridge, 'emit'))
            if changes or phase != 'rollback':
                with self.assertRaises(SystemExit):
                    bridge.command_update_lifecycle(self.args)
                run.assert_not_called()
                gateway.assert_not_called()
            else:
                bridge.command_update_lifecycle(self.args)
                self.assertEqual(run.call_count, int(services[0]))
                if services[0]:
                    self.assertEqual(run.call_args.args[0][-3:], ['start', '--port', '18899'])
                self.assertEqual(gateway.call_count, int(services[1]))
                self.assertEqual(emit.call_args.kwargs['systemReady'], False)
                self.assertEqual(emit.call_args.kwargs['systemProblems'], problems)
            verify.assert_not_called()
            mark.assert_not_called()

    def test_damaged_old_skills_restore_each_service_without_claiming_ready(self):
        for services in ((True, True), (True, False), (False, True), (False, False)):
            with self.subTest(services=services):
                self.damaged_rollback(services=services)

    def test_rollback_rejects_changed_version_or_new_integrity_problem(self):
        for changes in ({'version': '2.3.8'}, {'systemProblems': ['MCP 配置缺失或无效']},
                        {'systemProblems': ['缺少系统组件：apps/tavern-runtime/native_lifecycle.py']},
                        {'systemProblems': ['技能文件缺失：skills/creative/tavern/SKILL.md']}):
            with self.subTest(changes=changes):
                self.damaged_rollback(changes=changes)

    def test_verify_never_accepts_preexisting_skill_damage(self):
        self.damaged_rollback(phase='verify')

    def test_missing_old_skill_also_restores_services_without_claiming_ready(self):
        self.damaged_rollback(problems=['技能文件缺失：skills/creative/tavern/SKILL.md',
                                        '缺少技能：creative/tavern'])

    def test_normal_start_cannot_opt_into_damaged_rollback(self):
        self.args.command = 'start'
        self.args.service = 'tavern'
        with patch.object(bridge, 'installed', return_value=True), \
                patch.object(bridge.nora_system, 'inspect', return_value={'ready': False, 'problems': ['技能文件缺失：x']}), \
                patch.object(bridge, 'run_stream') as run:
            with self.assertRaises(SystemExit):
                bridge.command_start(self.args)
            run.assert_not_called()

    def test_only_identical_skill_missing_or_mismatch_problems_qualify(self):
        for problems, allowed in [
            (['技能文件缺失：skills/creative/tavern/SKILL.md', '缺少技能：creative/tavern'], True),
            (['技能文件内容与安装记录不一致：skills/creative/tavern/SKILL.md'], True),
            (['MCP 配置缺失或无效'], False),
            (['缺少系统组件：apps/tavern-runtime/native_lifecycle.py'], False),
            (['技能文件无法读取：skills/creative/tavern/SKILL.md'], False),
            (['技能路径超出安装目录：other'], False),
            ([], False),
        ]:
            with self.subTest(problems=problems):
                self.assertEqual(bridge._same_skill_damage(
                    {'version': '2.3.7', 'systemReady': False, 'systemProblems': problems},
                    {'version': '2.3.7', 'problems': problems}), allowed)

    def test_successful_start_command_is_not_enough_if_health_is_false(self):
        with self.assertRaises(SystemExit):
            self.run_phase('verify', {'running': True},
                           {'version': '2.3.8', 'systemReady': True, 'running': False})

    def test_gateway_process_without_previous_connection_is_not_success(self):
        with self.assertRaises(SystemExit):
            self.run_phase('verify', {'gatewayRunning': True, 'clawchatConnected': True},
                           {'version': '2.3.8', 'systemReady': True, 'gatewayRunning': True, 'clawchatConnected': False})

    def test_rollback_checks_old_version_and_old_health(self):
        before = {'version': '2.3.7', 'systemReady': True, 'running': True}
        self.assertEqual(self.run_phase('rollback', before, before), (1, 1, 'tavern'))
        with self.assertRaises(SystemExit):
            self.run_phase('rollback', before, {**before, 'version': '2.3.8'})

    def test_lifecycle_transport_runs_real_python_and_requires_successful_exit(self):
        script = self.root / 'callback.py'
        script.write_text('import json,sys\np=json.load(sys.stdin)\n'
                          'print(json.dumps({"event":"result","systemReady":True,"version":p["version"]}))\n')
        plan = {'bridge': str(script), 'noraHome': str(self.root), 'port': 18899,
                'hermesHome': str(self.args.hermes_home), 'installRoot': str(self.args.install_root)}
        with patch.dict(os.environ, {'NORA_UPDATE_LIFECYCLE': json.dumps(plan)}):
            result = update.managed_lifecycle('verify', self.args.hermes_home, self.args.install_root, '2.3.8')
            self.assertTrue(result['systemReady'])
            script.write_text(script.read_text() + 'sys.exit(1)\n')
            with self.assertRaisesRegex(RuntimeError, '服务事务检查失败'):
                update.managed_lifecycle('verify', self.args.hermes_home, self.args.install_root, '2.3.8')

    def test_incomplete_transaction_cannot_start_outside_recovery(self):
        journal = self.args.install_root / 'tavern-updates/transaction.json'
        journal.parent.mkdir(parents=True)
        journal.write_text('{"status":"prepared"}')
        self.args.command = 'start'
        with patch.object(bridge, 'emit'), patch.object(bridge, 'run_stream') as run:
            with self.assertRaises(SystemExit):
                bridge.command_start(self.args)
            run.assert_not_called()

    def test_corrupted_journal_is_not_treated_as_success(self):
        journal = self.args.install_root / 'tavern-updates/transaction.json'
        journal.parent.mkdir(parents=True)
        journal.write_text('{broken')
        self.assertEqual(bridge.nora_system.update_recovery(self.args.install_root)['status'], 'unknown')


if __name__ == '__main__':
    unittest.main()
