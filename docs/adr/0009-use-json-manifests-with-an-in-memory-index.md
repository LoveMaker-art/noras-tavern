# Use Atomic JSON Manifests With An In-Memory Index

- Status: Accepted
- Date: 2026-08-28

The first World Core implementation will store one schema-versioned JSON manifest per World, write it atomically, and maintain in-memory indexes loaded once at process startup. A durable operation journal and keyed locks provide retry and concurrency semantics. This removes request-time directory scans without adding a native database dependency to the single-process Liveware runtime.

## Considered Options

- Continue scanning JSON files on every list or claim: rejected because latency and race exposure grow with the number of Worlds.
- Introduce SQLite immediately: deferred because current scale does not justify migration and native-delivery complexity.
- Use JSON manifests with an in-memory index: accepted because it fits the current single-writer process and is reversible if measured scale later requires a database.

## Consequences

- The store must validate every manifest during startup and quarantine invalid records.
- All writes update the manifest and index under the same keyed lock.
- A future database migration requires a separate ADR backed by measured query volume and latency.
