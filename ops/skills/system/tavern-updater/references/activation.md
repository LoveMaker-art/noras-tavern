# Owner activation

## Default: Hermes' native restart command

After a successful `apply`, read the durable `receipt.json`. Only
`installed-awaiting-hermes-reload` permits the installation-success prompt:

> Tavern 更新已安装。请在 ClawChat 与若棠的对话中发送 `/restart`，
> 重启 Hermes 并重新加载 MCP 和技能；等待重启成功通知后继续使用。

The owner sends this in the ClawChat conversation, not in a terminal. The agent
ends its turn after giving the instruction. Do not automatically restart Hermes,
invoke process signals or fabricate the owner's command. Isolated rehearsals
must not request a restart of the live gateway.

`/restart` is Hermes' native gateway command and does not depend on the Tavern
activation plugin already being loaded. It restarts the gateway; new gateway
initialization reads the installed MCP configuration and skills. It retains the
existing conversation rather than doing `/new` or deleting history.

Wait for Hermes' successful restart notification. Then check the actual gateway
Nora MCP tool registry and the four canonical skills (`tavern`, `tavern-ops`,
`tavern-updater`, `nora-cardforge`) before claiming activation verified. A healthy
Tavern process, installed files, or a standalone MCP probe is insufficient.
If restart fails or no notification arrives, inspect gateway logs and its actual
service manager through `tavern-ops`; do not silently change process supervision.
The installation receipt alone remains evidence of installation, not activation.

## Existing bridge requests: compatibility only

The release still supports the previously installed `activation request/status`
commands. They are not the default post-update instruction. A newly installed or
changed bridge cannot activate itself in an already-running gateway. Do not tell
the owner that replying “确定” will work without a matching live bridge handshake.

For an already pending request, `activation status` reads its transaction-bound
`activation.json`. Only the owner's matching session/message can approve it;
the CLI has no confirm operation. Never edit receipts or bypass owner checks.
Successful native `/restart` does not fabricate a bridge `active` receipt.

If a bridge operation failed/interrupted, inspect its record and gateway logs
before retrying; never automatically repeat a session reset. An active operation
with failed notification delivery must not be activated again just to resend a
message. Rolled-back or superseded transactions cannot be approved.
