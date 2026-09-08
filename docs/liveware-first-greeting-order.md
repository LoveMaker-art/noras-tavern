# First Greeting and Liveware Startup

## User-visible contract

1. The gateway hook spawns one background worker and returns immediately.
2. The worker starts the local Tavern runtime, with bounded startup retries.
   An unbound machine can serve Tavern locally without a greeting or cloud login.
3. The worker waits for the current ClawChat user's persisted, acknowledged
   welcome message. Waiting does not consume registration retries.
4. After delivery, authenticate the current Liveware identity and reconcile the
   Tavern and Story Profile Apps. Never trust a cloned App ID as ownership proof.
5. Verify the running asset release, current identity, tunnel reconciliation and
   launcher URLs before sending the separate Tavern entry. Persist its message
   ID before sending; retry with that same ID and mark completion only on ACK.

The welcome text itself must not contain a fixed or cloned URL. This change does
not rewrite users' greetings, character cards, model settings or conversations.

## Changes from the previous implementation

- The remote hotfix waited for the welcome before starting Tavern. Local startup
  now happens first; only App registration and the entry notice wait for delivery.
- GitHub's previous hook ran a single `ensure` operation. It now uses a dedicated,
  locked startup worker with separate waiting, registration and notice phases.
- Identity reconciliation uses freshly authenticated user/instance ownership,
  ignores inherited Liveware token environment overrides, and does not unregister
  same-name launchers outside the current platform App list.
- Persist an uncertain App creation before issuing the request. Do not retry
  creation blindly if the response is lost; wait for platform confirmation.

## ClawChat companion changes

`ops/updater/clawchat-greeting-order.patch` contains the paired gateway changes
tested against ClawChat commit `8651f7078916e60ed1da9f78ec4d1278fef49dd9`:

- Check the current user's `bootstrap_sent = 1` before starting Sample App work.
- A bootstrap turn with no visible delivery releases its claim instead of
  reporting success. A failure after delivery retains the success marker to
  prevent repeating the welcome.
- Resume deferred Sample App scheduling after persisting welcome delivery.

The updater and first installer stage the two source files, validate the patch
and Python syntax, and include the files in their existing backup/rollback
transactions. Reapplying an already-installed patch is a no-op. Unrelated plugin
content is preserved. Incompatible or partially patched source is not overwritten;
the `clawchatGreeting` result reports `pending` and a warning.

These changes take effect in the gateway after restart. A locally healthy Tavern
does not establish that cloud registration or welcome delivery succeeded. A
machine with an unsupported gateway patch must not be described as fully fixed.

## Verification and release boundary

Run:

```sh
python3 -B -m unittest discover -s ops/tests -p 'test_liveware*.py'
python3 -B -m unittest discover -s ops/tests -p 'test_updater*.py'
python3 -B -m unittest discover -s ops/tests -p 'test_first_install.py'
```

Coverage includes startup before activation, retry isolation, worker locking,
current-user delivery checks, failed registration, gateway patch idempotency,
partial/unknown patch rejection and transaction rollback. Gateway tests execute
the patched methods with network collaborators replaced, not real cloud requests.

On the target unbound machine, the old startup failed the local-start-before-wait
test; the correction passed, and Tavern's local world-list endpoint returned 200
while no App identity was created. No user/model messages were sent for this check.
The 36 focused Liveware tests also passed on that remote machine. Applying the
companion patch to a temporary export of the complete original gateway produced
both deployed gateway files byte-for-byte; the actual plugin was not replaced
by this test. Updater/installer checks additionally passed, with one pre-existing
environment-dependent updater test skipped.

A real fresh-clone activation, message ACK, two-App registration and external
entry-opening acceptance test is still required before declaring the entire
first-run experience verified. This branch does not change the release version.
