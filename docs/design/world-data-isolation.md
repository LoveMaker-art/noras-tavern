# World Data Isolation

## Accepted scope

- Importing a card to create a World retains the complete original in the library.
- Every new World owns its Runtime Card and Worldbooks immediately, including
  identical repeated imports and blank Worlds. Library-original deduplication
  does not deduplicate World runtime copies.
- Adding a setting appends to the World's current private Worldbook; it does not
  prepend an empty replacement book. Other entries and their IDs are preserved.
- World changes do not synchronize back to library originals. Existing explicit
  save-to-library actions remain the only way to publish changed reusable data.
- Existing Worlds are not automatically migrated, renamed or rewritten. Legacy
  shared/external resources remain readable. A user-requested write retains the
  existing copy-on-write protection when exclusivity cannot be established.
- This change does not alter MVU protocols, model configuration or chat history.

## Implementation

The existing backend materializer allocates World-scoped names and owned
resources. It retains the original import through the existing card library.
Named Worldbooks referenced without embedded content are copied too; a missing
named source produces an explicit import error instead of an unresolved binding.

Setting mutations use the existing operation journal, revision check and file
lock. The materializer returns the existing resource for an in-place addition,
or the old resource ID when a legacy binding needs a protected private copy.
The service replaces that specific binding rather than adding another primary.
The live adapter and activation snapshot retain the remaining attached books.

The exclusivity check permits the current World's own Runtime Card reference,
while still rejecting other Worlds, other cards and global references. Legacy
ownership labels alone are not trusted.

## Verification boundary

Targeted tests cover repeated/concurrent imports, original library preservation,
blank Worlds, append/edit/delete isolation, UI-controller entry counts, activation
snapshot reopening, duplicate request retries, stale writes, legacy shared/global
references, missing sources and failed-import cleanup. Tests use temporary data;
they do not execute paid model requests or change active local/remote Worlds.

No automatic migration, live deployment, GitHub push or release is part of this
change. Browser-level visual acceptance and real model-context capture remain
separate checks before deployment.
