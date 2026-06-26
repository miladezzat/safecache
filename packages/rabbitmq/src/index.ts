import type { CacheEvent, CacheEventBus } from "@safecache/core";

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
    handler: (message: { content: Buffer } | null) => void,
  ): Promise<{ consumerTag: string }>;
  cancel(consumerTag: string): Promise<unknown>;
}

export interface RabbitMqEventBusOptions {
  channel: RabbitMqChannelLike;
  exchange: string;
  queue?: string;
  durable?: boolean;
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
        const event = JSON.parse(message.content.toString("utf8")) as CacheEvent;
        void handler(event);
      });
      return async () => {
        await options.channel.cancel(consumer.consumerTag);
      };
    },
  };
}
