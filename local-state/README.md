# Local State And Private Evidence

This ignored directory holds task-local data and evidence. It is not an installed
Nora home or a second source tree to maintain. Everything except this file is
ignored by Git.

## Uses

- Isolated compatibility fixtures and user-authorized snapshots of Tavern
  Worlds, characters, chats, settings and frontend extensions.
- Source and installer acceptance logs, timing records, source or artifact
  hashes, failed attempts and their later results.
- Build and publication receipts, sealed plans and download verification,
  following the [release process](../docs/release-process.md).
- Disposable test exports, downloaded candidate packages and caches needed by a
  particular task.

Give each task its own directory and record the source or artifact, environment,
result, remaining gaps and locations needed to find its evidence. A file being
present here does not establish that its test passed or that it was published.

## Private Data And Shared Conclusions

Runtime secrets such as model keys, pairing credentials, `secrets.json` and
`cookie-secret.txt` stay out of repository snapshots and public artifacts. Use the
existing credential and model-configuration protection rules rather than making
extra secret copies here.

Raw diagnostics may contain private messages, paths or credentials. Keep them
private and share only a redacted summary with the relevant source and artifact
identities. Keep durable decisions in the relevant existing design or ADR. Bind one-time
verification records to their exact source and artifacts; preserve retired records
through the [fixed Git history](../docs/architecture/README.md#如何读取原始证据).
Do not commit the raw directory to make a link portable.

## Retention And Cleanup

Separate disposable exports, downloads and caches from retained evidence and
data. After a task, preserve its result summary, relevant hashes and the original
failure evidence needed to assess the outcome. A later successful attempt does
not turn an earlier failure into a pass.

Identify the task owner and actual contents before cleaning a directory.
Temporary PID files, bytecode and caches need not be retained unless they are
part of the reproduction. Do not infer that runtime data, credentials or the
only copy of acceptance evidence are disposable because they are under
`local-state/`; apply the existing data rules and the task's cleanup scope.
