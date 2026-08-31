# Owner activation

Installation and activation have separate receipts. After a successful apply,
run the skill entrypoint with `activation request` in the owner's ClawChat DM.
Use the same `--hermes-home` as installation. Hermes supplies message/session
identity to the terminal; preserve it rather than constructing identity flags.

The loaded gateway module sends the prompt after the current assistant turn
finishes. Tell the user to wait for that prompt, then end the turn. Their next
“确定” authorizes MCP reload, skill refresh and a new session with old history
retained. The gateway consumes this message directly. Other replies cancel the
pending confirmation; another user/session and duplicate messages cannot approve.
Consent expires after ten minutes. `activation status` inspects progress.

The CLI has no confirm operation. Never fabricate the owner's response, edit a
receipt, turn off Hermes approvals, unset its self-restart protection or invoke
a process signal as a substitute. Request again after cancellation/expiry only
when the owner asks to proceed. Activation is not an application reinstallation.

## First installation

The release installs `plugins/tavern-update-activation` and enables it without
altering other plugins. An explicitly disabled plugin stays disabled. A running
gateway cannot load a newly installed plugin just because its files appeared.
`activation request` checks the live module handshake and fails if it is absent,
stale or not the installed implementation. Have the owner activate the gateway
from its normal management surface once, or use native `/reload-mcp` plus `/new`
for this update. Do not promise the one-word flow on an uninitialized gateway.
Ordinary later releases with the same bridge need no gateway restart. A changed
bridge implementation requires the same first-load check again.

## Evidence and recovery

`activation.json` is stored beside the installed transaction's `receipt.json`.
`active` requires a fresh gateway Nora MCP connection (not the old connection
with a matching version), the actual version/tool registry,
all four canonical skill paths and a different Hermes session ID. It is not
inferred from a standalone MCP probe. The next user turn builds the fresh AGENTS
context; this receipt is not evidence of a completed model response or Tavern UI
acceptance. `notified: true` additionally requires successful platform delivery.

If failed/interrupted, inspect this record and gateway logs before retrying.
The updater does not automatically repeat a session reset after interruption.
Successful activation with `notified: false` must not be activated again merely
to deliver a message; report its existing result in the original conversation.
If files were rolled back or superseded, the old confirmation is unusable.
