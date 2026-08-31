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

New releases do not install or enable the old bridge. `activation request` is
retired; `activation status` only reads retained historical records. There is no
Tavern command that resets a session or reloads/restarts the gateway.

Upgrade recognizes unchanged official/previously managed plugin files and retires
them inside the reviewed transaction. Queued confirmations are marked superseded;
an in-progress/interrupted reset blocks retirement for owner review. Modified
plugin files and unrelated plugins are preserved, not silently deleted. Recovery
restores the corresponding files, configuration and request state. Successful
native `/restart` does not fabricate a bridge `active` receipt.

If a bridge operation failed/interrupted, inspect its record and gateway logs
before retrying; never automatically repeat a session reset. An active operation
with failed notification delivery must not be activated again just to resend a
message. Rolled-back or superseded transactions cannot be approved.
