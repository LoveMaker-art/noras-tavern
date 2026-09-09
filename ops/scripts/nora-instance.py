"""Operate only the configured Nora instance, including standalone Hermes installs."""
import argparse
import json
import os
from pathlib import Path
import subprocess
import sys
from urllib.parse import urlparse


def configuration(home):
    home = Path(home).resolve()
    if not (home / "nora-instance.json").is_file():
        # Existing standalone installations keep their reviewed MCP binding.
        import yaml
        config = yaml.safe_load((home / "config.yaml").read_text(encoding="utf-8"))
        mcp = config["mcp_servers"]["nora"]["env"]
        url = urlparse(mcp["NORA_MCP_BASE_URL"])
        state = Path(mcp["NORA_MCP_STATE_ROOT"]).resolve()
        if url.scheme != "http" or url.hostname != "127.0.0.1" or not url.port or state.name != "tavern-state":
            raise RuntimeError("Legacy Nora instance requires an explicit local MCP binding")
        return {"schema": 0, "hermesHome": str(home), "installRoot": str(state.parent), "port": url.port}
    value = json.loads((home / "nora-instance.json").read_text(encoding="utf-8"))
    root = Path(value["installRoot"]).resolve()
    parent = Path(value["noraHome"]).resolve()
    if (value.get("schema") != 1 or Path(value["hermesHome"]).resolve() != home
            or root == home or root == parent or home == parent
            or not root.is_relative_to(parent) or not home.is_relative_to(parent)
            or type(value.get("port")) is not int or not 1024 <= value["port"] <= 65535):
        raise RuntimeError("Invalid Nora instance configuration")
    return value


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("operation", choices=("check", "status", "start", "stop", "recover-existing", "app-link"))
    args = parser.parse_args()
    home = Path(os.environ.get("HERMES_HOME", Path(__file__).resolve().parents[1])).resolve()
    config = configuration(home)
    root, port = Path(config["installRoot"]), config["port"]
    if args.operation == "check":
        print(json.dumps({"ok": True, "port": port}))
        return 0
    env = {**os.environ, "HERMES_HOME": str(home), "TAVERN_DATA_ROOT": str(root)}
    if args.operation == "app-link":
        import importlib.util
        script = root / "apps/tavern-ops/updater/liveware_integration.py"
        spec = importlib.util.spec_from_file_location("nora_entry", script)
        integration = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(integration)
        options = {"hermes_home": home} if config["schema"] == 1 else {}
        entry = integration.verified_entry(root, port, **options)
        if entry.get("status") != "ready":
            print(json.dumps(entry, ensure_ascii=False))
            return 1
        print(entry["url"])
        return 0
    if args.operation == "recover-existing":
        # The shared registration worker owns greeting order, retries and App identity.
        script = root / "apps/tavern-ops/updater/liveware_integration.py"
        command = [str(script), "--home", str(root)]
        if config["schema"] == 1:
            command += ["--hermes-home", str(home), "--port", str(port), "--no-start-runtime"]
        command.append("startup")
    else:
        command = [str(root / "apps/tavern-runtime/native_lifecycle.py"), args.operation]
        if args.operation != "stop":
            command += ["--port", str(port)]
    return subprocess.run([sys.executable, "-B", *command], env=env, check=False).returncode


if __name__ == "__main__":
    raise SystemExit(main())
