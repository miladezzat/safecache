import type { CacheEvent, CacheEventBus } from "@safecache/core";
import { parseCacheEvent, toError } from "@safecache/core";

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
  /**
   * Subscribe in manual-acknowledge mode. The consumer acks a delivery only
   * after the handler resolves successfully (see {@link RabbitMqChannelLike.ack}),
   * so unprocessed messages survive a crash on durable queues. amqplib enables
   * manual ack via `consume(queue, handler, { noAck: false })`; pass it through
   * when the underlying channel honours it.
   */
  consume(
    queue: string,
    handler: (message: RabbitMqDelivery | null) => void,
    options?: { noAck?: boolean },
  ): Promise<{ consumerTag: string }>;
  cancel(consumerTag: string): Promise<unknown>;
  /**
   * Positive acknowledge. Invoked after a delivery has been parsed, validated
   * and successfully dispatched to the subscriber handler. Matches the amqplib
   * `Channel.ack` shape. Optional so a no-ack transport (or a test double) can
   * omit it; when absent, deliveries are simply not acked.
   */
  ack?(message: RabbitMqDelivery, allUpTo?: boolean): void;
  /**
   * Negative-acknowledge. Invoked when a delivery cannot be parsed/validated, or
   * when the subscriber handler throws. Such deliveries are dropped
   * (requeue=false) rather than silently swallowed or requeued forever. Matches
   * the amqplib `Channel.nack` shape.
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
   * or fails CacheEvent validation, or when the subscriber handler throws. The
   * offending delivery is nacked (requeue=false) and the consume callback never
   * throws, so a poison/foreign message or a faulty handler cannot crash the
   * consumer. This upholds the SafeCache guarantee: a cache-side failure is
   * caught, reported here, and the consumer continues. Defaults to a no-op.
   */
  onError?: (error: Error, message: RabbitMqDelivery) => void;
  /**
   * When true, a delivery whose handler throws is requeued (requeue=true) for a
   * later redelivery instead of being dropped. Use with care: a deterministically
   * failing handler will redeliver the same message in a loop. Defaults to false
   * (drop poison messages). Parse/validation failures are always dropped
   * regardless of this flag, since they can never succeed on redelivery.
   */
  requeueOnHandlerError?: boolean;
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
      const consumer = await options.channel.consume(
        queue.queue,
        (message) => {
          if (!message) {
            return;
          }
          // Dispatch on the microtask queue so the synchronous amqplib delivery
          // callback returns immediately and never observes a rejected promise.
          // Everything inside dispatch() is guarded; nothing escapes here.
          void dispatch(message);
        },
        { noAck: false },
      );

      async function dispatch(message: RabbitMqDelivery): Promise<void> {
        let event: CacheEvent;
        try {
          // parseCacheEvent JSON-parses the payload and validates the CacheEvent
          // shape, throwing on malformed/foreign messages.
          event = parseCacheEvent(message.content.toString("utf8"));
        } catch (error) {
          // A poison/foreign message can never succeed on redelivery: drop it
          // (requeue=false) and report it. Never throw into the consumer.
          options.channel.nack?.(message, false, false);
          options.onError?.(toError(error), message);
          return;
        }
        try {
          await handler(event);
        } catch (error) {
          // The cache-side handler failed. Honour the SafeCache guarantee: catch
          // it, route it to onError, and nack so the broker can decide whether to
          // redeliver. Never let the rejection escape the delivery callback.
          options.channel.nack?.(message, false, options.requeueOnHandlerError ?? false);
          options.onError?.(toError(error), message);
          return;
        }
        // Only ack a message that was successfully processed. With manual ack
        // this is what makes durable queues actually durable.
        options.channel.ack?.(message);
      }

      return async () => {
        await options.channel.cancel(consumer.consumerTag);
      };
    },
  };
}
