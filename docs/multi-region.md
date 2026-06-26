# Multi-Region

SafeCache event buses are interface-compatible across Redis Pub/Sub, Kafka, NATS, RabbitMQ, and
AWS event systems, but multi-region behavior depends on the transport.

Recommended defaults:

```txt
use region-aware source IDs
include region on CacheEvent
dedupe by event ID
prefer idempotent invalidation handlers
keep TTLs short for strict data classes
avoid claiming perfect cross-region consistency
```

For active-active deployments, publish invalidation events in the write region and replicate them to
read regions through the selected event system. Cache invalidation should be treated as eventually
consistent unless the application adds its own write quorum or read-after-write routing.
