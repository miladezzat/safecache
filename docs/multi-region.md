# Multi-Region

SafeCache event buses are interface-compatible across Redis Pub/Sub, Kafka, NATS, RabbitMQ, and AWS
event systems. Multi-region behavior depends on the transport and the application’s consistency
requirements.

## Recommended defaults

```txt
use region-aware source IDs
include region on CacheEvent
dedupe by event ID
prefer idempotent invalidation handlers
keep TTLs short for strict data classes
avoid claiming perfect cross-region consistency
```

## Eventual consistency

For active-active deployments, publish invalidation events in the write region and replicate them
to read regions through the selected event system. Cache invalidation should be treated as
eventually consistent unless the application adds its own write quorum or read-after-write routing.

## Strict data

For data that cannot tolerate stale reads:

- use short TTLs
- disable stale-while-revalidate
- route read-after-write traffic to the write region
- include version checks where available
- prefer invalidation from committed write paths or durable outbox rows

## Common mistakes

- Treating cross-region invalidation as synchronous.
- Using Pub/Sub-style transports where durable replication is required.
- Not including region/source metadata on events.
- Using long TTLs for strict data classes.

## Related docs

- [Distributed invalidation](distributed-invalidation.md)
- [Advanced event buses](advanced-event-buses.md)
- [Postgres outbox](postgres-outbox.md)
