"""Present installed Hermes authentication without owning provider protocols.

Runs inside the instance's short-lived model helper. Native credentials stay in
Hermes' stores; only authorization challenges leave this process. Authentication
does not select Nora's active model.
"""
from contextlib import contextmanager, redirect_stderr, redirect_stdout
import builtins
import io
import logging
from pathlib import Path
import re
import signal
import threading
from types import SimpleNamespace
from urllib.parse import parse_qsl, urlsplit
import webbrowser


class AuthenticationError(RuntimeError):
    def __init__(self, message, code="MODEL_AUTH_FAILED"):
        super().__init__(message)
        self.code = code


class _Cancelled(BaseException):
    pass


@contextmanager
def _replace_attributes(*replacements):
    originals = [(obj, name, getattr(obj, name)) for obj, name, _ in replacements]
    try:
        for obj, name, value in replacements:
            setattr(obj, name, value)
        yield
    finally:
        for obj, name, value in reversed(originals):
            setattr(obj, name, value)


def _challenge_url(value):
    """Allow login URLs, never token-bearing responses or arbitrary native logs."""
    value = str(value).strip().rstrip(".,)")
    if len(value) > 8192:
        return None
    try:
        parsed = urlsplit(value)
        if (parsed.scheme != "https" and not (parsed.scheme == "http" and
                parsed.hostname in {"localhost", "127.0.0.1", "::1"})):
            return None
        if not parsed.hostname or parsed.username or parsed.password or parsed.fragment:
            return None
        secret_names = {"access_token", "refresh_token", "id_token", "api_key", "apikey", "token",
                        "client_secret", "password", "authorization", "oauth_token"}
        if any(key.lower() in secret_names for key, _ in parse_qsl(parsed.query)):
            return None
    except ValueError:
        return None
    return value


class _Progress(io.TextIOBase):
    """Translate native CLI presentation, without retaining its arbitrary output."""
    def __init__(self, provider, emit):
        self.provider, self.emit = provider, emit
        self.pending, self.code_next = "", False

    def challenge(self, url, user_code=None, **_ignored):
        safe_url = _challenge_url(url)
        if not safe_url:
            raise AuthenticationError("Hermes 返回了无法安全展示的登录地址。", "MODEL_AUTH_CHALLENGE_INVALID")
        event = {"event": "auth", "provider": self.provider,
                 "message": "请在服务商页面完成登录。", "url": safe_url}
        if user_code is not None and re.fullmatch(r"[A-Za-z0-9 -]{1,128}", str(user_code)):
            event["userCode"] = str(user_code)
        self.emit(event)

    def write(self, value):
        size = len(value)
        self.pending += value
        while "\n" in self.pending:
            line, self.pending = self.pending.split("\n", 1)
            self._line(line)
        # A native/server error must not turn this presentation adapter into a log buffer.
        self.pending = self.pending[-16384:]
        return size

    def _line(self, value):
        value = re.sub(r"\x1b\[[0-9;]*[A-Za-z]", "", value).strip()
        if self.code_next and value:
            self.code_next = False
            if re.fullmatch(r"[A-Za-z0-9 -]{4,128}", value):
                self.emit({"event": "auth", "provider": self.provider, "userCode": value})
                return
        if re.search(r"enter this code\s*:", value, re.I):
            self.code_next = True
        for candidate in re.findall(r"https?://[^\s<>\"']+", value):
            # Only login/challenge output is presented; success is never parsed from it.
            if re.search(r"(?:oauth|authorize|device|verification|activate)", candidate, re.I):
                url = _challenge_url(candidate)
                if url:
                    self.emit({"event": "auth", "provider": self.provider, "url": url})


@contextmanager
def _preserve_selection(auth):
    from hermes_cli.config import get_config_path
    path = Path(get_config_path())
    original = path.read_bytes() if path.exists() else None
    with auth._auth_store_lock():
        before = auth._load_auth_store()
        had_active, active = "active_provider" in before, before.get("active_provider")
    try:
        yield
    finally:
        failures = []
        try:
            current = path.read_bytes() if path.exists() else None
            if current != original:
                if original is None:
                    path.unlink(missing_ok=True)
                else:
                    auth._write_private_file_atomic(path, original.decode("utf-8"))
        except Exception:
            failures.append("configuration")
        try:
            with auth._auth_store_lock():
                current = auth._load_auth_store()
                if ("active_provider" in current, current.get("active_provider")) != (had_active, active):
                    if had_active:
                        current["active_provider"] = active
                    else:
                        current.pop("active_provider", None)
                    auth._save_auth_store(current)
        except Exception:
            failures.append("active_provider")
        if failures:
            raise AuthenticationError("登录后原模型选择未能完整恢复，请重新检查配置。",
                                      "MODEL_AUTH_SELECTION_RESTORE_FAILED") from None


def authenticate(provider, emit, *, respond=None):
    """Run Hermes' native OAuth flow, or inspect native external prerequisites.

    ``respond(event)`` returns a user answer for an emitted prompt. It must use
    the same held stdin channel as the caller, never a request file or argv.
    External CLI/SDK credentials are discovered by Hermes, not installed here.
    """
    from hermes_cli import auth, auth_commands
    from hermes_cli.providers import get_provider

    definition = get_provider(provider, allow_network=False)
    if definition is None:
        raise AuthenticationError("当前 Hermes 不支持这个模型服务。", "MODEL_PROVIDER_UNSUPPORTED")
    provider = definition.id
    oauth_providers = getattr(auth_commands, "_OAUTH_CAPABLE_PROVIDERS", ())
    if provider not in oauth_providers:
        status = auth.get_auth_status(provider)
        if status.get("provider", provider) != provider:
            raise AuthenticationError("Hermes 返回的认证服务与所选服务不一致。", "MODEL_AUTH_PROVIDER_MISMATCH")
        external = definition.auth_type == "external_process"
        ready = bool(status.get("logged_in"))
        authenticated = bool(status.get("auth_verified")) if external else ready
        return {"ok": ready, "provider": provider, "configured": ready,
                "authenticated": authenticated,
                "authVerification": "native-status" if authenticated else "not-verified",
                **({"code": "MODEL_AUTH_PREREQUISITE_REQUIRED",
                    "error": "请先完成此服务在 Hermes 中要求的凭据或外部程序配置，再重新检查。"}
                   if not ready else {})}

    progress = _Progress(provider, emit)
    prompt_number = 0

    def prompt(native_prompt=""):
        nonlocal prompt_number
        prompt_number += 1
        question = ("是否导入 Hermes 已保存的此服务登录？输入 Y 或 N。" if "import" in str(native_prompt).lower()
                    else "请粘贴服务商页面返回的授权码。")
        event = {"event": "auth", "provider": provider, "prompt": question,
                 "promptId": str(prompt_number), "requiresInput": True}
        emit(event)
        if respond is None:
            raise AuthenticationError("此登录需要用户完成授权并返回授权码。", "MODEL_AUTH_INPUT_REQUIRED")
        answer = respond(event)
        if not isinstance(answer, str) or len(answer) > 16384 or "\x00" in answer:
            raise AuthenticationError("授权输入无效。", "MODEL_AUTH_INPUT_INVALID")
        return answer

    args = SimpleNamespace(provider=provider, auth_type="oauth", no_browser=True,
                           timeout=20.0, label="", priority=None)
    # ``auth add`` saves account credentials, but the first account also selects
    # an active provider. Suppress that side effect before any write, including
    # on Windows where force-terminating a child cannot execute Python finally.
    store_provider_state = auth._store_provider_state

    def store_without_selection(store, provider_id, state, *, set_active=True):
        return store_provider_state(store, provider_id, state, set_active=False)

    def cancel(*_args):
        raise _Cancelled()

    old_disable = logging.root.manager.disable
    previous_signal = None
    if threading.current_thread() is threading.main_thread():
        previous_signal = signal.signal(signal.SIGTERM, cancel)
    emit({"event": "auth", "provider": provider, "message": "正在调用 Hermes 登录。"})
    try:
        with _preserve_selection(auth), redirect_stdout(progress), redirect_stderr(progress), \
                _replace_attributes((builtins, "input", prompt),
                    (auth_commands, "line_input", prompt),
                    (auth, "_print_device_code_instructions", progress.challenge),
                    (auth, "_store_provider_state", store_without_selection),
                    (auth, "mark_provider_active_if_unset", lambda _provider: None),
                    (webbrowser, "open", lambda *_args, **_kwargs: False)):
            logging.disable(logging.CRITICAL)
            auth_commands.auth_add_command(args)
            status = auth.get_auth_status(provider)
            if status.get("provider", provider) != provider:
                raise AuthenticationError("Hermes 返回的认证服务与所选服务不一致。", "MODEL_AUTH_PROVIDER_MISMATCH")
            if not status.get("logged_in"):
                raise AuthenticationError("Hermes 尚未确认此服务登录成功。", "MODEL_AUTH_UNCONFIRMED")
        return {"ok": True, "provider": provider, "authenticated": True,
                "authVerification": "native-status"}
    except _Cancelled:
        raise AuthenticationError("已取消模型服务登录。", "MODEL_AUTH_CANCELLED") from None
    except AuthenticationError:
        raise
    except (Exception, SystemExit, KeyboardInterrupt) as error:
        native_code = getattr(error, "code", "")
        code = (str(native_code).upper() if isinstance(native_code, str) and
                re.fullmatch(r"[A-Za-z][A-Za-z0-9_]{0,79}", native_code) else "MODEL_AUTH_FAILED")
        raise AuthenticationError(f"Hermes 登录未完成（{code}）。", code) from None
    finally:
        logging.disable(old_disable)
        if previous_signal is not None:
            signal.signal(signal.SIGTERM, previous_signal)
