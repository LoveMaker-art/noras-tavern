# Owner-confirmed updater activation — local verification

## Implemented scope

The release installs an opt-in Hermes plugin from `ops/updater/hermes-plugin`.
Its implementation is in `ops/updater/activation`; no Hermes core files, Tavern
World logic or Story Profile generation logic are modified.

After installation, `activation request` queues a consent prompt in the initiating
owner's ClawChat DM. The gateway sends it after the current assistant turn ends.
The owner's next `确定` in that same session invokes Hermes' MCP reload, skill
reload and new-session handlers. Other replies cancel; consent expires; repeated
message delivery cannot reset the session twice. The CLI cannot approve consent.

An activation receipt is separate from the installation receipt. It records
fresh-connection evidence, MCP version/tool count, four canonical skill paths,
new session identity and notification delivery status. Failed delivery does not
repeat activation. Interrupted session reset requires review, not automatic retry.

Apply/rollback and activation share the updater lock. The plugin's two host
files and merged enablement configuration participate in the reviewed update
transaction and rollback. Existing explicitly disabled or customized plugins are
respected; the module does not disable Hermes' approvals or self-restart guard.

## Evidence

Local tests cover consent identity/session/expiry, cancellation, replay, failed
reload, idle timeout, failed delivery, interrupted reset, symlink rejection,
changed/rolled-back installation rejection, plugin enable/disable, installation
and recovery. An old connection cannot satisfy reload verification merely because
its reported version still matches the installed release.

`ops/tests/verify_activation_hermes.py --hermes-source <Hermes checkout>` uses
actual Hermes plugin loading, MCP reload/registry, skill reload and session reset
code against a temporary Hermes home and a real local Nora stdio MCP subprocess.
The completed local run discovered 30 read-only tools, verified the four skill
paths, preserved the old transcript, created a different session ID and read the
new AGENTS content. It made no model call and restarted no gateway.

ClawChat transport and owner identity are test doubles. The cosmetic session
metadata footer is also replaced to avoid an unrelated provider-catalog lookup;
the reload/reset implementations themselves are real. This does not establish
live ClawChat delivery, remote compatibility or target-user acceptance.

The first integration attempt failed because the temporary Python environment
lacked `httpx_sse`, a transitive MCP SDK dependency. Hermes treated the unavailable
SDK as no MCP tools. Completing the isolated environment's dependencies made
the original integration path pass without weakening connection checks. The
harness now imports the SDK up front; the adapter also distinguishes unavailable
SDK from connection verification failure.

## First load and remaining gate

A running Hermes process does not load a newly installed plugin automatically.
The first installation, or a changed activation implementation, requires owner
gateway activation through its normal management surface once. A live handshake
binds requests to the loaded implementation. Later ordinary releases with that
same implementation do not require restarting the gateway.

This is locally implemented and technically verified, not deployed or publicly
released. Real ClawChat confirmation/delivery and the next actual assistant turn
still require authorized target-environment acceptance. Published rc.4 and the
remote installation were not changed by this work.
