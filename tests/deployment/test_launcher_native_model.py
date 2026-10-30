"""Production Electron helper + real writer delegation + native SDK loopback.

Uses synthetic isolated data. No browser, public provider or production service.
"""
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import yaml
from ops.installer.hermes_model_state import read_verified_model

if __package__:
    from . import test_nora_native_model as fixtures
    from .launcher_test_environment import resolve_node
else:
    import test_nora_native_model as fixtures
    from launcher_test_environment import resolve_node


ROOT = Path(__file__).resolve().parents[2]
RUNNER = r'''
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {spawn}=require('node:child_process'),{createRequire}=require('node:module');
const spec=JSON.parse(fs.readFileSync(0,'utf8'));
const main=path.join(spec.source,'ops/installer/desktop/main.js'), req=createRequire(main);
const {parse}=req('acorn'), source=fs.readFileSync(main,'utf8');
const tree=parse(source,{ecmaVersion:'latest'});
const node=tree.body.find(n=>n.type==='FunctionDeclaration'&&n.id.name==='runModelConfigHelper');
const select=tree.body.find(n=>n.type==='FunctionDeclaration'&&n.id.name==='modelConfigScript');
const {acquire}=req('./operation-lock');
const installer=path.join(spec.source,'ops/installer');
(async()=>{
 const lease=spec.workflow?null:await acquire({directory:path.join(spec.home,'installer/operations'),
   operationId:require('node:crypto').randomUUID(),ownerEpoch:1});
 const context=vm.createContext({spawn,path,fs,require:req,
   diagnostics:{addSecret(){},write(){},error(){},event(){},clean:value=>value},
   findPython:()=>({command:spec.python,args:[]}),installerRoot:()=>installer,
   installRoot:()=>path.join(spec.home,'tavern'),
   hermesHome:()=>path.join(spec.home,'hermes'),launcherEnv:()=>spec.env,
   consumeLines:req('./process-output').consumeLines,
   launcherError:req('./launcher-errors').launcherError,setTimeout,clearTimeout,
   spawnMaintenance:(command,args,options)=>(lease||context.activeOperationContext.lease).spawn(command,
     ['-B','-u',path.join(installer,'operation_control.py'),'--delegate-exec',...args],
     {...options,kind:'python-maintenance',managedPythonRoot:spec.managedPython,
      venvHome:path.join(spec.hermes,'venv')})});
 try {
   context.modelConfigScript=vm.runInContext('('+source.slice(select.start,select.end)+')',context);
   if(context.modelConfigScript()!==path.join(spec.home,'tavern/apps/tavern-ops/installer/model_config.py'))
     throw new Error('Desktop did not select the shared installed core');
   const run=vm.runInContext('('+source.slice(node.start,node.end)+')',context);
   if(spec.workflow){
     const recoverers={},recheckers={},errors=new Map();
     const policy=req('./operation-policy').create({home:spec.home,hermesHome:path.join(spec.home,'hermes'),
       installRoot:path.join(spec.home,'tavern'),bridge:async()=>({}),runRuntime:async()=>({})});
     const controller=req('./operation-state').createOperationController({directory:path.join(spec.home,'installer'),
       lock:req('./operation-lock'),recoverers,recheckers,observeEffects:record=>policy.observe(record),
       projectResult:value=>value?.value??value});
     Object.assign(context,{activeRun:false,modelBusy:false,statusRequest:null,activeOperationContext:null,
       telemetry:null,operationErrors:errors,operations:()=>controller,noraHome:()=>spec.home,
       rememberOperationFailure:(error,record)=>errors.set(record.operationId,error),finishOperationTelemetry(){},
       publicProviders:()=>[],configurationFingerprint:req('./model-config').configurationFingerprint,
       uninstall:{own:()=> 'isolated-native-test'},verifyWorkflowResult:req('./operation-result').verifyWorkflowResult,
       sendBridgeEvent(){},runBridge:async()=>({gatewayRunning:false}),
       diagnostics:{...context.diagnostics,begin(){},scope:(_id,_data,work)=>work()}});
     let committed=false,failFinalRead=true;
     context.runModelConfigHelper=async payload=>{
       if(payload.action==='inspect'&&committed&&failFinalRead)throw new Error('fixture final read lost after native deletion');
       const value=await run(payload);if(payload.action==='delete')committed=true;return value;
     };
     for(const name of ['requireOperationResult','runOwnedTask','savedModelCatalog','savedModelRequest',
       'deleteSavedModel','recoverModelConfiguration','recheckSavedModelOperation']){
       const declaration=tree.body.find(item=>item.type==='FunctionDeclaration'&&item.id.name===name);
       vm.runInContext(source.slice(declaration.start,declaration.end),context);
     }
     recoverers.model=context.recoverModelConfiguration;recheckers.model=context.recheckSavedModelOperation;
     let failure;
     try{await context.deleteSavedModel({sender:{}},{id:spec.payload.id,runId:'real-delete-requery'});}
     catch(error){failure=error;}
     if(!failure?.operation||!committed)throw new Error('Expected the real native delete to commit before the injected read failure');
     failFinalRead=false;
     const checked=await controller.recheck(failure.operation.operationId);
     const next=await context.runOwnedTask('start',{},async()=>({verification:'confirmed',value:{ok:true}}));
     process.stdout.write(JSON.stringify({ok:true,value:{before:failure.operation,after:checked,next:next.operation}}));
     return;
   }
   try{const value=await run(spec.payload);process.stdout.write(JSON.stringify({ok:true,value}));}
   catch(error){process.stdout.write(JSON.stringify({ok:false,message:error.message,
     status:error.status,code:error.code,failureStage:error.modelFailureStage,
     description:req('./launcher-errors').describeError(error),guidance:req('./error-presentation').presentError(error,{action:'model'})}));}
 }finally{await lease?.release();}
})().catch(error=>{process.stderr.write(error.stack);process.exitCode=1;});
'''


@unittest.skipUnless(os.environ.get('NORA_TEST_HERMES'), 'Actual installed Hermes required')
class LauncherNativeModelTests(unittest.TestCase):
    def setUp(self):
        self.fixture = fixtures.NativeModelIntegrationTests('test_go_marker_keeps_old_schema_and_contains_no_credentials')
        self.fixture.setUp()
        self.addCleanup(self.fixture.doCleanups)
        self.f = self.fixture
        for name in ('model_config.py', 'operation_cli.py', 'operation_control.py', 'error_diagnostics.py'):
            shutil.copy2(ROOT / 'ops/installer' / name, self.f.core / name)
        self.node = resolve_node()
        self.runner = self.f.root / 'desktop-native-model.cjs'
        self.runner.write_text(RUNNER, encoding='utf-8')
        self.requests = []
        self.reject_requests = False
        outer = self

        class Handler(BaseHTTPRequestHandler):
            def do_GET(self):
                self.send_response(404)
                self.end_headers()

            def do_POST(self):
                body = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
                outer.requests.append((self.path, body, outer.f.config.read_bytes()))
                status = 401 if outer.reject_requests else 200
                response = ({'error': {'message': 'fixture credential rejected'}} if outer.reject_requests else
                    {'id': 'fixture-response', 'type': 'message', 'role': 'assistant',
                     'model': body.get('model'), 'content': [{'type': 'text', 'text': 'OK'}],
                     'stop_reason': 'end_turn', 'usage': {'input_tokens': 1, 'output_tokens': 1},
                     'choices': [{'message': {'content': 'OK'}, 'finish_reason': 'stop'}]})
                data = json.dumps(response).encode()
                if status == 200 and self.path.endswith(':generateContent'):
                    data = json.dumps({'candidates': [{'content': {'role': 'model',
                        'parts': [{'text': 'OK'}]}, 'finishReason': 'STOP'}],
                        'usageMetadata': {'promptTokenCount': 1, 'candidatesTokenCount': 1,
                                          'totalTokenCount': 2}}).encode()
                if status == 200 and self.path.endswith('/responses'):
                    item = {'id': 'msg_fixture', 'type': 'message', 'role': 'assistant',
                            'status': 'completed', 'content': [{'type': 'output_text',
                            'text': 'OK', 'annotations': []}]}
                    final = {'id': 'resp_fixture', 'object': 'response', 'status': 'completed',
                             'model': body.get('model'), 'output': [item],
                             'usage': {'input_tokens': 1, 'output_tokens': 1, 'total_tokens': 2}}
                    events = [{'type': 'response.output_text.delta', 'output_index': 0,
                               'content_index': 0, 'delta': 'OK', 'sequence_number': 0},
                              {'type': 'response.output_item.done', 'output_index': 0,
                               'item': item, 'sequence_number': 1},
                              {'type': 'response.completed', 'response': final,
                               'sequence_number': 2}]
                    data = ''.join('event: '+value['type']+'\ndata: '+json.dumps(value)+'\n\n'
                                   for value in events).encode()
                if status == 200 and body.get('stream') and self.path.endswith('/messages'):
                    start = {**response, 'content': [], 'stop_reason': None}
                    events = [('message_start', {'type': 'message_start', 'message': start}),
                        ('content_block_start', {'type': 'content_block_start', 'index': 0,
                            'content_block': {'type': 'text', 'text': ''}}),
                        ('content_block_delta', {'type': 'content_block_delta', 'index': 0,
                            'delta': {'type': 'text_delta', 'text': 'OK'}}),
                        ('content_block_stop', {'type': 'content_block_stop', 'index': 0}),
                        ('message_delta', {'type': 'message_delta', 'delta': {'stop_reason': 'end_turn'},
                            'usage': {'output_tokens': 1}}),
                        ('message_stop', {'type': 'message_stop'})]
                    data = ''.join('event: '+event+'\ndata: '+json.dumps(value)+'\n\n'
                                   for event, value in events).encode()
                self.send_response(status)
                self.send_header('Content-Type', 'text/event-stream' if data.startswith(b'event:') else 'application/json')
                self.send_header('Content-Length', str(len(data)))
                self.end_headers()
                self.wfile.write(data)

            def log_message(self, *_args):
                pass

        self.server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.addCleanup(self.server.server_close)
        self.addCleanup(self.server.shutdown)
        self.base = f'http://127.0.0.1:{self.server.server_port}/v1'
        self.f.env.pop('NORA_FIXTURE_MODEL_PROBE', None)
        self.f.env['NORA_NETWORK_ALLOWED_PORT'] = str(self.server.server_port)
        # Allow the real authenticated local guard socket in addition to the
        # model fixture. HTTP guards still reject every other logical URL.
        guard = fixtures.LOOPBACK_NETWORK_GUARD.replace(
            'def check_address(address):\n',
            "def check_address(address):\n    endpoint = os.environ.get('NORA_OPERATION_DELEGATE_ENDPOINT', '')\n"
            "    if isinstance(address, tuple) and endpoint == str(address[0])+':'+str(address[1]):\n        return\n")
        self.f.guard_file.write_text(guard, encoding='utf-8')
        self.payload = {'action': 'configure', 'provider': 'custom', 'keyEnv': '',
                        'model': 'loopback-model', 'key': fixtures.SYNTHETIC_KEY,
                        'baseUrl': self.base, 'authMode': 'key', 'tavernSyncPending': True}

    def desktop(self, payload=None, *, workflow=False):
        spec = {'source': str(ROOT), 'home': str(self.f.root), 'hermes': str(self.f.source),
                'python': sys.executable, 'managedPython': os.environ['NORA_TEST_MANAGED_PYTHON_ROOT'],
                'env': self.f.env, 'payload': payload or self.payload, 'workflow':workflow}
        result = subprocess.run([self.node, str(self.runner)], input=json.dumps(spec),
            capture_output=True, text=True, timeout=90, env={
                'PATH': os.environ.get('PATH', ''), 'HOME': str(self.f.root),
                'USERPROFILE': str(self.f.root), 'TMPDIR': str(self.f.root),
                'SystemRoot': os.environ.get('SystemRoot', ''),
                'WINDIR': os.environ.get('WINDIR', ''), 'COMSPEC': os.environ.get('COMSPEC', '')})
        self.assertNotIn(fixtures.SYNTHETIC_KEY, result.stdout + result.stderr)
        self.assertEqual(result.returncode, 0, result.stderr)
        return json.loads(result.stdout)

    def test_real_launcher_helper_validates_before_commit_and_reads_same_saved_selection(self):
        before = self.f.config.read_bytes()
        result = self.desktop()
        self.assertTrue(result['ok'], result)
        self.assertTrue(result['value']['verified'])
        generated = [request for request in self.requests if request[0] == '/v1/chat/completions']
        self.assertEqual(len(generated), 1, 'Native metadata probes must not count as model generations')
        self.assertEqual(generated[0][2], before, 'Live selection changed before the native response')
        marker = json.loads(self.f.marker.read_text())
        self.assertTrue(marker['tavernSyncPending'])
        self.assertEqual(marker['validation'], 'api-response')
        saved = yaml.safe_load(self.f.config.read_text())['model']
        self.assertEqual(saved['provider'], 'custom:nora-launcher')
        requests_before_read = len(self.requests)
        viewed = self.desktop({'action': 'inspect'})
        self.assertTrue(viewed['ok'], viewed)
        self.assertEqual(viewed['value']['model'], saved['default'])
        self.assertEqual(viewed['value']['provider'], saved['provider'])
        committed = self.desktop({'action':'inspect-outcome',
                                 'operationId':marker['lastModelOperation']['operationId']})
        self.assertTrue(committed['value']['confirmed'], committed)
        self.assertEqual(committed['value']['action'], 'configure')
        self.assertEqual(len(self.requests), requests_before_read, 'Reading a model must not call it again')
        self.assertTrue(read_verified_model(self.f.root, self.f.home, allow_pending=True))
        self.assertFalse(read_verified_model(self.f.root, self.f.home), 'First-use sync remains pending')
        self.assertTrue(self.desktop({'action': 'verify-runtime'})['ok'])
        self.f.assert_preserved()

    def test_real_helper_deletes_native_connection_without_generation_or_user_data_changes(self):
        first = self.desktop({**self.payload, 'model':'remove-model',
                              'key':'delete-route-key', 'baseUrl':self.base + '/first', 'authMode':'key'})
        self.assertTrue(first['ok'], first)
        target = first['value']['selectedId']
        second = self.desktop({**self.payload, 'model':'keep-model',
                               'key':'keep-route-key', 'baseUrl':self.base + '/second', 'authMode':'key'})
        self.assertTrue(second['ok'], second)
        selected = second['value']['selectedId']
        requests = len(self.requests)
        result = self.desktop({'action':'delete', 'id':target})
        self.assertTrue(result['ok'], result)
        self.assertEqual(len(self.requests), requests, 'Deletion must never call inference')
        inspected = self.desktop({'action':'inspect'})['value']
        self.assertEqual(inspected['selectedId'], selected)
        self.assertNotIn(target, {row['id'] for row in inspected['models']})
        self.assertNotIn('delete-route-key', self.f.config.read_text())
        self.assertIn('keep-route-key', self.f.config.read_text())
        operation_id = json.loads(self.f.marker.read_text())['lastModelOperation']['operationId']
        proof = self.desktop({'action':'inspect-outcome', 'operationId':operation_id})['value']
        self.assertTrue(proof['confirmed'], proof)
        self.assertEqual(proof['profileId'], target)
        self.assertEqual(proof['action'], 'delete')
        self.assertEqual(proof['current']['selectedId'], selected)
        self.assertEqual(len(self.requests), requests, 'Outcome recheck must never generate a request')
        cache = self.f.home / 'provider_models_cache.json'
        original_cache = cache.read_bytes() if cache.exists() else None
        cache.write_text('{"foreign-refresh":{}}')
        self.assertFalse(self.desktop({'action':'inspect-outcome', 'operationId':operation_id})['value']['confirmed'])
        if original_cache is None:
            cache.unlink()
        else:
            cache.write_bytes(original_cache)
        self.f.assert_preserved()

    def test_real_delete_refusal_keeps_the_native_reason_in_public_guidance(self):
        self.assertTrue(self.desktop()['ok'])
        current = self.desktop({'action':'inspect'})['value']['selectedId']
        before = self.f.snapshot()
        result = self.desktop({'action':'delete', 'id':current})
        self.assertFalse(result['ok'])
        self.assertEqual(result['failureStage'], 'candidate')
        self.assertEqual(result['code'], 'MODEL_DELETE_REFUSED')
        self.assertIn('当前默认', result['guidance']['detail'])
        self.f.assert_snapshot(before)

    def test_real_desktop_delete_rechecks_same_native_commit_and_releases_admission(self):
        first = self.desktop({**self.payload, 'model':'remove-model', 'baseUrl':self.base + '/first'})
        second = self.desktop({**self.payload, 'model':'keep-model', 'baseUrl':self.base + '/second'})
        self.assertTrue(first['ok'], first)
        self.assertTrue(second['ok'], second)
        count = len(self.requests)
        result = self.desktop({'id':first['value']['selectedId']}, workflow=True)['value']
        self.assertEqual(result['before']['recoveryOutcome'], 'recovery-required')
        self.assertEqual(result['after']['operationId'], result['before']['operationId'])
        self.assertEqual(result['after']['state'], 'succeeded')
        self.assertEqual(result['after']['recoveryOutcome'], 'not-required')
        self.assertEqual(result['after']['result']['selectedId'], second['value']['selectedId'])
        self.assertEqual(result['next']['state'], 'succeeded', 'Scheduling proof; no real service is started')
        self.assertEqual(len(self.requests), count, 'Delete and recheck never call a model')
        self.f.assert_preserved()

    def test_real_unauthorized_failure_preserves_config_reports_status_and_can_retry(self):
        before = self.f.snapshot()
        self.reject_requests = True
        failed = self.desktop()
        self.assertFalse(failed['ok'], failed)
        self.assertEqual(failed['status'], 401)
        self.assertEqual(failed['failureStage'], 'candidate')
        self.assertEqual(failed['description']['error_code'], 'http_unauthorized')
        self.f.assert_snapshot(before)
        self.reject_requests = False
        succeeded = self.desktop()
        self.assertTrue(succeeded['ok'], succeeded)
        self.assertEqual(sum(request[0] == '/v1/chat/completions' for request in self.requests), 2)
        self.f.assert_preserved()

    def test_saved_connection_switch_uses_real_helper_and_sdk_without_reentering_key(self):
        first = self.desktop()
        self.assertTrue(first['ok'], first)
        a = self.desktop({'action': 'inspect'})['value']['selectedId']
        other = {**self.payload, 'model': 'second-loopback-model',
                 'baseUrl': self.base.replace('/v1', '/second/v1')}
        second = self.desktop(other)
        self.assertTrue(second['ok'], second)
        catalog = self.desktop({'action': 'inspect'})['value']
        b = catalog['selectedId']
        self.assertNotEqual(a, b)
        self.assertIn(a, [row['id'] for row in catalog['models']])
        switched = self.desktop({'action': 'switch', 'id': a})
        self.assertTrue(switched['ok'], switched)
        self.assertEqual(self.desktop({'action': 'inspect'})['value']['selectedId'], a)
        generated = [request for request in self.requests if request[0].endswith('/chat/completions')]
        self.assertEqual(generated[-1][0], '/v1/chat/completions')
        self.assertEqual(generated[-1][1]['model'], 'loopback-model')
        before = self.f.snapshot()
        self.reject_requests = True
        rejected = self.desktop({'action': 'switch', 'id': b})
        self.assertFalse(rejected['ok'], rejected)
        self.assertEqual(rejected['failureStage'], 'candidate')
        self.assertEqual(rejected['status'], 401)
        self.f.assert_snapshot(before)
        self.reject_requests = False
        retried = self.desktop({'action': 'switch', 'id': b})
        self.assertTrue(retried['ok'], retried)
        generated = [request for request in self.requests if request[0].endswith('/chat/completions')]
        self.assertEqual(generated[-1][0], '/second/v1/chat/completions')
        self.assertEqual(generated[-1][1]['model'], 'second-loopback-model')
        self.f.assert_preserved()

    def test_changed_native_route_overrides_snapshot_and_remains_reusable_after_addition(self):
        self.assertTrue(self.desktop()['ok'])
        config = yaml.safe_load(self.f.config.read_text())
        config['providers']['custom:nora-launcher'].update(
            base_url=self.base.replace('/v1','/changed/v1'),api_key='rotated-synthetic-route-key')
        self.f.config.write_text(yaml.safe_dump(config))
        self.assertFalse(read_verified_model(self.f.root,self.f.home,allow_pending=True))
        viewed=self.desktop({'action':'inspect'})['value']
        self.assertEqual(viewed['baseUrl'],self.base.replace('/v1','/changed/v1'))
        prior=viewed['selectedId']
        switched=self.desktop({'action':'switch','id':prior})
        self.assertTrue(switched['ok'],switched)
        self.assertTrue(read_verified_model(self.f.root,self.f.home,allow_pending=True))
        generated=[request for request in self.requests if request[0].endswith('/chat/completions')]
        self.assertEqual(generated[-1][0],'/changed/v1/chat/completions')
        added=self.desktop({**self.payload,'model':'third-model','baseUrl':self.base.replace('/v1','/third/v1')})
        self.assertTrue(added['ok'],added)
        catalog=self.desktop({'action':'inspect'})['value']
        self.assertNotIn('modelsProblem',catalog)
        saved=next(row for row in catalog['models'] if row['id']==prior)
        self.assertEqual(saved['baseUrl'],self.base.replace('/v1','/changed/v1'))
        self.assertTrue(saved['available'])
        self.assertTrue(self.desktop({'action':'switch','id':prior})['ok'])
        generated=[request for request in self.requests if request[0].endswith('/chat/completions')]
        self.assertEqual(generated[-1][0],'/changed/v1/chat/completions')
        self.assertTrue(read_verified_model(self.f.root,self.f.home,allow_pending=True))
        self.f.assert_preserved()

    def test_existing_cloud_form_providers_share_native_candidate_and_real_sdk_transports(self):
        # Preserve each form provider's real default route and native request.
        # Only the final HTTP destination is redirected to the local server;
        # this proves integration, not access to paid provider accounts.
        # Public catalog/context discovery is an independent network leaf;
        # replace it here, never the native generation builder or transport.
        with self.f.guard_file.open('a', encoding='utf-8') as guard:
            guard.write("\nfrom agent import model_metadata, models_dev\n"
                        "model_metadata.fetch_model_metadata = lambda *a, **k: {}\n"
                        "model_metadata.get_model_context_length = lambda *a, **k: 128000\n"
                        "model_metadata._query_anthropic_context_length = lambda *a, **k: None\n"
                        "models_dev._fetch_models_dev_from_network = lambda **k: ({}, '')\n"
                        "from hermes_cli import model_catalog, models_reasoning_caps, providers\n"
                        "model_catalog._fetch_manifest_with_fallback = lambda *a, **k: None\n"
                        "models_reasoning_caps._fetch_reasoning_caps_catalog = lambda *a, **k: None\n"
                        "original_provider_lookup = providers.get_provider\n"
                        "providers.get_provider = lambda name, **kwargs: original_provider_lookup(name, allow_network=False)\n"
                        "native_sdk_send = httpx.Client.send\n"
                        "def route_native_sdk(client, request, *args, **kwargs):\n"
                        "    url = urlsplit(str(request.url))\n"
                        "    if url.hostname in {'openrouter.ai','api.deepseek.com','api.anthropic.com','api.openai.com','generativelanguage.googleapis.com'} and url.path.endswith(('/chat/completions','/messages','/responses',':generateContent')):\n"
                        "        request.url = httpx.URL('http://127.0.0.1:'+str(port)+url.path)\n"
                        "    return native_sdk_send(client, request, *args, **kwargs)\n"
                        "httpx.Client.send = route_native_sdk\n")
        from ops.installer.model_config import PROVIDER_KEYS
        for provider, model in [('openrouter', 'qwen/qwen3-8b'), ('deepseek', 'deepseek-v4-flash'),
                                ('anthropic', 'claude-haiku-4-5-20251001'),
                                ('openai-api', 'gpt-4.1-mini'), ('gemini', 'gemini-2.5-flash')]:
            with self.subTest(provider=provider):
                before = self.f.config.read_bytes()
                prior = len(self.requests)
                result = self.desktop({**self.payload, 'provider': provider,
                                       'model': model, 'baseUrl': '', 'keyEnv': PROVIDER_KEYS[provider]})
                self.assertTrue(result['ok'], result)
                self.assertTrue(result['value']['verified'])
                generated = [request for request in self.requests[prior:]
                             if request[0].endswith(('/chat/completions', '/messages', '/responses', ':generateContent'))]
                self.assertEqual(len(generated), 1)
                self.assertEqual(generated[0][2], before)
                marker = json.loads(self.f.marker.read_text())
                self.assertEqual(marker['provider'], provider)
                self.assertEqual(marker['model'], model)
                self.assertEqual(marker['validation'], 'api-response')
                self.assertTrue(read_verified_model(self.f.root, self.f.home, allow_pending=True))
                self.assertTrue(self.desktop({'action': 'verify-runtime'})['ok'])
                self.f.assert_preserved()
