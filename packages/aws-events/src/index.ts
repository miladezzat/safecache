import type { CacheEvent, CacheEventBus } from "@safecache/core";

export interface AwsPutEventsInput {
  Entries: Array<{
    EventBusName: string;
    Source: string;
    DetailType: string;
    Detail: string;
  }>;
}

export interface AwsPutEventsResultEntry {
  EventId?: string;
  ErrorCode?: string;
  ErrorMessage?: string;
}

export interface AwsPutEventsResult {
  FailedEntryCount?: number;
  Entries?: AwsPutEventsResultEntry[];
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

/**
 * EventBridge returns HTTP 200 even when individual entries fail (throttling,
 * validation, etc.) via `FailedEntryCount` and per-entry `ErrorCode`. Left
 * uninspected, a dropped invalidation would resolve as success and leave stale
 * data indefinitely. Throwing here lets the core publish path's `recordError`
 * fire so the failure is observable.
 */
function assertNoFailedEntries(response: unknown): void {
  const result = response as AwsPutEventsResult | null | undefined;
  if (!result || typeof result !== "object") {
    return;
  }

  const entries = Array.isArray(result.Entries) ? result.Entries : [];
  const failedEntries = entries.filter((entry) => entry && entry.ErrorCode);
  const failedCount =
    typeof result.FailedEntryCount === "number" ? result.FailedEntryCount : failedEntries.length;

  if (failedCount > 0 || failedEntries.length > 0) {
    const summary = failedEntries
      .map((entry) => `${entry.ErrorCode}${entry.ErrorMessage ? `: ${entry.ErrorMessage}` : ""}`)
      .join(", ");
    throw new Error(
      `AWS event bus putEvents failed for ${failedCount} entr${failedCount === 1 ? "y" : "ies"}` +
        (summary ? ` (${summary})` : ""),
    );
  }
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
        assertNoFailedEntries(await options.client.putEvents(input));
        return;
      }

      if (!options.client.send || !options.command) {
        throw new Error("AWS event bus requires putEvents or send with a command factory");
      }

      assertNoFailedEntries(await options.client.send(options.command(input)));
    },

    async subscribe(handler) {
      if (!options.subscribe) {
        throw new Error("AWS event bus subscribe requires a subscriber bridge");
      }
      return options.subscribe(handler);
    },
  };
}
