"""Opt-in Hermes adapter. Consent comes from real owner events, never an LLM tool argument."""
import asyncio
import logging
import os
from pathlib import Path
import secrets

from . import Activation, PROTOCOL, PROMPT, implementation, source_from_env, write

log = logging.getLogger(__name__)
SKILLS = ('tavern', 'tavern-ops', 'tavern-updater', 'nora-cardforge')


class HermesAdapter:
    def __init__(self, gateway):
        self.gateway = gateway

    def owner(self, source):
        platform = getattr(source.platform, 'value', str(source.platform))
        adapter = self.gateway.adapters.get(source.platform)
        # ClawChat's actual activation owner, not group admin or AGENTS metadata.
        owner = getattr(adapter, '_owner_user_id', lambda: '')()
        return (platform == 'clawchat' and source.chat_type == 'dm' and not source.is_bot
                and bool(owner) and source.user_id == owner and self.gateway._is_user_authorized(source))

    def identity(self, event):
        source = event.source
        entry = self.gateway.session_store.get_or_create_session(source)
        return {'platform': source.platform.value, 'chat_id': source.chat_id, 'user_id': source.user_id,
                'thread_id': source.thread_id or '', 'key': self.gateway._session_key_for_source(source),
                'id': entry.session_id, 'message_id': event.message_id or source.message_id or ''}

    def event(self, source):
        from gateway.config import Platform
        from gateway.session import SessionSource
        from gateway.platforms.base import MessageEvent
        origin = SessionSource(platform=Platform(source['platform']), chat_id=source['chat_id'],
                               user_id=source['user_id'], thread_id=source['thread_id'] or None, chat_type='dm')
        return MessageEvent(text='', source=origin, message_id=source['message_id'])

    async def send(self, event, text):
        adapter = self.gateway.adapters[event.source.platform]
        result = await adapter.send(chat_id=event.source.chat_id, text=text,
                                    metadata={'thread_id': event.source.thread_id} if event.source.thread_id else None)
        if not result.success:
            raise RuntimeError('ClawChat notification delivery failed')
        return result.message_id

    async def idle(self, key):
        # A tool may request activation before its enclosing assistant turn ends.
        for _ in range(240):
            if key not in self.gateway._running_agents:
                return
            await asyncio.sleep(.5)
        raise TimeoutError('Current assistant turn is still running')

    async def reload(self, event, plan):
        # Same implementation as the owner-confirmed /reload-mcp command.
        # Do not disable approvals.mcp_reload_confirm or invoke gateway restart.
        from tools.mcp_tool import _MCP_AVAILABLE, _servers, _lock
        if not _MCP_AVAILABLE:
            raise RuntimeError('Hermes MCP SDK is unavailable; repair the gateway Python dependencies before activation')
        with _lock:
            previous = _servers.get('nora')
            previous_session = getattr(previous, 'session', None)
        await self.gateway._execute_mcp_reload(event)
        with _lock:
            server = _servers.get('nora')
            info = getattr(getattr(server, 'initialize_result', None), 'serverInfo', None)
            names = list(getattr(server, '_registered_tool_names', []))
            config = getattr(server, '_config', {})
            expected = str(Path(plan['home']) / 'apps/nora-mcp/dist/server.js')
            if server is not None and (server is previous or getattr(server, 'session', None) is previous_session):
                raise RuntimeError('Gateway did not establish a fresh Nora MCP connection')
            if (not server or not getattr(server, 'session', None) or not names
                    or getattr(info, 'version', None) != plan['versions']['mcp']
                    or config.get('args') != [expected]):
                raise RuntimeError('Actual gateway Nora MCP connection does not match the installed release')
        await self.gateway._handle_reload_skills_command(event)
        from agent.skill_commands import get_skill_commands
        commands = get_skill_commands()
        for skill in SKILLS:
            item = commands.get('/' + skill, {})
            category = 'system' if skill == 'tavern-updater' else 'creative'
            target = Path(plan['home']) / 'skills' / category / skill / 'SKILL.md'
            if Path(item.get('skill_md_path', '')) != target:
                raise RuntimeError('Actual gateway skill registry differs: ' + skill)
        return {'gatewayMcpReloaded': True, 'freshConnection': True, 'mcpVersion': info.version, 'mcpToolCount': len(names),
                'skills': list(SKILLS), 'gatewayRestarted': False}

    async def reset(self, event):
        await self.gateway._handle_reset_command(event)
        return self.identity(event)['id']


class Bridge:
    def __init__(self, home, adapter, loop, *, instance=None):
        self.state = Activation(home)
        self.adapter = adapter
        self.loop = loop
        self.instance = instance or secrets.token_hex(16)
        self.tasks = set()
        self.prompting = False
        self.busy = set()

    def schedule(self, coroutine):
        def start():
            task = asyncio.create_task(coroutine)
            self.tasks.add(task)
            task.add_done_callback(self.tasks.discard)
        self.loop.call_soon_threadsafe(start)

    def post_tool(self, **_kwargs):
        # Read contextvars in the originating tool thread, not in the async task.
        try:
            from gateway.session_context import get_session_env
            keys = ('PLATFORM', 'CHAT_ID', 'USER_ID', 'THREAD_ID', 'KEY', 'ID', 'MESSAGE_ID')
            source = source_from_env({'HERMES_SESSION_' + k: get_session_env('HERMES_SESSION_' + k) for k in keys})
            record = self.state.peek()
            if (record and record['status'] == 'queued' and record['source'] == source
                    and record['gatewayInstance'] == self.instance and not self.prompting):
                self.prompting = True
                self.schedule(self.prompt(record['requestId'], source))
        except (ValueError, FileNotFoundError, ProcessLookupError):
            return

    async def prompt(self, request_id, source):
        try:
            await self.adapter.idle(source['key'])
            with self.state.lock():
                path, record, installed, plan = self.state.current()
                if not record or record['requestId'] != request_id or record['status'] != 'queued':
                    return
                event = self.adapter.event(source)
                if not self.adapter.owner(event.source) or self.adapter.identity(event)['id'] != source['id']:
                    record['status'] = 'superseded'
                elif self.state.clock() > record['expiresAt']:
                    record['status'] = 'expired'
                else:
                    self.state.verify_files(installed, plan)
                    record['promptMessageId'] = await self.adapter.send(event, PROMPT)
                    record['status'] = 'awaiting-confirmation'
                write(path, record)
        except Exception:
            log.exception('Tavern activation prompt failed; installation is unchanged')
        finally:
            self.prompting = False

    def dispatch(self, *, event, **_kwargs):
        if getattr(event, 'internal', False) or not self.adapter.owner(event.source):
            return None
        try:
            pending = self.state.peek()
            if not pending:
                return None
            source = self.adapter.identity(event)
            if source['message_id'] == pending.get('confirmationMessageId'):
                return {'action': 'skip', 'reason': 'duplicate Tavern activation confirmation'}
            if source['key'] in self.busy:
                self.schedule(self.notice(event, '正在激活更新，本条消息尚未处理；请等待完成通知后重新发送。'))
                return {'action': 'skip', 'reason': 'Tavern activation is in progress; sender notified'}
            if pending['status'] != 'awaiting-confirmation':
                return None
            with self.state.lock():
                path, record, _, _ = self.state.current()
                if not record:
                    return None
                source = self.adapter.identity(event)
                # A loaded old bridge must not activate code expecting another bridge.
                if record['gatewayInstance'] != self.instance:
                    return None
                decision = self.state.decide(record, source, event.text, authorized=True)
                if not decision:
                    return None
                write(path, record)  # Durable consent before scheduling any side effect.
            if decision == 'activating':
                self.busy.add(source['key'])
                self.schedule(self.activate(event, record['requestId'], source['key']))
                return {'action': 'skip', 'reason': 'owner-confirmed Tavern activation'}
            if event.text.strip() in ('确定', '取消'):
                self.schedule(self.notice(event, '本次激活确认已过期或取消，尚未激活。'))
                return {'action': 'skip', 'reason': 'Tavern activation cancelled or expired'}
        except (ValueError, FileNotFoundError, BlockingIOError):
            return None
        return None

    async def notice(self, event, text):
        try:
            await self.adapter.send(event, text)
        except Exception:
            log.exception('Tavern activation notification was not delivered')

    async def activate(self, event, request_id, key):
        path = record = None
        try:
            path, record, _, _ = self.state.current()
            if not record or record['requestId'] != request_id or record['status'] != 'activating':
                return
            await self.adapter.idle(key)
            with self.state.lock():
                path, record, installed, plan = self.state.current()
                if not record or record['requestId'] != request_id or record['status'] != 'activating':
                    return
                if self.adapter.identity(event)['id'] != record['source']['id'] or not self.adapter.owner(event.source):
                    raise ValueError('Owner or session changed after confirmation')
                self.state.verify_files(installed, plan)
                evidence = await self.adapter.reload(event, plan)
                record.update(status='resetting', verification=evidence, resetReviewRequired=True)
                write(path, record)
                new_id = await self.adapter.reset(event)
                if not new_id or new_id == record['source']['id']:
                    raise RuntimeError('Hermes did not create a fresh session')
                record.update(status='active', newSessionId=new_id, completedAt=self.state.clock(), resetReviewRequired=False)
                write(path, record)
                await self.adapter.send(event, '更新激活完成：MCP 和四个技能已刷新，当前聊天已开启新会话，旧记录保留。'
                                        '下一条消息会使用新的 AGENTS 上下文；无需重启网关。')
                record['notified'] = True
                write(path, record)
        except Exception as error:
            log.exception('Tavern activation did not finish')
            # Delivery failure must not relabel a successful activation or reset twice.
            if record and path and record.get('requestId') == request_id:
                record['errorType'] = type(error).__name__
                if record['status'] != 'active':
                    record['status'] = 'failed'
                write(path, record)
                await self.notice(event, '安装文件仍保留，但激活或通知未全部完成。请查询更新器 activation status；不要重复安装。')
        finally:
            self.busy.discard(key)


def register(ctx):
    from hermes_constants import get_hermes_home
    home = get_hermes_home()
    loaded = implementation(Path(__file__).parent)
    bridge = None

    def bind(gateway=None):
        nonlocal bridge
        if gateway is None:
            try:
                from gateway.run import _gateway_runner_ref
                gateway = _gateway_runner_ref()
            except ImportError:
                return None
        if gateway is None:
            return None  # Early/CLI discovery must not advertise a live gateway.
        if bridge is None or bridge.adapter.gateway is not gateway:
            loop = gateway._gateway_loop
            if loop is None:
                try:
                    loop = asyncio.get_running_loop()
                except RuntimeError:
                    return None
            for name in ('_execute_mcp_reload', '_handle_reload_skills_command', '_handle_reset_command'):
                if not callable(getattr(gateway, name, None)):
                    return None
            bridge = Bridge(home, HermesAdapter(gateway), loop)
            write(home / 'tavern-updates-v2/activation-gateway.json',
                  {'protocol': PROTOCOL, 'pid': os.getpid(), 'instance': bridge.instance, 'implementation': loaded})
        return bridge

    def post_tool(**kwargs):
        current = bind()
        if current:
            current.post_tool(**kwargs)

    def dispatch(**kwargs):
        current = bind(kwargs.get('gateway'))
        return current.dispatch(**kwargs) if current else None

    ctx.register_hook('post_tool_call', post_tool)
    ctx.register_hook('pre_gateway_dispatch', dispatch)
    bind()
