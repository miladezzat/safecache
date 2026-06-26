export const cliCommands = [
  "doctor",
  "stats",
  "inspect",
  "invalidate",
  "invalidate-tag",
  "warm",
  "benchmark",
] as const;

export type SafeCacheCliCommand = (typeof cliCommands)[number];

export interface DoctorCheck {
  name: string;
  ok: boolean;
  details?: Record<string, unknown>;
}

export interface DoctorResult {
  ok: boolean;
  checks: DoctorCheck[];
}

export interface SafeCacheCliAdapter {
  doctor?(): Promise<DoctorResult>;
  stats?(): Promise<unknown>;
  inspect?(key: string): Promise<unknown>;
  invalidate?(key: string): Promise<void>;
  invalidateTag?(tag: string): Promise<void>;
  warm?(): Promise<unknown>;
  benchmark?(): Promise<unknown>;
}

export interface SafeCacheCliResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface MemoryCliEntry {
  value: unknown;
  tags?: string[];
}

export interface MemoryCliAdapterOptions {
  entries?: Map<string, MemoryCliEntry>;
  stats?: unknown;
}

export async function runSafeCacheCli(
  argv: string[],
  adapter: SafeCacheCliAdapter = createMemoryCliAdapter(),
): Promise<SafeCacheCliResult> {
  const [command, argument] = argv;

  try {
    switch (command) {
      case "doctor":
        return doctor(adapter);
      case "stats":
        return jsonResult(await requireCommand(adapter.stats, "stats")());
      case "inspect":
        return jsonResult(await requireArgumentCommand(adapter.inspect, "inspect", argument));
      case "invalidate":
        await requireArgumentCommand(adapter.invalidate, "invalidate", argument);
        return textResult(`invalidated ${argument}`);
      case "invalidate-tag":
        await requireArgumentCommand(adapter.invalidateTag, "invalidate-tag", argument);
        return textResult(`invalidated tag ${argument}`);
      case "warm":
        return jsonResult(await requireCommand(adapter.warm, "warm")());
      case "benchmark":
        return jsonResult(await requireCommand(adapter.benchmark, "benchmark")());
      case undefined:
        return usageResult(1);
      default:
        return {
          exitCode: 1,
          stdout: usage(),
          stderr: `Unknown command: ${command}`,
        };
    }
  } catch (error) {
    return {
      exitCode: 1,
      stdout: "",
      stderr: error instanceof Error ? error.message : String(error),
    };
  }
}

export function createMemoryCliAdapter(options: MemoryCliAdapterOptions = {}): SafeCacheCliAdapter {
  const entries = options.entries ?? new Map<string, MemoryCliEntry>();

  return {
    async doctor() {
      return {
        ok: true,
        checks: [{ name: "memory", ok: true }],
      };
    },

    async stats() {
      return (
        options.stats ?? {
          entries: entries.size,
        }
      );
    },

    async inspect(key) {
      return entries.get(key) ?? null;
    },

    async invalidate(key) {
      entries.delete(key);
    },

    async invalidateTag(tag) {
      for (const [key, entry] of entries) {
        if (entry.tags?.includes(tag)) {
          entries.delete(key);
        }
      }
    },

    async warm() {
      return { warmed: entries.size };
    },

    async benchmark() {
      return { operations: 1_000, durationMs: 0 };
    },
  };
}

function doctor(adapter: SafeCacheCliAdapter): Promise<SafeCacheCliResult> {
  return requireCommand(adapter.doctor, "doctor")().then((result) => ({
    exitCode: result.ok ? 0 : 1,
    stdout: `${JSON.stringify(result, null, 2)}\n`,
    stderr: "",
  }));
}

function requireCommand<T>(
  command: (() => Promise<T>) | undefined,
  name: string,
): () => Promise<T> {
  if (!command) {
    throw new Error(`Command is not configured: ${name}`);
  }
  return command;
}

async function requireArgumentCommand<T>(
  command: ((argument: string) => Promise<T>) | undefined,
  name: string,
  argument: string | undefined,
): Promise<T> {
  if (!argument) {
    throw new Error(`Missing argument for command: ${name}`);
  }
  if (!command) {
    throw new Error(`Command is not configured: ${name}`);
  }
  return command(argument);
}

function jsonResult(value: unknown): SafeCacheCliResult {
  return {
    exitCode: 0,
    stdout: `${JSON.stringify(value, null, 2)}\n`,
    stderr: "",
  };
}

function textResult(stdout: string): SafeCacheCliResult {
  return {
    exitCode: 0,
    stdout: `${stdout}\n`,
    stderr: "",
  };
}

function usageResult(exitCode: number): SafeCacheCliResult {
  return {
    exitCode,
    stdout: usage(),
    stderr: "",
  };
}

function usage(): string {
  return `Usage: safecache <command>

Commands:
  doctor
  stats
  inspect <key>
  invalidate <key>
  invalidate-tag <tag>
  warm
  benchmark
`;
}
