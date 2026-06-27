import type { CacheEntry, CacheSerializer } from "./types";

export function jsonSerializer(): CacheSerializer {
  return {
    serialize(entry: CacheEntry) {
      return JSON.stringify(entry);
    },
    deserialize<T>(raw: string | Uint8Array) {
      const text = typeof raw === "string" ? raw : new TextDecoder().decode(raw);
      const parsed: unknown = JSON.parse(text);
      // JSON round-trips only plain data: Date becomes a string, Map/Set are
      // lost. Entry fields are stored as primitives, so we validate them as such.
      if (typeof parsed !== "object" || parsed === null) {
        throw new Error("Invalid cache entry");
      }
      const candidate = parsed as Record<string, unknown>;
      if (typeof candidate["expiresAt"] !== "number" || !Number.isFinite(candidate["expiresAt"])) {
        throw new Error("Invalid cache entry");
      }
      if (typeof candidate["createdAt"] !== "number") {
        throw new Error("Invalid cache entry");
      }
      if (!Array.isArray(candidate["tags"])) {
        throw new Error("Invalid cache entry");
      }
      if (candidate["staleUntil"] !== undefined && typeof candidate["staleUntil"] !== "number") {
        throw new Error("Invalid cache entry");
      }
      const version = candidate["version"];
      if (version !== undefined && typeof version !== "string" && typeof version !== "number") {
        throw new Error("Invalid cache entry");
      }
      return parsed as CacheEntry<T>;
    },
  };
}
