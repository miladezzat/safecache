import { createCache } from "@safecache/core";
import { memoryProvider } from "@safecache/memory";
import { SafeCacheModule } from "@safecache/nestjs";

const cache = createCache({
  namespace: "nestjs-example",
  provider: memoryProvider(),
  defaultTtl: "5m",
});

export const moduleDefinition = SafeCacheModule.forRoot({ cache });
