import {
  jsonSerializer as coreJsonSerializer,
  type CacheEntry,
  type CacheSerializer,
} from "@safecache/core";

const DATE_MARKER = "__safecache_date";

export function jsonSerializer(): CacheSerializer {
  return coreJsonSerializer();
}

export function superJsonSerializer(): CacheSerializer {
  return {
    serialize(entry) {
      return JSON.stringify(encodeDates(entry));
    },
    deserialize<T>(raw: string | Uint8Array) {
      const text = typeof raw === "string" ? raw : new TextDecoder().decode(raw);
      return decodeDates(JSON.parse(text)) as CacheEntry<T>;
    },
  };
}

export function msgpackSerializer(): CacheSerializer {
  return {
    serialize(entry) {
      return new TextEncoder().encode(JSON.stringify(entry));
    },
    deserialize<T>(raw: string | Uint8Array) {
      const text = typeof raw === "string" ? raw : new TextDecoder().decode(raw);
      return JSON.parse(text) as CacheEntry<T>;
    },
  };
}

function encodeDates(value: unknown): unknown {
  if (value instanceof Date) {
    return { [DATE_MARKER]: value.toISOString() };
  }
  if (Array.isArray(value)) {
    return value.map((item) => encodeDates(item));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, nested]) => [key, encodeDates(nested)]),
    );
  }
  return value;
}

function decodeDates(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => decodeDates(item));
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (typeof record[DATE_MARKER] === "string") {
      return new Date(record[DATE_MARKER]);
    }
    return Object.fromEntries(
      Object.entries(record).map(([key, nested]) => [key, decodeDates(nested)]),
    );
  }
  return value;
}
