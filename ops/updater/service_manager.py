"""Shared ownership of one Tavern service in ClawNest's process manager.

No daemon is installed or restarted. Unmanaged installations retain their
existing subprocess lifecycle. Only an exact reviewed Tavern program is owned.
"""
import configparser
import glob
import hashlib
import http.client
import io
import os
from pathlib import Path
import shlex
import socket
import subprocess
import tempfile
import time
import xmlrpc.client


def digest(data):
    return hashlib.sha256(data).hexdigest()


def checked(path):
    path = Path(os.path.abspath(path))
    if any(p.is_symlink() for p in (path, *path.parents)):
        raise ValueError('Service configuration symlink requires review')
    return path


def parse(text):
    config = configparser.ConfigParser(interpolation=None)
    config.read_string(text)
    return config


class UnixTransport(xmlrpc.client.Transport):
    def __init__(self, path):
        super().__init__()
        self.path = path

    def make_connection(self, host):
        connection = http.client.HTTPConnection('localhost', timeout=40)
        def connect():
            connection.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
            connection.sock.settimeout(40)
            connection.sock.connect(self.path)
        connection.connect = connect
        return connection


class ManagedService:
    def __init__(self, descriptor):
        self.descriptor = descriptor
        self.file = checked(descriptor['file'])
        self.name = descriptor['name']
        self.rpc = xmlrpc.client.ServerProxy('http://localhost/RPC2',
            transport=UnixTransport(descriptor['socket'])).supervisor

    @classmethod
    def discover(cls, home, app, *, manager_config=None, binary=None):
        home, app = Path(home).resolve(), Path(app).resolve()
        if manager_config is None:
            try:
                args = Path('/proc/1/cmdline').read_bytes().decode().strip('\0').split('\0')
            except FileNotFoundError:
                return None
            if Path(args[0]).name != 'supervisord':
                return None
            binary = str(Path('/proc/1/exe').resolve())
            manager_config = next((args[i + 1] for i, arg in enumerate(args[:-1])
                                   if arg in ('-c', '--configuration')), None)
            if not manager_config:
                raise ValueError('Process manager configuration is not explicit')
        main = checked(manager_config)
        config = parse(main.read_text())
        files = {str(main): digest(main.read_bytes())}
        for pattern in shlex.split(config.get('include', 'files', fallback='')):
            for file in glob.glob(str(main.parent / pattern)):
                path = checked(file)
                files[str(path)] = digest(path.read_bytes())
        found = []
        scripts = {app / 'server.py', app / 'backend/server.py', app / 'engine/sillytavern/server.js'}
        for file in files:
            document = parse(Path(file).read_text())
            for section in document.sections():
                if not section.startswith('program:'):
                    continue
                values = document[section]
                directory = Path(values.get('directory', '/')).resolve()
                args = shlex.split(values.get('command', ''))
                matches = args and Path(args[0]).name.startswith(('python', 'node')) and any(
                    (directory / arg).resolve() in scripts for arg in args[1:] if not arg.startswith('-'))
                if not matches:
                    continue
                if len(document.sections()) != 1 or not Path(file).is_relative_to(home / '.clawling/supervisord'):
                    raise ValueError('Tavern must have a dedicated host-owned service configuration')
                found.append({'file': file, 'sha256': files[file], 'name': section.split(':', 1)[1],
                              'main': str(main), 'binary': str(binary), 'files': files,
                              'socket': config.get('unix_http_server', 'file'),
                              'command': values['command'], 'directory': str(directory)})
        if len(found) > 1:
            raise ValueError('Multiple managers own this Tavern installation')
        if not found:
            return None
        version = subprocess.check_output([str(binary), 'version'], text=True, timeout=5)
        if 'clawnest' not in version.lower():
            raise ValueError('Unreviewed supervisor implementation; refuse lifecycle mutation')
        service = cls(found[0])
        service.info()  # Verify management access before the maintenance window.
        return service

    def info(self):
        value = self.rpc.getProcessInfo(self.name)
        if value.get('name') != self.name:
            raise ValueError('Process manager returned a different service')
        return value

    def pid(self):
        value = self.info()
        return int(value.get('pid') or 0) if str(value.get('statename', '')).lower() in ('running', 'starting') else 0

    def stop(self):
        if self.pid():
            self.rpc.stopProcess(self.name, True)
        if self.pid():
            raise ValueError('Managed Tavern did not stop')

    def start(self):
        if not self.pid():
            self.rpc.startProcess(self.name, True)
        deadline = time.monotonic() + 20
        while time.monotonic() < deadline:
            value = self.info()
            if str(value.get('statename', '')).lower() == 'running' and value.get('pid'):
                return int(value['pid'])
            time.sleep(0.1)
        raise ValueError('Managed Tavern did not reach running state')

    def snapshot(self):
        data = self.file.read_bytes()
        if digest(data) != self.descriptor['sha256']:
            raise ValueError('Service configuration changed since review')
        return {'descriptor': self.descriptor, 'text': data.decode(), 'mode': self.file.stat().st_mode & 0o777}

    def install_text(self, text, *, accepted_hash, mode=0o600):
        current = self.file.read_bytes()
        if digest(current) not in (accepted_hash, digest(text.encode())):
            raise ValueError('Service configuration changed outside this update')
        for name, sha in self.descriptor['files'].items():
            if name != str(self.file) and digest(checked(name).read_bytes()) != sha:
                raise ValueError('Another manager configuration changed; refuse global reload')
        before = {p['name']: p.get('pid') for p in self.rpc.getAllProcessInfo() if p['name'] != self.name}
        if current != text.encode():
            fd, temporary = tempfile.mkstemp(prefix='.tavern-service-', dir=self.file.parent)
            try:
                with os.fdopen(fd, 'w') as stream:
                    stream.write(text); stream.flush(); os.fsync(stream.fileno())
                os.chmod(temporary, mode)
                os.replace(temporary, self.file)
            finally:
                if os.path.exists(temporary):
                    os.unlink(temporary)
        # ClawNest reloads only changed programs, unlike a daemon restart.
        self.rpc.reloadConfig()
        after = {p['name']: p.get('pid') for p in self.rpc.getAllProcessInfo() if p['name'] != self.name}
        if before != after:
            raise ValueError('Unrelated process changed during manager reload; inspect manager log')
        self.descriptor = {**self.descriptor, 'sha256': digest(text.encode())}

    def node_text(self, command, directory):
        config = parse(self.file.read_text())
        section = config['program:' + self.name]
        section['command'] = shlex.join(command)
        section['directory'] = str(directory)
        section['autostart'] = 'true'
        section['autorestart'] = 'true'
        section['stopasgroup'] = 'true'
        section['killasgroup'] = 'true'
        stream = io.StringIO(); config.write(stream)
        return stream.getvalue()
