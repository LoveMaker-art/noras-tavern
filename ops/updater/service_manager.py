"""Small adapter for the ClawNest supervisor that owns Tavern."""
import configparser
import glob
import http.client
import io
import os
from pathlib import Path
import shlex
import socket
import tempfile
import time
import xmlrpc.client


def parse(text):
    document = configparser.ConfigParser(interpolation=None)
    document.read_string(text)
    return document


class UnixTransport(xmlrpc.client.Transport):
    def __init__(self, path):
        super().__init__()
        self.path = path

    def make_connection(self, host):
        connection = http.client.HTTPConnection("localhost", timeout=40)
        def connect():
            connection.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
            connection.sock.settimeout(40)
            connection.sock.connect(self.path)
        connection.connect = connect
        return connection


class ManagedService:
    def __init__(self, descriptor):
        self.descriptor = descriptor
        self.file = Path(descriptor["file"])
        self.name = descriptor["name"]
        self.rpc = xmlrpc.client.ServerProxy(
            "http://localhost/RPC2",
            transport=UnixTransport(descriptor["socket"]),
        ).supervisor

    @classmethod
    def discover(cls, home, app, *, manager_config=None, binary=None):
        home, app = Path(home).resolve(), Path(app).resolve()
        if manager_config is None:
            try:
                argv = Path("/proc/1/cmdline").read_bytes().split(b"\0")
            except OSError:
                return None
            if not argv or Path(os.fsdecode(argv[0])).name != "supervisord":
                return None
            values = [os.fsdecode(value) for value in argv if value]
            manager_config = next(
                (values[index + 1] for index, value in enumerate(values[:-1])
                 if value in ("-c", "--configuration")),
                None,
            )
            if not manager_config:
                return None
        main = Path(manager_config)
        document = parse(main.read_text(encoding="utf-8"))
        files = [main]
        for pattern in shlex.split(document.get("include", "files", fallback="")):
            files.extend(Path(name) for name in glob.glob(str(main.parent / pattern)))
        matches = []
        for file in files:
            child = parse(file.read_text(encoding="utf-8"))
            for section in child.sections():
                if not section.startswith("program:"):
                    continue
                command = child[section].get("command", "")
                directory = child[section].get("directory", "")
                try:
                    configured_directory = Path(directory).expanduser().resolve()
                except (OSError, RuntimeError):
                    configured_directory = None
                command_paths = []
                for value in shlex.split(command):
                    candidate = Path(value).expanduser()
                    if candidate.is_absolute():
                        try:
                            command_paths.append(candidate.resolve())
                        except (OSError, RuntimeError):
                            pass
                if configured_directory != app and app not in command_paths:
                    continue
                if not any(name in command for name in ("server.py", "server.js")):
                    continue
                matches.append({
                    "file": str(file),
                    "name": section.split(":", 1)[1],
                    "socket": document.get("unix_http_server", "file"),
                    "command": command,
                    "directory": directory,
                })
        if not matches:
            return None
        matches.sort(key=lambda item: (item["file"], item["name"]))
        return cls(matches[0])

    def info(self):
        return self.rpc.getProcessInfo(self.name)

    def pid(self):
        value = self.info()
        return int(value.get("pid") or 0) if str(value.get("statename", "")).lower() in ("running", "starting") else 0

    def stop(self):
        if self.pid():
            self.rpc.stopProcess(self.name, True)

    def start(self):
        state = str(self.info().get("statename", "")).lower()
        if state not in ("running", "starting"):
            self.rpc.startProcess(self.name, True)
        deadline = time.monotonic() + 30
        while time.monotonic() < deadline:
            value = self.info()
            if str(value.get("statename", "")).lower() == "running" and value.get("pid"):
                return int(value["pid"])
            time.sleep(0.2)
        raise RuntimeError("Tavern 托管进程没有启动")

    def snapshot(self):
        return {"descriptor": self.descriptor, "text": self.file.read_text(encoding="utf-8"),
                "mode": self.file.stat().st_mode & 0o777}

    def node_text(self, command, directory):
        document = parse(self.file.read_text(encoding="utf-8"))
        section = document["program:" + self.name]
        section["command"] = shlex.join(command)
        section["directory"] = str(directory)
        section["autostart"] = "true"
        section["autorestart"] = "true"
        section["stopasgroup"] = "true"
        section["killasgroup"] = "true"
        stream = io.StringIO()
        document.write(stream)
        return stream.getvalue()

    def install_text(self, text, *, accepted_hash=None, mode=0o600):
        self.file.parent.mkdir(parents=True, exist_ok=True)
        fd, temporary = tempfile.mkstemp(prefix=".tavern-service-", dir=self.file.parent)
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as stream:
                stream.write(text)
                stream.flush()
                os.fsync(stream.fileno())
            os.chmod(temporary, mode)
            os.replace(temporary, self.file)
        finally:
            if os.path.exists(temporary):
                os.unlink(temporary)
        self.rpc.reloadConfig()

    def restore(self, snapshot):
        self.install_text(snapshot["text"], mode=snapshot["mode"])
