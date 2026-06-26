import {
  redisProvider,
  type RedisProvider,
  type RedisProviderClient,
  type RedisProviderOptions,
} from "@safecache/redis";

export type ValkeyProviderClient = RedisProviderClient;
export type ValkeyProviderOptions = RedisProviderOptions;
export type ValkeyProvider = RedisProvider;

export function valkeyProvider(
  client: ValkeyProviderClient,
  options: ValkeyProviderOptions = {},
): ValkeyProvider {
  return redisProvider(client, {
    tagPrefix: options.tagPrefix ?? "__safecache:valkey:tags",
  });
}
