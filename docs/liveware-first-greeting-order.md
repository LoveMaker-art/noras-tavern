# Greeting and Liveware Startup

## User-visible contract

The gateway hook starts one background worker. The worker starts Tavern,
authenticates the current Liveware identity, and reconciles Tavern and Story
Profile Apps. The model greeting runs independently: registration and the App
entry do not wait for the greeting, and the App may appear first.

Entry delivery still requires verified current-user/instance ownership, a ready
tunnel and launcher URL, and the current owner's conversation. Persist the
message ID before sending, reuse it on retries, and mark delivery only on ACK.
Worker locking and uncertain-registration recovery remain unchanged.

The welcome text must not contain a cloned URL. This fix does not rewrite user
greetings, character cards, model settings, or conversations.

## Why the ordering gate was removed

Hermes can return from inbound dispatch before its background model turn sends
the greeting. Checking delivery immediately after dispatch can release the
bootstrap claim too early. The greeting can then appear without the success
marker, leaving registration waiting indefinitely. Registration must not depend
on that marker.

## Existing gateway installations

`ops/updater/clawchat-greeting-order.patch` now reverses our known legacy ordering
patch against ClawChat commit `8651f7078916e60ed1da9f78ec4d1278fef49dd9`.
This restores the original independent Sample App scheduling and bootstrap
bookkeeping; it does not manually mark any greeting as delivered.

The updater and first installer stage the two affected gateway files and use
their existing backup, swap, and rollback transaction. Clean upstream sources
are a no-op. Unknown or partially patched sources are left unchanged and reported
as `pending`. Python syntax and absence of the legacy gate are checked before
any swap. Gateway source changes take effect after the gateway restarts.

## Verification

```sh
python3 -B -m unittest discover -s ops/tests -p 'test_liveware*.py'
python3 -B -m unittest discover -s ops/tests -p 'test_updater*.py'
python3 -B -m unittest discover -s ops/tests -p 'test_first_install.py'
```

Tests cover registration and entry delivery with an unsent greeting marker,
missing/foreign owner conversations, slow or failed model greetings, patch
restoration, idempotency, partial-source rejection, and transaction rollback.
Network collaborators are replaced in these tests. They do not establish a real
cloud activation, App registration, ACK, or external entry-opening result.

This release does not change desktop launcher UI or its first-install completion
criteria. Desktop integrated packages require a separate build and release.
