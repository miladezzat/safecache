import type { CacheEvent, CacheEventBus } from "@safecache/core";
import { parseCacheEvent, toError } from "@safecache/core";

export interface NatsSubscriptionLike {
  unsubscribe(): void;
}

/**
 * Acknowledgement returned by a JetStream-style confirming publish. The real
 * NATS client returns a `PubAck` ({ stream, seq, ... }); we only need to know
 * that a value resolved (the broker persisted the message) versus the promise
 * rejecting (the publish failed).
 */
export type NatsPubAck = unknown;

export interface NatsJetStreamLike {
  /**
   * Confirming publish: resolves with a `PubAck` once the broker has persisted
   * the message, or rejects on failure. Used by `confirm: "jetstream"` to obtain
   * at-least-once delivery semantics.
   */
  publish(subject: string, payload: Uint8Array): Promise<NatsPubAck>;
}

export interface NatsClientLike {
  publish(subject: string, payload: Uint8Array): void;
  /**
   * Optional round-trip to the broker. Resolves once all previously buffered
   * data has been flushed to (and acknowledged by) the server, or rejects if the
   * connection is down. Used by `confirm: "flush"` to surface broker-outage
   * errors that the fire-and-forget `publish` cannot. Matches the core NATS
   * `NatsConnection.flush` shape.
   */
  flush?(): Promise<void>;
  /**
   * Optional JetStream context for confirming, at-least-once publishes. Used by
   * `confirm: "jetstream"`. Matches the core NATS `NatsConnection.jetstream` shape.
   */
  jetstream?(): NatsJetStreamLike;
  subscribe(
    subject: string,
    options: {
      callback(error: unknown, message: { data: Uint8Array }): void;
    },
  ): NatsSubscriptionLike;
}

/**
 * Delivery confirmation strategy for outgoing events.
 *
 * - `"none"` (default): core NATS fire-and-forget. Lowest latency, but a broker
 *   outage cannot be detected from the publish call — matches historical behavior.
 * - `"flush"`: fire-and-forget publish followed by `client.flush()`, which
 *   round-trips to the broker. A failed flush (e.g. the connection is down)
 *   surfaces the error instead of silently dropping the event. Still at-most-once.
 * - `"jetstream"`: confirming publish via `client.jetstream().publish()`, which
 *   resolves with a `PubAck` once the broker has persisted the message. Provides
 *   at-least-once delivery; requires a JetStream-enabled server and stream.
 */
export type NatsPublishConfirm = "none" | "flush" | "jetstream";

export interface NatsEventBusOptions {
  client: NatsClientLike;
  subject: string;
  /**
   * Delivery confirmation strategy for `publish`. Defaults to `"none"`
   * (fire-and-forget) to preserve backward-compatible behavior. Use `"flush"`
   * or `"jetstream"` to make a failed publish detectable. See
   * {@link NatsPublishConfirm}.
   */
  confirm?: NatsPublishConfirm;
  /**
   * Sink for cache-side errors raised on the event-bus hot path: failed
   * confirming publishes, subscription delivery errors, malformed/foreign
   * payloads, and rejecting handlers. Receives a normalized `Error`.
   *
   * Per the SafeCache safety guarantee these errors are, by default, reported
   * here and then swallowed so a degraded broker can never throw into the host
   * application. The callback itself must never throw — it is invoked from a
   * detached promise chain. Defaults to a silent no-op.
   */
  onError?: (error: Error) => void;
  /**
   * Opt-in: when `true`, a failed confirming publish (`confirm: "flush"` or
   * `"jetstream"`) is re-thrown from `publish` after being routed to `onError`,
   * instead of being swallowed. Lets callers that require strict delivery treat
   * a publish failure as fatal. Defaults to `false` (swallow + notify).
   *
   * Has no effect with `confirm: "none"`, which never observes publish errors.
   */
  propagateInvalidationErrors?: boolean;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const noopOnError: (error: Error) => void = () => {};

export function natsEventBus(options: NatsEventBusOptions): CacheEventBus {
  const onError = options.onError ?? noopOnError;
  const confirm = options.confirm ?? "none";
  const propagate = options.propagateInvalidationErrors ?? false;

  return {
    async publish(event) {
      const payload = encoder.encode(JSON.stringify(event));

      if (confirm === "jetstream") {
        try {
          const js = options.client.jetstream?.();
          if (!js) {
            throw new Error(
              'natsEventBus: confirm "jetstream" requires a client that implements jetstream()',
            );
          }
          // Confirming, at-least-once publish: rejects if the broker does not ack.
          await js.publish(options.subject, payload);
        } catch (error) {
          // Cache-side failure: report it, and only break the host operation if
          // the caller explicitly opted in via propagateInvalidationErrors.
          const normalized = toError(error);
          onError(normalized);
          if (propagate) {
            throw normalized;
          }
        }
        return;
      }

      // For "none" and "flush" the publish itself is fire-and-forget; only the
      // optional flush can surface a broker outage.
      options.client.publish(options.subject, payload);

      if (confirm === "flush" && options.client.flush) {
        try {
          // Round-trips to the broker: a rejecting flush means the buffered
          // event was not delivered.
          await options.client.flush();
        } catch (error) {
          const normalized = toError(error);
          onError(normalized);
          if (propagate) {
            throw normalized;
          }
        }
      }
    },

    async subscribe(handler) {
      const subscription = options.client.subscribe(options.subject, {
        callback(error, message) {
          if (error) {
            // Provider-side delivery error: route it, never throw from the loop.
            onError(toError(error));
            return;
          }
          let event: CacheEvent;
          try {
            // Validate via core's parser: malformed JSON or foreign payloads
            // throw here and are reported + skipped, never dispatched.
            event = parseCacheEvent(decoder.decode(message.data));
          } catch (cause) {
            onError(toError(cause));
            return;
          }
          // The dispatch loop promises never to throw: a rejecting handler is
          // routed to onError from a detached chain rather than surfacing here.
          void Promise.resolve()
            .then(() => handler(event))
            .catch((cause) => {
              onError(toError(cause));
            });
        },
      });
      return async () => {
        subscription.unsubscribe();
      };
    },
  };
}
