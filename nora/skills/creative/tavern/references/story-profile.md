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
The ledger separately owns compressed plot context; its shared_story_memory
projection is not a second profile model generation performed by this skill.

Existing managed projection rules put bounded taste/response adaptations in
USER.md and bounded activated plot memory in MEMORY.md. The agent does not
append to these files or replace their non-managed content. Projection is not
authorization to claim story events are facts about the real user.

Fine-grained preference confirm/reject/edit/lock and an explicit memory-sync
operation are not exposed by the current MCP. Report the exact missing operation;
do not silently call old profile scripts to extend this skill's permissions.
