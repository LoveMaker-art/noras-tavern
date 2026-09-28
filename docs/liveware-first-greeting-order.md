# Independent Greeting and Liveware Startup

## User-visible contract

Nora's model greeting and the Hook's Liveware registration run independently.
Registration does not require `bootstrap_sent` or a successful model response.
Only the Hook delivers the initial entry card; the model sends a text greeting.
Their delivery order is not fixed.

1. The gateway Hook spawns one background registration worker and returns.
2. The worker starts the local Tavern runtime with bounded retries. For a
   launcher-managed instance it never restarts a Tavern the user has stopped.
3. Authenticate the current Liveware identity and reconcile the Tavern and
   Story Profile Apps. Reuse only verified identities; do not trust cloned IDs.
4. Verify the current asset release, ownership, tunnels and launcher URLs.
5. Send the verified entry to the current owner's activation conversation.
   A missing conversation delays delivery, not registration.
6. Persist the message ID before sending, reuse it on retries, and mark delivery
   complete only after the server acknowledges it.

The greeting is still handled by the official ClawChat/Hermes message path.
The worker does not generate, resend, or mark a model greeting as delivered.
The managed `greeting.md` requests one text-only final reply with no tools or
Tavern links. It contains no Python commands and does not query or send an entry.
The prose refers to a separate card without assuming its position or delivery.
No new send-acknowledgement ordering mechanism is introduced.
The two optional starter stories remain in the greeting; importing them is a
separate, later user-requested action. User-edited greetings retain the existing
installer preservation policy and are not silently overwritten.

This does not change persona files, cards, model settings, conversations or
activation records. The no-tools/no-Tavern-links rule is a prompt-level constraint,
not a runtime enforcement layer; real model behavior still needs testing.

## Retiring the Previous Ordering Patch

The old implementation waited for greeting delivery before registration and
entry sending. Its immediate send-count check assumed the greeting handler
finished the model turn. Hermes can instead enqueue background work and return,
leaving a subsequently delivered greeting marked unsent.

`ops/updater/clawchat-greeting-order.patch` now reverses that known Nora patch
against ClawChat commit `8651f7078916e60ed1da9f78ec4d1278fef49dd9`. The filename,
report statuses and `greetingPatchSha256` field remain for existing packaging
contracts; the new digest identifies the independent-startup revision.

- Clean supported upstream plugin files are left unchanged.
- Previously patched files are staged back to supported upstream behavior.
- Both adapter and storage changes are checked together. Unknown or partial
  modifications report pending and leave the installed plugin unchanged.
- Existing first-install/update backup and rollback transactions own the swap.
- A gateway restart is required after a swap. It is not performed by the
  staging helper.
- Existing bundle inventories must match the new digest. Old integrated
  runtimes must be rebuilt, not relabeled or reused as if they contained the fix.

The official plugin's own bootstrap bookkeeping remains its responsibility;
Nora no longer interprets it as a delivery acknowledgement or an App gate.

## Verification

Focused regression commands:

```sh
python3 -B -m unittest ops.tests.test_liveware_independent_startup
python3 -B -m unittest ops.tests.test_liveware_greeting_order
python3 -B -m unittest ops.tests.test_launcher_shared_logic
python3 -B -m unittest discover -s ops/tests -p 'test_liveware*.py'
```

Coverage includes unsent/delayed/failed greetings, registration before a
conversation is available, verified-owner Hook delivery, registration failure,
message acknowledgement retries with a stable ID,
worker locking, stopped-service behavior, upstream restoration, partial-patch
rejection, bundle fingerprints and update rollback.

These tests use local fixtures and mocked network collaborators. Real fresh
installation, cloud registration, entry delivery and opening the entry still
require target-environment acceptance before release. This change does not
redesign the launcher or change its separate installation-completion criteria.
