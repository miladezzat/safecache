import type { CacheEvent, CacheEventBus } from "@safecache/core";

export interface AwsPutEventsInput {
  Entries: Array<{
    EventBusName: string;
    Source: string;
    DetailType: string;
    Detail: string;
  }>;
}

export interface AwsEventsClientLike {
  putEvents?(input: AwsPutEventsInput): Promise<unknown>;
  send?(command: unknown): Promise<unknown>;
}

export interface AwsEventBusOptions {
  client: AwsEventsClientLike;
  eventBusName: string;
  source: string;
  command?: (input: AwsPutEventsInput) => unknown;
  subscribe?: (handler: (event: CacheEvent) => Promise<void>) => Promise<() => Promise<void>>;
}

export function awsEventBus(options: AwsEventBusOptions): CacheEventBus {
  return {
    async publish(event) {
      const input: AwsPutEventsInput = {
        Entries: [
          {
            EventBusName: options.eventBusName,
            Source: options.source,
            DetailType: event.type,
            Detail: JSON.stringify(event),
          },
        ],
      };

      if (options.client.putEvents) {
        await options.client.putEvents(input);
        return;
      }

      if (!options.client.send || !options.command) {
        throw new Error("AWS event bus requires putEvents or send with a command factory");
      }

      await options.client.send(options.command(input));
    },

    async subscribe(handler) {
      if (!options.subscribe) {
        throw new Error("AWS event bus subscribe requires a subscriber bridge");
      }
      return options.subscribe(handler);
    },
  };
}
