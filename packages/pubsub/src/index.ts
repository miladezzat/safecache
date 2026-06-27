import type { CacheErrorEvent, CacheEvent, CacheEventBus } from "@safecache/core";
import { parseCacheEvent, toError } from "@safecache/core";

export interface RedisPubSubClient {
  publish(channel: string, message: string): Promise<number>;
  subscribe(channel: string, handler: (message: string) => void): Promise<void>;
  unsubscribe?(channel: string, handler: (message: string) => void): Promise<void>;
}

export interface RedisPubSubOptions {
  channel?: string;
  /**
   * Notifier invoked for every cache-side failure on the bus: a publish that
   * rejects, a message that fails `parseCacheEvent` validation, or a subscribe
   * handler that throws. SafeCache's core guarantee is that cache failures must
   * never throw into the host application, so by default these errors are
   * swallowed and reported here. Defaults to a silent no-op (library code must
   * not log on the host's behalf); supply your own to surface them.
   */
  onError?: (event: CacheErrorEvent) => void;
  /**
   * Opt-in escape hatch. When true, a failed `publish` rejects to the caller
   * instead of being swallowed. Subscribe-side errors (malformed messages and
   * throwing handlers) are NEVER propagated regardless of this flag — they
   * arrive asynchronously from the transport and have no caller to receive
   * them. Defaults to false (swallow + notify, never break the app).
   */
  propagateInvalidationErrors?: boolean;
}

const noop = (): void => {};

/**
 * Redis Pub/Sub event bus for distributed SafeCache invalidation.
 *
 * Delivery semantics: Redis Pub/Sub is fire-and-forget and at-most-once. A
 * subscriber that is momentarily disconnected (network blip, reconnect, slow
 * consumer that Redis disconnects for exceeding its output buffer) silently
 * misses every message published during that window — there is no replay,
 * acknowledgement, or backlog. In practice this means an invalidation can be
 * lost and a stale value can be served until its TTL elapses. This bus is
 * therefore best-effort online invalidation, not a durable guarantee. For
 * stronger guarantees use a durable bus (Kafka, RabbitMQ, an outbox, or a
 * cloud event service) and sign events (see `distributed.signingSecret`) so
 * subscribers can reject forged or tampered invalidations.
 */
export function redisPubSub(
  client: RedisPubSubClient,
  options: RedisPubSubOptions = {},
): CacheEventBus {
  const channel = options.channel ?? "__safecache:events";
  const onError = options.onError ?? noop;
  const propagate = options.propagateInvalidationErrors ?? false;

  const notify = (operation: string, error: unknown): void => {
    // The notifier itself must never break the host: if a user-supplied onError
    // throws, swallow it rather than letting it escape the cache layer.
    try {
      onError({ type: "error", operation, error: toError(error) });
    } catch {
      // Intentionally ignored — a failing notifier cannot be allowed to surface.
    }
  };

  return {
    async publish(event) {
      try {
        await client.publish(channel, JSON.stringify(event));
      } catch (error) {
        notify("pubsub.publish", error);
        if (propagate) {
          throw toError(error);
        }
        // Default: swallow. A failed invalidation broadcast must not break the
        // host operation that triggered it — the cache behaves as if absent.
      }
    },
    async subscribe(handler) {
      const listener = (message: string) => {
        // Validate untrusted transport input before dispatching. A malformed
        // message (bad JSON or wrong shape) is routed to the notifier and
        // skipped — never thrown — so one poisoned message cannot take down the
        // subscriber.
        let event: CacheEvent;
        try {
          event = parseCacheEvent(message);
        } catch (error) {
          notify("pubsub.parse", error);
          return;
        }
        // A throwing (or rejecting) handler is the host's own code failing on a
        // cache event; isolate it to the notifier so it can never crash the
        // process via an unhandled rejection.
        void Promise.resolve()
          .then(() => handler(event))
          .catch((error: unknown) => {
            notify("pubsub.handler", error);
          });
      };
      await client.subscribe(channel, listener);
      return async () => {
        await client.unsubscribe?.(channel, listener);
      };
    },
  };
}
