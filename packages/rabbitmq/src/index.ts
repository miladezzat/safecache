import type { CacheEvent, CacheEventBus } from "@safecache/core";

export interface RabbitMqDelivery {
  content: Buffer;
}

export interface RabbitMqChannelLike {
  assertExchange(
    exchange: string,
    type: "fanout",
    options?: { durable?: boolean },
  ): Promise<unknown>;
  assertQueue(queue: string, options?: { exclusive?: boolean }): Promise<{ queue: string }>;
  bindQueue(queue: string, exchange: string, routingKey: string): Promise<unknown>;
  publish(exchange: string, routingKey: string, content: Buffer): boolean;
  consume(
    queue: string,
    handler: (message: RabbitMqDelivery | null) => void,
  ): Promise<{ consumerTag: string }>;
  cancel(consumerTag: string): Promise<unknown>;
  /**
   * Optional negative-acknowledge. When present, deliveries that cannot be
   * parsed/validated are dropped (requeue=false) instead of being silently
   * swallowed. Matches the amqplib `Channel.nack` shape.
   */
  nack?(message: RabbitMqDelivery, allUpTo?: boolean, requeue?: boolean): void;
}

export interface RabbitMqEventBusOptions {
  channel: RabbitMqChannelLike;
  exchange: string;
  queue?: string;
  durable?: boolean;
  /**
   * Optional error channel. Invoked when an incoming delivery cannot be parsed
   * or fails CacheEvent validation. The offending delivery is dropped and the
   * consume callback never throws, so a poison/foreign message cannot crash the
   * consumer. Defaults to a no-op.
   */
  onError?: (error: Error, message: RabbitMqDelivery) => void;
}

export function rabbitMqEventBus(options: RabbitMqEventBusOptions): CacheEventBus {
  return {
    async publish(event) {
      await options.channel.assertExchange(options.exchange, "fanout", {
        durable: options.durable ?? true,
      });
      options.channel.publish(options.exchange, "", Buffer.from(JSON.stringify(event)));
    },

    async subscribe(handler) {
      await options.channel.assertExchange(options.exchange, "fanout", {
        durable: options.durable ?? true,
      });
      const queue = await options.channel.assertQueue(options.queue ?? "", {
        exclusive: !options.queue,
      });
      await options.channel.bindQueue(queue.queue, options.exchange, "");
      const consumer = await options.channel.consume(queue.queue, (message) => {
        if (!message) {
          return;
        }
        let event: CacheEvent;
        try {
          const parsed = JSON.parse(message.content.toString("utf8")) as unknown;
          if (!isCacheEvent(parsed)) {
            throw new Error("malformed cache event");
          }
          event = parsed;
        } catch (error) {
          // Never throw into the AMQP delivery callback: a poison/foreign
          // message must not crash the consumer. Drop it and report it.
          options.channel.nack?.(message, false, false);
          options.onError?.(toError(error), message);
          return;
        }
        void handler(event);
      });
      return async () => {
        await options.channel.cancel(consumer.consumerTag);
      };
    },
  };
}

const CACHE_EVENT_TYPES = new Set<CacheEvent["type"]>([
  "invalidate:key",
  "invalidate:tag",
  "refresh:key",
]);

function isCacheEvent(value: unknown): value is CacheEvent {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const event = value as Record<string, unknown>;
  return (
    typeof event.id === "string" &&
    typeof event.type === "string" &&
    CACHE_EVENT_TYPES.has(event.type as CacheEvent["type"]) &&
    typeof event.source === "string" &&
    typeof event.timestamp === "number" &&
    typeof event.namespace === "string"
  );
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
