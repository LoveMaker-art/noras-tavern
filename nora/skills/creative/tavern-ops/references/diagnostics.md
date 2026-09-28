# Diagnose the current installation

Derive paths/URLs from the active instance, not a remembered SSH port or app ID.
On the maintained Linux layout HERMES_HOME is /opt/data; respect explicit
TAVERN_APP_DIR, TAVERN_STATE_DIR and MCP configuration overrides. Do not change
them simply to make an identity check pass.

## Choose the failed layer

- Product operation: use the relevant `tavern` reference and returned operation
  error. A connected page with a script failure is not a server outage.
- Local process: the maintained script is
  `$HERMES_HOME/skills/creative/tavern/scripts/runtime.sh`. Its `status` command
  delegates to the installed native_lifecycle.py. Locate that existing script
  and run status; do not run prepare/install/sync as a health check.
- HTTP: test the configured localhost `/csrf-token` and
  `/api/nora-worlds-v2/status`, using the instance's normal authentication when
  required. Compare the reported userDataRoot with the MCP target. Bound request
  timeouts; redact tokens. A permission error is not proof the process is down.
- MCP: when available `nora.status` provides product and instance checks.
  When disconnected inspect only the nora server's command/paths and safe
  connection errors. Check installed `hermes mcp --help` before using its test
  command; this can launch a diagnostic MCP subprocess but must not call models
  or write product data. A separate successful test does not prove the running
  ClawChat session has loaded the tools.
- Liveware: if localhost works but the public app does not, load the installed
  `clawchat-liveware` skill. Inspect existing app identity, tunnel binding and
  gateway response. Do not create a second app or a tunnel daemon as a guess.

Read a bounded log interval around the failure. Separate model-provider wait,
page/plugin execution, local HTTP and public transport evidence. Do not expose
complete chat prompts, credentials or large unfiltered logs.

Tool availability failures can be reported without restarting anything. If the
required host tool/platform skill is unavailable, name that prerequisite instead
of inventing a command or invoking an unrelated agent.
