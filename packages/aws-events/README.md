# @safecache/aws-events

AWS event bus adapter for SafeCache distributed cache events.

SafeCache packages are currently published as `0.1.0`. APIs are usable but may change before `1.0`.

## Install

```bash
pnpm add @safecache/aws-events @safecache/core
```

## Usage

```ts
import { awsEventBus } from "@safecache/aws-events";

const events = awsEventBus({
  client: eventBridgeClient,
  eventBusName: "default",
  source: "safecache.app",
  command: (input) => new PutEventsCommand(input),
  subscribe: async (handler) => subscribeFromYourAwsBridge(handler),
});
```

## API

- `awsEventBus`
- `AwsEventBusOptions`
- `AwsEventsClientLike`

## When To Use This

Use this package when invalidation events need to cross services through AWS EventBridge or a custom AWS subscriber bridge.

## Related Packages

- `@safecache/core`
- `@safecache/events`
- `@safecache/kafka`
- `@safecache/nats`
- `@safecache/rabbitmq`

## Documentation

- [Advanced Event Buses](../../docs/advanced-event-buses.md)
- [Distributed Invalidation](../../docs/distributed-invalidation.md)
- [SafeCache README](../../README.md)
