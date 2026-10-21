# Story Profile

## Choose a read or a generation request

| User request | Tool | Result to verify |
| --- | --- | --- |
| What does the archive know about me/my stories? | `nora.story.card` | Existing profile, evidence and archive content |
| Has this world's reflection finished? | `nora.story.checkpoint.status` | Actual job/result state for worldId |
| Reflect on this world's conversations | `nora.story.checkpoint` | Accepted work, then status and updated profile |
| Preview an analysis without saving | `nora.story.reflect_preview` | PAID model result, not a free inspection |
| Remember an explicit durable preference | `nora.story.learn` | Approved change/reason, persisted result |
| Regenerate the derived profile | `nora.story.refresh` | Returned outcome and changed profile |

Use the registered schemas. All four generation/learning actions require
confirmation and allowModelCall; reading the current profile does not authorize
them. Do not turn an uncertain query into a speculative paid preview.

For a named world, resolve worldId through World Core. For “what happened in the
last messages”, read the actual Session using chat-ledger.md; a profile is not a
verbatim transcript. Resolve which world the user means before reflecting.

For an explicit preference, preserve the user's meaning and evidence. Do not
turn fictional character behavior, a temporary scene, a bug report or formatting
complaint into an inferred real-life identity. Preview is not a generic staged
transaction whose text can automatically be committed by another tool.

## Result and timeout handling

An accepted checkpoint may still be pending/running. Query its status rather
than report that the archive is already updated. After timeout, inspect status
and existing profile before any repeat; refresh/learn/preview do not all provide
a resumable job receipt, so an uncertain result may need to be reported as such.
Re-read the relevant profile after a confirmed write. Do not invent generated
fields when evidence is absent.

## Sources and projection

The existing Story Profile backend owns archive and preference generation.
The ledger separately owns compressed plot context. The archive's story
timeline reads validated saved progress, including prepared results not yet
used for generation. Existing preference-learning events remain historical
records and do not become plot events. Its shared_story_memory projection is
not a second profile model generation performed by this skill.

Managed projection keeps four-group story preferences (body up to1400 characters)
in USER.md under Hermes' actual whole-file budget. Plot progress remains in the
World/Session ledgers and the archive, not persistent MEMORY.md. The maintained
backend backs up and removes only a verified old Tavern plot block; Hermes'
unrelated memory and all source profile/chat history remain intact. Pending old
block cleanup is distinct from USER preference saving or a missing story.

Use `nora.story.progress` through chat-ledger.md to read the intended story on
demand; ask for a choice on ambiguous worlds/branches, and request bounded recent
chat only when needed. The agent does not append plot to MEMORY.md, remove its
unmanaged contents, or treat fictional events as facts about the real user.

Fine-grained preference confirm/reject/edit/lock and an explicit memory-sync
operation are not exposed by the current MCP. Report the exact missing operation;
do not silently call old profile scripts to extend this skill's permissions.
