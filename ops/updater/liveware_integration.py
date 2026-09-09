"""Bind the two existing Liveware Apps; network failures never undo local code."""
import json
from contextlib import contextmanager
import fcntl
import os
from pathlib import Path
import re
import shutil
import socket
import subprocess
import sys
import tempfile
import time
import urllib.request
from urllib.parse import urlencode

sys.path.insert(0, str(Path(__file__).resolve().parent))

ROLES = {
    "console": ("Tavern", ""),
    "actor": ("Story Profile", "/_liveware/story-profile"),
}
ASSET_RELEASE_PATTERN = re.compile(r"^[a-f0-9]{12,64}$", re.IGNORECASE)
LIVEWARE_DOMAIN_PATTERN = re.compile(r"^[A-Za-z0-9-]+\.apps\.clawling\.io$")
LIVEWARE_APP_ID_PATTERN = re.compile(r"^app-[A-Za-z0-9]+$")
RETRY_DELAYS = (0, 2, 5, 10, 20, 30, 60, 60, 60, 60)


def safe_error(error):
    text = getattr(error, "stderr", None) or str(error)
    if isinstance(text, bytes):
        text = text.decode("utf-8", errors="replace")
    text = re.sub(r"eyJ[A-Za-z0-9_.-]+|sk-[A-Za-z0-9_-]+", "<REDACTED>", text)
    text = re.sub(r"(?i)(bearer|access[_-]?token|token)([\s=:\"']+)[^\s\"',}]+", r"\1\2<REDACTED>", text)
    return text.strip()[:1200]


@contextmanager
def registration_lock(home, worker=False):
    path = Path(home) / "tavern-state" / ("liveware-worker.lock" if worker else "liveware-registration.lock")
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a+") as stream:
        try:
            fcntl.flock(stream.fileno(), fcntl.LOCK_EX | (fcntl.LOCK_NB if worker else 0))
        except BlockingIOError:
            yield False
            return
        try:
            yield True
        finally:
            fcntl.flock(stream.fileno(), fcntl.LOCK_UN)


def authenticate(home):
    identity = launcher(home, "liveware_login")
    if not identity.get("user_id") or not identity.get("instance_id"):
        raise RuntimeError("Current ClawChat/Liveware identity is not ready")
    return {key: identity[key] for key in ("user_id", "instance_id")}


def runtime_asset_release(port=8799):
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    request = urllib.request.Request(
        f"http://127.0.0.1:{port}/version",
        headers={"Accept": "application/json", "Cache-Control": "no-store"},
    )
    with opener.open(request, timeout=10) as response:
        payload = response.read(65537)
        if response.status != 200 or len(payload) > 65536:
            raise RuntimeError("Tavern 资源版本接口不可用")
    value = json.loads(payload)
    release = value.get("assetRelease") if isinstance(value, dict) else None
    if not isinstance(release, str) or not ASSET_RELEASE_PATTERN.fullmatch(release):
        raise RuntimeError("Tavern 未返回有效的资源版本")
    return release.lower()


def release_launcher_url(domain, release):
    if not isinstance(domain, str) or not LIVEWARE_DOMAIN_PATTERN.fullmatch(domain):
        raise ValueError("Liveware App 域名无效")
    if not isinstance(release, str) or not ASSET_RELEASE_PATTERN.fullmatch(release):
        raise ValueError("Tavern 资源版本无效")
    return f"https://{domain}/?{urlencode({'release': release.lower()})}"


def listed_apps(home):
    value = launcher(home, "list_apps")
    value = value.get("apps", value.get("data", [])) if isinstance(value, dict) else value
    if not isinstance(value, list) or any(not isinstance(item, dict) for item in value):
        raise RuntimeError("ClawChat 返回了未知的 App 列表")
    return value


def active_apps(home):
    value = json.loads(cli(home, "app", "list", "--json"))
    if not isinstance(value, list) or any(not isinstance(item, dict) for item in value):
        raise RuntimeError("Liveware 返回了未知的 App 列表")
    return [item for item in value if item.get("status") == "active"]


def atomic_json(path, value):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary = tempfile.mkstemp(prefix="." + path.name + ".", dir=path.parent)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as stream:
            json.dump(value, stream, ensure_ascii=False, indent=2)
            stream.write("\n")
            stream.flush()
            os.fsync(stream.fileno())
        os.chmod(temporary, 0o600)
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def binary(home):
    candidates = [
        os.environ.get("LIVEWARE_BIN"),
        shutil.which("liveware"),
        "/opt/clawnest/bin/liveware",
        str(Path(home) / "clawchat/liveware/liveware"),
    ]
    return next((value for value in candidates if value and Path(value).is_file()), None)


def environment(home):
    env = {**os.environ, "HOME": str(home), "HERMES_HOME": str(home)}
    for key in ("LIVEWARE_TOKEN", "LIVEWARE_INSTANCE_ID", "LIVEWARE_API_URL"):
        env.pop(key, None)
    saved = Path(home) / ".clawling/liveware.json"
    if saved.is_file():
        value = json.loads(saved.read_text(encoding="utf-8"))
        for key, field in (
            ("LIVEWARE_TOKEN", "token"),
            ("LIVEWARE_API_URL", "apiUrl"),
            ("LIVEWARE_INSTANCE_ID", "instanceId"),
        ):
            if value.get(field):
                env[key] = value[field]
    return env


def cli(home, *args):
    executable = binary(home)
    if not executable:
        raise RuntimeError("未找到 Liveware CLI")
    result = subprocess.run(
        [executable, *args],
        env=environment(home),
        text=True,
        capture_output=True,
        timeout=45,
        check=False,
    )
    if result.returncode:
        raise RuntimeError(safe_error(result.stderr or result.stdout or f"Liveware exit {result.returncode}"))
    return result.stdout


def launcher(home, operation, **parameters):
    plugin = Path(os.environ.get("CLAWCHAT_PLUGIN_DIR") or Path(home) / "plugins/clawchat")
    code = (
        "import asyncio,json,sys;from pathlib import Path;sys.path.insert(0,sys.argv[1]);"
        "from clawchat_gateway import tools;"
        "from clawchat_gateway.profile import load_profile_config;"
        "before=load_profile_config().user_id;"
        "value=asyncio.run(getattr(tools,sys.argv[2])(**json.load(sys.stdin)));"
        "\nif sys.argv[2]=='liveware_login' and value.get('ok') is True:"
        "\n after=load_profile_config().user_id"
        "\n if before!=after: raise RuntimeError('ClawChat identity changed during login')"
        "\n saved=json.loads((Path.home()/'.clawling/liveware.json').read_text())"
        "\n value.update(user_id=after,instance_id=saved.get('instanceId'))"
        "\nprint(json.dumps(value))"
    )
    env = environment(home)
    if operation == "liveware_login":
        for key in ("LIVEWARE_TOKEN", "LIVEWARE_INSTANCE_ID", "LIVEWARE_API_URL"):
            env.pop(key, None)
    result = subprocess.run(
        [sys.executable, "-B", "-c", code, str(plugin), operation],
        input=json.dumps(parameters),
        text=True,
        capture_output=True,
        env=env,
        timeout=45,
        check=True,
    )
    value = json.loads(result.stdout)
    if isinstance(value, dict) and (value.get("error") or value.get("ok") is False or value.get("success") is False):
        raise RuntimeError("ClawChat 启动器操作失败：" + operation + ": " + safe_error(value.get("message") or value.get("error") or "unknown"))
    return value


def normalized_name(value):
    return str(value or "").strip().casefold()


def app_identity(app, title):
    app_id, domain = app.get("appId"), app.get("domain")
    if not isinstance(app_id, str) or not LIVEWARE_APP_ID_PATTERN.fullmatch(app_id):
        raise RuntimeError("Liveware App ID 无效：" + title)
    if not isinstance(domain, str) or not LIVEWARE_DOMAIN_PATTERN.fullmatch(domain):
        raise RuntimeError("Liveware App 域名无效：" + title)
    return {"app_id": app_id, "domain": domain, "name": title, "liveware_name": title}


def created_identity(output, title):
    app_id = re.search(r"(?m)^appId\s+(app-[A-Za-z0-9]+)\s*$", output or "")
    domain = re.search(r"(?m)^domain\s+([A-Za-z0-9-]+\.apps\.clawling\.io)\s*$", output or "")
    if not app_id or not domain:
        return None
    return app_identity({"appId": app_id.group(1), "domain": domain.group(1)}, title)


def resolve_identity(home, document, role, title, available, *, create_missing):
    saved = document.get(role, {}) if isinstance(document.get(role), dict) else {}
    saved_id = saved.get("app_id")
    by_id = [item for item in available if saved_id and item.get("appId") == saved_id]
    if len(by_id) == 1:
        return app_identity(by_id[0], title), available

    expected_name = normalized_name(title)
    by_name = [item for item in available if normalized_name(item.get("name")) == expected_name]
    if len(by_name) == 1:
        return app_identity(by_name[0], title), available
    if len(by_name) > 1:
        raise RuntimeError("存在多个同名 Liveware App，无法安全选择：" + title)
    if not create_missing:
        return None, available

    pending = document.setdefault("_creating", {})
    if role in pending:
        raise RuntimeError(title + " 上次创建结果不确定，等待平台列表确认；不会重复创建")
    pending[role] = {"started_at": int(time.time())}
    atomic_json(Path(home) / "tavern-state/apps.json", document)
    output = cli(home, "app", "create", title, "--agent-type", "hermes")
    identity = created_identity(output, title)
    if identity:
        available = [*available, {
            "appId": identity["app_id"],
            "domain": identity["domain"],
            "name": title,
            "status": "active",
        }]
        return identity, available

    for _ in range(15):
        available = active_apps(home)
        by_name = [item for item in available if normalized_name(item.get("name")) == normalized_name(title)]
        if len(by_name) == 1:
            return app_identity(by_name[0], title), available
        if len(by_name) > 1:
            raise RuntimeError("创建后出现多个同名 Liveware App：" + title)
        time.sleep(1)
    raise RuntimeError("Liveware App 创建后未能确认：" + title)


def sync_launcher(home, desired, rows, owned_ids):
    title = desired["name"]
    role_rows = [
        item for item in rows
        if item.get("app_id") == desired["app_id"]
        or (item.get("app_id") in owned_ids and normalized_name(item.get("name")) == normalized_name(title))
    ]
    current = {key: role_rows[0].get(key) for key in desired} if len(role_rows) == 1 else None
    if current == desired:
        return rows

    affected_ids = {item.get("app_id") for item in role_rows if item.get("app_id")}
    previous = [item for item in rows if item.get("app_id") in affected_ids]
    try:
        for app_id in sorted(affected_ids):
            launcher(home, "unregister_app", app_id=app_id)
        launcher(home, "register_app", **desired)
    except Exception:
        for item in previous:
            restore = {key: item.get(key) for key in desired}
            if all(restore.values()):
                try:
                    launcher(home, "register_app", **restore)
                except Exception:
                    pass
        raise

    rows = listed_apps(home)
    role_rows = [
        item for item in rows
        if item.get("app_id") == desired["app_id"]
        or (item.get("app_id") in owned_ids and normalized_name(item.get("name")) == normalized_name(title))
    ]
    verified = {key: role_rows[0].get(key) for key in desired} if len(role_rows) == 1 else None
    if verified != desired:
        raise RuntimeError(title + " 启动器入口未收敛为唯一记录")
    return rows


def bind_with_retry(home, app_id, target, attempts=5):
    error = None
    for attempt in range(attempts):
        try:
            cli(home, "tunnel", "bind", app_id, target)
            return
        except Exception as current:
            error = current
            if attempt + 1 < attempts:
                time.sleep(2)
    raise RuntimeError(f"Liveware 隧道绑定连续失败 {attempts} 次：{error}")


def reconcile(home, port=8799, *, create_missing=False):
    with registration_lock(home):
        ready_path = Path(home) / "tavern-state/liveware-ready.json"
        atomic_json(ready_path, {"status": "pending"})
        try:
            owner = authenticate(home)
            result = _reconcile(home, port, create_missing=create_missing, owner=owner)
            if result.get("status") == "updated":
                atomic_json(ready_path, {
                    "status": "ready", "owner": owner, "host": socket.gethostname(),
                    "port": port, "assetRelease": result["assetRelease"],
                })
            return result
        except Exception as error:
            return {"status": "local-installed-liveware-pending", "warnings": [safe_error(error)]}


def _reconcile(home, port=8799, *, create_missing=False, owner):
    home = Path(home)
    path = home / "tavern-state/apps.json"
    if not path.is_file() and not create_missing:
        return {"status": "not-configured", "warnings": ["未找到既有 Liveware App；需要首次初始化"]}
    document = json.loads(path.read_text(encoding="utf-8")) if path.is_file() else {}
    if not isinstance(document, dict):
        return {"status": "local-installed-liveware-pending", "warnings": ["Liveware 身份文件格式无效"]}
    release = runtime_asset_release(port)
    warnings = []
    try:
        available = active_apps(home)
    except Exception as error:
        return {
            "status": "local-installed-liveware-pending",
            "warnings": ["无法读取 Liveware App：" + safe_error(error)],
            "assetRelease": release,
        }

    if document.get("_owner") != owner:
        # Saved IDs remain candidates, never proof of ownership.
        document.pop("_creating", None)
        document["_owner"] = owner
        atomic_json(path, document)
    resolved = {}
    for role, (title, prefix) in ROLES.items():
        try:
            identity, available = resolve_identity(
                home, document, role, title, available, create_missing=create_missing,
            )
        except Exception as error:
            warnings.append(f"{title} 身份恢复失败：{error}")
            continue
        if identity is None:
            warnings.append(title + " 缺少可恢复的 Liveware App")
            continue
        pending = document.get("_creating", {})
        if document.get(role) != identity or role in pending:
            pending.pop(role, None)
            document[role] = identity
            atomic_json(path, document)
        resolved[role] = identity

    identities = [item["app_id"] for item in resolved.values()]
    if len(identities) != len(set(identities)):
        return {"status": "local-installed-liveware-pending", "warnings": ["Tavern 与 Story Profile 错误地共用了同一个 App ID"]}

    launcher_rows = None
    for role, (title, prefix) in ROLES.items():
        app = resolved.get(role)
        if not app:
            continue
        app_id, domain = app["app_id"], app["domain"]
        try:
            bind_with_retry(home, app_id, f"http://127.0.0.1:{port}{prefix}")
            desired = {"app_id": app_id, "name": title, "url": release_launcher_url(domain, release)}
            if launcher_rows is None:
                launcher_rows = listed_apps(home)
            launcher_rows = sync_launcher(home, desired, launcher_rows, {item.get("appId") for item in available})
        except Exception as error:
            warnings.append(f"{title} 刷新失败：{error}")
    return {
        "status": "updated" if not warnings and len(resolved) == len(ROLES) else "local-installed-liveware-pending",
        "warnings": warnings,
        "assetRelease": release,
    }


def refresh(home, port=8799):
    return reconcile(home, port, create_missing=False)


def repair(home, port=8799):
    return reconcile(home, port, create_missing=True)


def initialize(home, port=8799):
    return repair(home, port)


def start_runtime(home):
    app = Path(home) / "apps/tavern-runtime"
    result = subprocess.run(
        [sys.executable, "-B", str(app / "native_lifecycle.py"), "start"],
        env={**os.environ, "HERMES_HOME": str(home), "TAVERN_DATA_ROOT": str(home)},
        capture_output=True, text=True, check=False,
    )
    if result.returncode:
        raise RuntimeError("Tavern runtime start failed: " + safe_error(result.stderr))
    return result.returncode


def ensure(home, port=8799):
    home = Path(home)
    for delay in RETRY_DELAYS:
        if delay:
            time.sleep(delay)
        try:
            start_runtime(home)
            result = repair(home, port)
        except Exception as error:
            result = {"status": "local-installed-liveware-pending", "warnings": [safe_error(error)]}
        if result.get("status") == "updated":
            return result
        print(json.dumps(result, ensure_ascii=False), file=sys.stderr, flush=True)
    return result


def verified_entry(home, port=8799):
    with registration_lock(home):
        try:
            owner = authenticate(home)
            document = json.loads((Path(home) / "tavern-state/apps.json").read_text())
            if document.get("_owner") != owner:
                raise RuntimeError("Entry ownership has not been verified for this instance")
            release = runtime_asset_release(port)
            ready = json.loads((Path(home) / "tavern-state/liveware-ready.json").read_text())
            if ready != {"status": "ready", "owner": owner, "host": socket.gethostname(), "port": port, "assetRelease": release}:
                raise RuntimeError("This instance has not completed tunnel and launcher reconciliation")
            available, rows = active_apps(home), listed_apps(home)
            urls = {}
            for role, (title, _) in ROLES.items():
                app = document[role]
                matches = [item for item in available if item.get("appId") == app.get("app_id")]
                if len(matches) != 1 or app_identity(matches[0], title) != app:
                    raise RuntimeError(title + " identity is not verified")
                url = release_launcher_url(app["domain"], release)
                matches = [item for item in rows if item.get("app_id") == app["app_id"]]
                if len(matches) != 1 or matches[0].get("url") != url or matches[0].get("name") != title:
                    raise RuntimeError(title + " launcher is not ready")
                urls[role] = url
            return {"status": "ready", "owner": owner, "url": urls["console"], "urls": urls}
        except Exception as error:
            return {"status": "pending", "warnings": [safe_error(error)]}


def startup(home):
    with registration_lock(home, worker=True) as acquired:
        if not acquired:
            return {"status": "already-running"}
        # Local availability must not depend on activation or message delivery.
        for delay in RETRY_DELAYS:
            if delay:
                time.sleep(delay)
            try:
                start_runtime(home)
                break
            except Exception as error:
                print(safe_error(error), file=sys.stderr, flush=True)
        else:
            return {"status": "runtime-start-failed"}
        # The model greeting runs independently; only Liveware readiness gates the entry.
        result = ensure(home)
        if result.get("status") != "updated":
            return result
        for delay in RETRY_DELAYS:
            if delay:
                time.sleep(delay)
            try:
                from liveware_notice import notify_ready
                notice = notify_ready(home, verified_entry(home))
                if notice.get("status") in ("sent", "already-sent"):
                    return {**result, "notice": notice}
            except Exception as error:
                print(safe_error(error), file=sys.stderr, flush=True)
        return {**result, "notice": {"status": "pending"}}


def main():
    import argparse
    parser = argparse.ArgumentParser()
    parser.add_argument("--home", type=Path, required=True)
    parser.add_argument("operation", choices=("ensure", "startup", "entry", "initialize", "recover-existing", "refresh"))
    args = parser.parse_args()
    if args.operation == "startup":
        result = startup(args.home)
    elif args.operation == "entry":
        result = verified_entry(args.home)
    elif args.operation == "ensure":
        result = ensure(args.home)
    elif args.operation == "initialize":
        result = initialize(args.home)
    else:
        if args.operation == "recover-existing":
            start_runtime(args.home)
        result = refresh(args.home)
    print(json.dumps(result, ensure_ascii=False))
    if result.get("status") not in ("updated", "ready", "already-running"):
        raise SystemExit(1)


if __name__ == "__main__":
    main()
