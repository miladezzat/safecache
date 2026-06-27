import {
  jsonSerializer as coreJsonSerializer,
  type CacheEntry,
  type CacheSerializer,
} from "@safecache/core";

const DATE_MARKER = "__safecache_date";
const ESCAPE_PREFIX = "__safecache_esc_";

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

function needsEscape(key: string): boolean {
  return key === DATE_MARKER || key.startsWith(ESCAPE_PREFIX);
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
      Object.entries(value).map(([key, nested]) => [
        needsEscape(key) ? `${ESCAPE_PREFIX}${key}` : key,
        encodeDates(nested),
      ]),
    );
  }
  return value;
}

function isEncodedDate(record: Record<string, unknown>): boolean {
  const keys = Object.keys(record);
  return keys.length === 1 && keys[0] === DATE_MARKER && typeof record[DATE_MARKER] === "string";
}

function decodeDates(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => decodeDates(item));
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (isEncodedDate(record)) {
      return new Date(record[DATE_MARKER] as string);
    }
    return Object.fromEntries(
      Object.entries(record).map(([key, nested]) => [
        key.startsWith(ESCAPE_PREFIX) ? key.slice(ESCAPE_PREFIX.length) : key,
        decodeDates(nested),
      ]),
    );
  }
  return value;
}
