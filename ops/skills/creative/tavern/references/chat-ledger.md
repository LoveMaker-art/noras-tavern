# Chat and story ledger

## Read the intended conversation

Resolve worldId and sessionId from current world/session metadata. Use
`nora.session.read` with a bounded offset/limit, paging only as required. It
returns full-history expectedSignature alongside the window. Message IDs are
indexes, not turn numbers; greetings/system messages are not automatically rounds.
Use `st.character.chats` only as inventory, not as permission to bypass Nora's
session identity. Read `nora.ledger.status` for authoritative compression state.
Neither read should schedule paid work.

## Send, stop, regenerate or suggest

Use the live-page protocol in SKILL.md and the exact target Session:

- `story.send`: send approved text through the existing generation pipeline.
- `story.regenerate`: regenerate through that pipeline.
- `story.suggest`: request model-generated suggested replies, not a sent user message.
- `story.stop`: request cancellation. Verify current activity before declaring stopped.

The first three require model authorization. They require a connected page;
offline transcript reads do not. Do not append a fake message to storage or call
a model directly to substitute for the ST/Helper/MVU generation lifecycle.

## Edit and truncate

1. Read the target message, history signature and ledger state. Resolve exactly
   which message the user means, not just a displayed round number.
2. Check whether the target is locked by activated/reserved compressed history.
   Locked history cannot be edited; disabling the ledger does not unlock it.
3. Explain that editing deletes ALL subsequent messages and may schedule paid
   background compression. Obtain approval for those effects if not already given.
4. `nora.session.edit` is a backend edit, not a synchronized live-page action.
   Check clients: defer while a page is actively using/generating this Session;
   ask to leave/close that Session before an offline edit. Do not race a live save.
5. Submit messageId, text and the just-read expectedSignature. On signature
   conflict re-read and reassess; do not overwrite with stale data.
6. Read the resulting history and ledger state. Confirm truncation and report
   that any previously open page needs fresh state; frontendApplied=false is
   not a failure of persistence and is not a claim of frontend synchronization.

The backend recomputes round eligibility and invalidates affected pending
compression. The skill does not manually alter round counters or ledger records.

## Ledger operations

- `nora.ledger.configure`: enable/disable for the exact World and Session.
  Enabling can schedule paid compression; inspect current state before enabling.
- `nora.ledger.compress`: request/retry eligible compression, not an arbitrary
  rewrite of a user-specified range. Use returned state and `nora.ledger.status`.
- The runtime batches narrative rounds; read its eligible ranges instead of
  counting message rows or forcing a compression when it reports ineligible.
- Generated/pending memory is not yet active context. Only the runtime's actual
  activation permits context substitution and its associated history lock.
  Failed compression must not be described as having replaced the full context.
- Do not repeatedly submit compress after a timeout. Check status first. A job
  accepted by the server is not a completed model result.

Ledger concerns what happened in a Session. Story Profile concerns archives and
user preferences: load story-profile.md only when that additional outcome is requested.
