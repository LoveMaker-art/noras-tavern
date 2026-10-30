"""Shared, explicitly authorized model request inside a candidate Hermes process.

This module never selects another HERMES_HOME and never runs a conversation,
tools, hooks, persona loading, or the agent's recovery/fallback loop. Protocols,
credential resolution and response normalization belong to installed Hermes.
"""
from contextlib import contextmanager, redirect_stderr, redirect_stdout
import io
import logging
import os
from pathlib import Path
from tempfile import TemporaryDirectory
from urllib.parse import parse_qs, urlsplit, urlunsplit
from uuid import uuid4


class _ProbeError(RuntimeError):
    def __init__(self, code, message):
        super().__init__(message)
        self.code = code


class _Discard(io.TextIOBase):
    """Native SDK/CLI output can contain credentials; do not retain it."""
    def write(self, value):
        return len(value)

    def flush(self):
        pass


@contextmanager
def _quiet_native():
    previous_level = logging.root.manager.disable
    previous_safe_mode = os.environ.get("HERMES_SAFE_MODE")
    os.environ["HERMES_SAFE_MODE"] = "1"
    logging.disable(logging.CRITICAL)
    try:
        with redirect_stdout(_Discard()), redirect_stderr(_Discard()):
            yield
    finally:
        logging.disable(previous_level)
        if previous_safe_mode is None:
            os.environ.pop("HERMES_SAFE_MODE", None)
        else:
            os.environ["HERMES_SAFE_MODE"] = previous_safe_mode


def _same_endpoint(expected, actual, client_kwargs):
    from hermes_cli.route_identity import normalize_route_base_url
    if normalize_route_base_url(expected) == normalize_route_base_url(actual):
        return True
    # Hermes moves explicit OpenAI URL query parameters to SDK default_query.
    source, target = urlsplit(expected), urlsplit(actual)
    without_query = urlunsplit((source.scheme, source.netloc, source.path, "", ""))
    return bool(source.query and not target.query
        and normalize_route_base_url(without_query) == normalize_route_base_url(actual)
        and {key: value[0] for key, value in parse_qs(source.query).items()}
            == (client_kwargs or {}).get("default_query"))


def _assert_target(agent, runtime, expected_model):
    if (agent.provider != runtime["provider"] or agent.model != expected_model
            or agent.api_mode != runtime["api_mode"]
            or not _same_endpoint(str(runtime.get("base_url") or ""),
                                  str(agent.base_url or ""), getattr(agent, "_client_kwargs", {}))
            or getattr(agent, "_fallback_activated", False)
            or getattr(agent, "_fallback_chain", None)):
        raise _ProbeError("MODEL_PROBE_TARGET_CHANGED", "验证目标与候选模型不一致，未确认配置。")


def _assert_safe_overrides(overrides):
    # Custom extra parameters remain native. They cannot replace the diagnostic
    # input, change the selected model, or enable a server-side tool for this test.
    protected = {"model", "messages", "input", "prompt", "instructions", "system",
                 "tools", "tool_choice", "functions", "function_call"}
    for container in (overrides or {}, (overrides or {}).get("extra_body") or {}):
        if not isinstance(container, dict) or protected.intersection(container):
            raise _ProbeError("MODEL_PROBE_UNSAFE_OVERRIDE", "自定义请求参数会改变验证目标或内容，未执行验证。")


def _public_endpoint(value):
    """Queries and URL userinfo may contain secrets; neither enters the result."""
    parsed = urlsplit(value)
    netloc = parsed.netloc.rsplit("@", 1)[-1]
    return urlunsplit((parsed.scheme, netloc, parsed.path, "", ""))


@contextmanager
def _acp_probe_scope(runtime, model):
    """Keep native ACP negotiation, but forbid its silent model fallback/FS tools."""
    endpoint = str(runtime.get("base_url") or "")
    if not endpoint.startswith(("acp://", "acp+tcp://")):
        yield
        return
    if model == "copilot-acp":
        raise _ProbeError("MODEL_PROBE_TARGET_REQUIRED", "ACP 验证需要明确模型，不能使用会话默认模型代替。")
    from agent import copilot_acp_client as acp
    original_warning = acp.logger.warning
    original_capabilities, original_handlers = acp._INITIALIZE_PARAMS, acp._FS_HANDLERS
    original_cwd = os.getcwd()

    def strict_model_warning(message, *args, **kwargs):
        if "session default" in str(message):
            raise _ProbeError("MODEL_PROBE_TARGET_CHANGED", "ACP 未接受所选模型，未使用默认模型代替验证。")
        return original_warning(message, *args, **kwargs)

    with TemporaryDirectory(prefix="nora-model-probe-acp-") as scratch:
        try:
            os.chdir(scratch)
            acp._INITIALIZE_PARAMS = {**original_capabilities, "clientCapabilities": {}}
            acp._FS_HANDLERS = {}
            acp.logger.warning = strict_model_warning
            yield
        finally:
            acp.logger.warning = original_warning
            acp._INITIALIZE_PARAMS, acp._FS_HANDLERS = original_capabilities, original_handlers
            os.chdir(original_cwd)


def _verify(provider, model):
    from hermes_cli.config import get_hermes_home, load_config_readonly
    from hermes_cli.models import normalize_provider
    from hermes_cli.runtime_provider import resolve_runtime_provider
    from hermes_cli.model_normalize import normalize_model_for_provider, _AGGREGATOR_PROVIDERS

    raw_home = os.environ.get("HERMES_HOME", "")
    if not raw_home or not Path(raw_home).is_absolute() or Path(raw_home).resolve() != get_hermes_home().resolve():
        raise _ProbeError("MODEL_PROBE_HOME_MISMATCH", "候选 Hermes 目录不一致，未执行验证。")
    if (not isinstance(provider, str) or not provider.strip() or provider.strip().lower() == "auto"
            or not isinstance(model, str) or not model.strip()
            or any(char in provider + model for char in "\r\n\x00")):
        raise _ProbeError("MODEL_PROBE_TARGET_REQUIRED", "验证需要明确的模型服务和模型。")
    provider, model = provider.strip(), model.strip()
    config = load_config_readonly()
    configured = config.get("model") or {}
    if (not isinstance(configured, dict)
            or normalize_provider(str(configured.get("provider") or "")) != normalize_provider(provider)
            or str(configured.get("default") or "") != model):
        raise _ProbeError("MODEL_PROBE_TARGET_CHANGED", "候选配置与本次验证目标不一致。")

    runtime = resolve_runtime_provider(requested=provider, target_model=model)
    mode = runtime.get("api_mode")
    if mode not in {"chat_completions", "codex_responses", "anthropic_messages", "bedrock_converse"}:
        raise _ProbeError("MODEL_PROBE_UNSUPPORTED_TRANSPORT", "当前原生传输不提供无工具的最小模型验证，未降级到其他服务。")
    overrides = runtime.get("request_overrides") or {}
    _assert_safe_overrides(overrides)
    expected_model = model if runtime["provider"] in _AGGREGATOR_PROVIDERS else normalize_model_for_provider(model, runtime["provider"])

    with _acp_probe_scope(runtime, model):
        return _request(provider, model, runtime, expected_model, overrides)


def _request(provider, model, runtime, expected_model, overrides):
    from run_agent import AIAgent
    agent = None
    try:
        agent = AIAgent(provider=runtime["provider"], requested_provider=provider,
            model=model, base_url=runtime.get("base_url"), api_key=runtime.get("api_key"),
            api_mode=runtime["api_mode"], command=runtime.get("command"), args=runtime.get("args"),
            request_overrides=overrides, capabilities=runtime.get("capabilities"),
            fallback_model=[], credential_pool=None, enabled_toolsets=[], disabled_toolsets=[],
            max_iterations=1, max_tokens=64, reasoning_config={"enabled": False, "effort": "none"},
            quiet_mode=True, save_trajectories=False, verbose_logging=False,
            skip_context_files=True, load_soul_identity=False, skip_memory=True,
            skip_background_review=True, session_db=None, checkpoints_enabled=False,
            session_id=f"model-probe-{uuid4().hex}")
        _assert_target(agent, runtime, expected_model)
        _assert_safe_overrides(agent.request_overrides)
        # Do not run_conversation(): that path loads context and invokes lifecycle
        # hooks, compression, recovery and model fallback. Use its exact native
        # request builder/dispatcher once, with no tool or private input.
        messages = [{"role": "system", "content": "This is a model connectivity check. Reply briefly."},
                    {"role": "user", "content": "Reply with OK."}]
        kwargs = agent._build_api_kwargs(messages, tools_for_api=[])
        if kwargs.get("model", expected_model) != expected_model or kwargs.get("tools"):
            raise _ProbeError("MODEL_PROBE_TARGET_CHANGED", "原生请求改变了验证模型或启用了工具，未发送请求。")
        _assert_safe_overrides({"extra_body": kwargs.get("extra_body") or {}})
        response = agent._interruptible_api_call(kwargs)
        normalized = agent._get_transport().normalize_response(response)
        _assert_target(agent, runtime, expected_model)
        if not isinstance(normalized.content, str) or not normalized.content.strip() or normalized.tool_calls:
            raise _ProbeError("MODEL_PROBE_EMPTY_RESPONSE", "所选模型未返回可确认的文本回复。")
        if runtime["provider"] == "moa":
            completions = agent.client.chat.completions
            references = getattr(completions, "_ref_cache_outputs", None)
            if not references or any(not isinstance(text, str) or not text.strip()
                    or text.lstrip().lower().startswith(("[failed:", "[skipped:", "[interrupted"))
                    for _label, text, _accounting in references):
                raise _ProbeError("MODEL_PROBE_MOA_INCOMPLETE", "MoA 参考模型未全部完成，未将聚合器单独回复视为全部通过。")
        return {"ok": True, "provider": provider, "model": model,
                "baseUrl": _public_endpoint(str(agent.base_url or "")), "apiMode": agent.api_mode,
                "validation": "api-response", "verified": True}
    finally:
        if agent is not None:
            agent.close()


def verify(provider: str, model: str) -> dict:
    """Validate the candidate once; caller owns authorization, timeout and home isolation.

    Failure details intentionally exclude SDK/server exception text: it can echo
    credentials, request headers or response tokens. No response text is returned.
    """
    with _quiet_native():
        try:
            return _verify(provider, model)
        except _ProbeError as error:
            return {"ok": False, "verified": False, "code": error.code, "error": str(error)}
        except (Exception, SystemExit) as error:
            status = getattr(error, "status_code", None)
            result = {"ok": False, "verified": False, "code": "MODEL_PROBE_FAILED",
                      "error": "所选模型的 Hermes 原生调用未通过，原配置尚未提交。",
                      "failureType": type(error).__name__}
            if isinstance(status, int) and not isinstance(status, bool) and 100 <= status <= 599:
                result["httpStatus"] = status
            return result
