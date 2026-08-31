# Make The World Manifest Authoritative

- Status: Accepted; supersedes ADR 0001
- Date: 2026-08-28

Nora requires a World to exist independently of browser state, recent-chat projections, and replaceable ST bindings. The schema-versioned World manifest is therefore the canonical World record; chat metadata stores only a compatibility projection of the World and Story Session identities. This replaces ADR 0001 because making chat metadata authoritative caused World existence to depend on a compatibility-engine file and its loading order.

## Considered Options

- Keep chat metadata authoritative: rejected because a missing, unopened, renamed, or header-only chat can make the product object disappear.
- Derive identity from avatar and chat filenames: rejected because both are replaceable ST bindings.
- Use a separate authoritative World manifest: accepted because it gives Nora one stable product identity while preserving ST data in its native formats.

## Consequences

- World list and lifecycle commands read one Nora-owned source of truth.
- Chat metadata remains portable recovery evidence but cannot create or delete a World by itself.
- Legacy chat metadata is migrated once and conflicts are reported rather than silently merged.
