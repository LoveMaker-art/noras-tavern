"""Exercise the host's ClawNest binary with a separate socket and synthetic apps.

Never connects to the production manager. No model requests or real state.
"""
import argparse
import json
import os
from pathlib import Path
import shutil
import socket
import subprocess
import sys
import tempfile
import time
from types import SimpleNamespace
from unittest.mock import patch
import urllib.request

OPS = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(OPS / 'updater'))
import maintenance
from service_manager import ManagedService, digest
from update import module_at


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--binary', default='/usr/local/bin/supervisord')
    args = parser.parse_args()
    with tempfile.TemporaryDirectory(prefix='tavern-managed-qa-') as temporary:
        home = Path(temporary).resolve()
        app = home / 'apps/tavern-runtime'
        state = home / 'tavern-state'
        conf = home / '.clawling/supervisord'
        tx = home / 'transaction'
        for p in (app, state, conf, tx): p.mkdir(parents=True)
        shutil.copyfile(OPS / 'tests/fixtures/maintenance-server.py', app / 'server.py')
        engine = app / 'engine/sillytavern'; engine.mkdir(parents=True)
        (engine / 'server.js').write_text("setTimeout(()=>require('http').createServer((q,r)=>{r.setHeader('Content-Type','application/json');r.end(JSON.stringify({ok:true,token:'fixture',runtime:'node'}))}).listen(Number(process.argv[process.argv.indexOf('--port')+1]),'127.0.0.1'),1500);")
        with socket.socket() as sock:
            sock.bind(('127.0.0.1', 0)); port = sock.getsockname()[1]
        service_file = conf / 'tavern.conf'
        service_file.write_text(f'[program:tavern-runtime]\ncommand={sys.executable} -B server.py {port}\ndirectory={app}\nautostart=true\nautorestart=true\nstartsecs=2\nstopwaitsecs=15\nstopasgroup=true\nkillasgroup=true\nstdout_logfile={home}/server.log\nstderr_logfile={home}/server.error.log\n')
        (conf / 'sentinel.conf').write_text(f'[program:sentinel]\ncommand=/bin/sleep 3600\nautostart=true\nautorestart=true\nstartsecs=0\nstdout_logfile={home}/sentinel.log\nstderr_logfile={home}/sentinel.error.log\n')
        manager_config = home / 'supervisord.conf'
        manager_config.write_text(f'[supervisord]\nlogfile={home}/manager.log\npidfile={home}/manager.pid\n[unix_http_server]\nfile={home}/manager.sock\n[include]\nfiles={conf}/*.conf\n')
        with (home / 'manager-console.log').open('wb') as log:
            child = subprocess.Popen([args.binary, '-c', str(manager_config)], stdout=log, stderr=log)
        service = None
        def discover(*unused):
            return ManagedService.discover(home, app, manager_config=manager_config, binary=args.binary)
        def health(expected=None):
            deadline = time.monotonic() + 15
            while time.monotonic() < deadline:
                try:
                    with urllib.request.urlopen(f'http://127.0.0.1:{port}/api/health',timeout=1) as r: value=json.load(r)
                    if value.get('ok') and (not expected or value.get('runtime')==expected): return value
                except (OSError,ValueError): pass
                time.sleep(0.1)
            raise AssertionError('Fixture service not healthy')
        try:
            health()
            service = discover()
            sentinel = service.rpc.getProcessInfo('sentinel')['pid']
            original = service_file.read_bytes()
            lifecycle = SimpleNamespace(source_runtime='python',port=port,
                u=SimpleNamespace(home=home,state=state,targets={'app':app}))
            with patch.object(maintenance, 'managed_service', side_effect=discover):
                maintenance.pause(lifecycle,tx)
                assert not maintenance.port_open(port)
                record=json.loads((tx/'maintenance.json').read_text())
                module=module_at('qa_native_runtime',OPS.parent/'app/native_lifecycle.py')
                runtime=module.NativeRuntime(home,app,state,SimpleNamespace(source_dir='engine/sillytavern',commit='a'*40))
                runtime.verify_install=lambda: None
                runtime.managed_service=discover
                node=service.node_text(runtime.node_command(port,runtime.native_data_root),engine)
                record['nodeServiceHash']=digest(node.encode()); (tx/'maintenance.json').write_text(json.dumps(record))
                service.install_text(node,accepted_hash=record['service']['descriptor']['sha256'])
                runtime.start(port=port,assets_prepared=True); health('node')
                runtime.stop_run(); assert not maintenance.port_open(port)
                runtime.start(port=port,assets_prepared=True); health('node')
                maintenance.resume(lifecycle,tx); health()
                assert service_file.read_bytes()==original
                assert service.rpc.getProcessInfo('sentinel')['pid']==sentinel
                # Reproduce rc.3's half-finished receipt after an external restart.
                legacy={k:v for k,v in record.items() if k not in ('service','nodeServiceHash')}
                (tx/'maintenance.json').write_text(json.dumps(legacy))
                maintenance.resume(lifecycle,tx)
                assert int((state/'server.pid').read_text())==service.pid()
            print(json.dumps({'managedPythonStop':True,'managedNodeStart':True,'managedNodeRestart':True,
                              'pythonConfigurationAndProcessRestored':True,'unfinishedLegacyReceiptRecovered':True,
                              'unrelatedProcessUnchanged':True,'productionTouched':False}))
        except BaseException:
            for p in (home/'manager-console.log',home/'manager.log',home/'server.error.log'):
                if p.exists(): print(p.name,p.read_text(errors='replace')[-4500:],file=sys.stderr)
            raise
        finally:
            if service:
                for name in ('tavern-runtime','sentinel'):
                    try: service.rpc.stopProcess(name,True)
                    except Exception: pass
            child.terminate()
            child.wait(timeout=15)


if __name__=='__main__': main()
