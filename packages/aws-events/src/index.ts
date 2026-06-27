import type { CacheEvent, CacheEventBus } from "@safecache/core";
import { parseCacheEvent, toError } from "@safecache/core";

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

/**
 * Subscriber bridge contract.
 *
 * Unlike the sibling broker transports (Kafka, NATS, RabbitMQ) this adapter does
 * not own an EventBridge consumer — EventBridge delivers to targets (Lambda, SQS,
 * etc.) that the host wires up out-of-band. The host therefore supplies a
 * `subscribe` bridge that turns each delivered EventBridge entry into a
 * `CacheEvent` and invokes `handler`.
 *
 * The bridge MUST satisfy the EventBridge `Detail`→`CacheEvent` contract:
 *
 * 1. Each EventBridge entry's `Detail` field is the JSON string produced by this
 *    adapter's `publish` — i.e. `JSON.stringify(event)` for a SafeCache
 *    `CacheEvent`. (EventBridge envelopes it under `detail` once parsed; the
 *    bridge is responsible for unwrapping that envelope.)
 * 2. The bridge passes the parsed/raw `Detail` value (object or JSON string) on
 *    to `handler`; the adapter validates it with core's `parseCacheEvent` before
 *    dispatch, so a malformed or foreign `Detail` is reported to `onError` and
 *    skipped rather than dispatched or thrown.
 * 3. The bridge resolves with an async unsubscribe that tears the delivery down.
 *
 * The `handler` the adapter hands to the bridge accepts `unknown`: pass through
 * whatever the bridge has (the parsed detail object, or the raw `Detail` JSON
 * string). Validation and typing happen inside the adapter.
 */
export type AwsSubscriberBridge = (
  handler: (detail: unknown) => Promise<void>,
) => Promise<() => Promise<void>>;

export interface AwsEventBusOptions {
  client: AwsEventsClientLike;
  eventBusName: string;
  source: string;
  command?: (input: AwsPutEventsInput) => unknown;
  /**
   * Host-supplied bridge from EventBridge delivery to `CacheEvent` dispatch.
   * Receives a `handler` taking the raw EventBridge `Detail` (object or JSON
   * string); the adapter validates it via `parseCacheEvent` before dispatching.
   * See {@link AwsSubscriberBridge} for the precise `Detail`→`CacheEvent` contract.
   */
  subscribe?: AwsSubscriberBridge;
  /**
   * Sink for cache-side errors raised on the event-bus hot path: a failed
   * `putEvents` publish (including EventBridge per-entry `FailedEntryCount`
   * failures), a malformed/foreign inbound `Detail` that fails validation, and a
   * rejecting subscriber `handler`. Receives a normalized `Error`.
   *
   * Per the SafeCache safety guarantee these errors are, by default, reported
   * here and then swallowed so a degraded transport can never throw into the
   * host application. The callback itself must never throw. Defaults to a silent
   * no-op.
   */
  onError?: (error: Error) => void;
  /**
   * Opt-in: when `true`, a failed `publish` (transport rejection or
   * EventBridge-reported failed entries) is re-thrown from `publish` after being
   * routed to `onError`, instead of being swallowed. Lets callers that require
   * strict delivery treat a publish failure as fatal. Defaults to `false`
   * (swallow + notify, never break the host application).
   */
  propagateInvalidationErrors?: boolean;
}

const noopOnError: (error: Error) => void = () => {};

/**
 * EventBridge returns HTTP 200 even when individual entries fail (throttling,
 * validation, etc.) via `FailedEntryCount` and per-entry `ErrorCode`. Left
 * uninspected, a dropped invalidation would resolve as success and leave stale
 * data indefinitely. We turn a reported failure into an Error so it can be routed
 * to `onError` (and optionally re-thrown via `propagateInvalidationErrors`)
 * rather than silently lost.
 */
function failedEntriesError(response: unknown): Error | null {
  const result = response as AwsPutEventsResult | null | undefined;
  if (!result || typeof result !== "object") {
    return null;
  }

  const entries = Array.isArray(result.Entries) ? result.Entries : [];
  const failedEntries = entries.filter((entry) => entry && entry.ErrorCode);
  const failedCount =
    typeof result.FailedEntryCount === "number" ? result.FailedEntryCount : failedEntries.length;

  if (failedCount > 0 || failedEntries.length > 0) {
    const summary = failedEntries
      .map((entry) => `${entry.ErrorCode}${entry.ErrorMessage ? `: ${entry.ErrorMessage}` : ""}`)
      .join(", ");
    return new Error(
      `AWS event bus putEvents failed for ${failedCount} entr${failedCount === 1 ? "y" : "ies"}` +
        (summary ? ` (${summary})` : ""),
    );
  }
  return null;
}

export function awsEventBus(options: AwsEventBusOptions): CacheEventBus {
  const onError = options.onError ?? noopOnError;
  const propagate = options.propagateInvalidationErrors ?? false;

  /**
   * Route a cache-side publish failure to `onError` and, only when the caller
   * has explicitly opted in, re-throw it. Default is swallow + notify so a
   * degraded transport never throws into the host's hot path.
   */
  function handlePublishError(error: unknown): void {
    const normalized = toError(error);
    onError(normalized);
    if (propagate) {
      throw normalized;
    }
  }

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

      try {
        let response: unknown;
        if (options.client.putEvents) {
          response = await options.client.putEvents(input);
        } else if (options.client.send && options.command) {
          response = await options.client.send(options.command(input));
        } else {
          throw new Error("AWS event bus requires putEvents or send with a command factory");
        }
        // EventBridge reports per-entry failures in a 200 response; surface them
        // the same way as a transport rejection.
        const failure = failedEntriesError(response);
        if (failure) {
          throw failure;
        }
      } catch (error) {
        // Cache-side failure: report it, and only break the host operation if the
        // caller explicitly opted in via propagateInvalidationErrors.
        handlePublishError(error);
      }
    },

    async subscribe(handler) {
      if (!options.subscribe) {
        throw new Error("AWS event bus subscribe requires a subscriber bridge");
      }
      return options.subscribe(async (detail) => {
        let event: CacheEvent;
        try {
          // Validate via core's parser: a malformed/foreign Detail (bad JSON or a
          // payload that is not a CacheEvent) throws here and is reported +
          // skipped, never dispatched and never thrown back into the bridge.
          event = parseCacheEvent(detail);
        } catch (error) {
          onError(toError(error));
          return;
        }
        try {
          await handler(event);
        } catch (error) {
          // A rejecting handler is a cache-side failure: route it, never let it
          // propagate into the host's delivery bridge.
          onError(toError(error));
        }
      });
    },
  };
}
