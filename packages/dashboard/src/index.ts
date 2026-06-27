import { toError } from "@safecache/core";

export interface HotKeyMetric {
  key: string;
  hits: number;
}

export interface TagMetric {
  tag: string;
  keys: number;
}

export interface InvalidationEventMetric {
  type: "key" | "tag";
  target: string;
  timestamp: number;
}

export interface ErrorMetric {
  operation: string;
  message: string;
  timestamp: number;
}

export interface LockContentionMetric {
  lock: string;
  waitMs: number;
}

export interface SlowCacheCallMetric {
  operation: string;
  durationMs: number;
}

export interface HealthMetric {
  name: string;
  ok: boolean;
  details?: Record<string, unknown>;
}

export interface DashboardSnapshot {
  hitRate: number;
  missRate: number;
  hotKeys: HotKeyMetric[];
  tags: TagMetric[];
  invalidationEvents: InvalidationEventMetric[];
  staleServed: number;
  errors: ErrorMetric[];
  lockContention: LockContentionMetric[];
  slowCacheCalls: SlowCacheCallMetric[];
  providerHealth: HealthMetric[];
  pluginHealth: HealthMetric[];
}

export interface DashboardRequest {
  method: string;
  path: string;
}

export interface DashboardResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}

export interface DashboardOptions {
  title?: string;
  readOnly?: boolean;
  snapshot: () => Promise<DashboardSnapshot>;
  /**
   * Optional authorization hook. The dashboard ships with NO authentication, so
   * every request can read operational metadata (key names, tags, errors). When
   * provided, this hook gates every request: returning a falsy value (or
   * throwing) results in a 401/403 before any snapshot is read or HTML rendered.
   *
   * SECURITY: this dashboard is intended to be bound to localhost / an internal
   * network by default. Expose it publicly ONLY behind this hook (or an external
   * auth proxy).
   */
  authorize?: (request: DashboardRequest) => boolean | Promise<boolean>;
  /**
   * Cache-side error notifier. SafeCache guarantees a cache failure never throws
   * into the host application: any error raised while producing the snapshot (or
   * while evaluating {@link DashboardOptions.authorize}) is caught, routed here,
   * and the handler returns a safe response instead of throwing. Defaults to a
   * silent no-op so library code never writes to the host's logs uninvited.
   */
  onError?: (error: Error) => void;
}

export interface Dashboard {
  handle(request: DashboardRequest): Promise<DashboardResponse>;
}

export function createEmptyDashboardSnapshot(): DashboardSnapshot {
  return {
    hitRate: 0,
    missRate: 0,
    hotKeys: [],
    tags: [],
    invalidationEvents: [],
    staleServed: 0,
    errors: [],
    lockContention: [],
    slowCacheCalls: [],
    providerHealth: [],
    pluginHealth: [],
  };
}

export function createDashboard(options: DashboardOptions): Dashboard {
  const readOnly = options.readOnly ?? true;
  // Default to a silent no-op: as a library we never write to the host's logs
  // uninvited. Callers wire `onError` to their own notifier/telemetry.
  const notify = options.onError ?? (() => {});

  return {
    async handle(request) {
      if (readOnly && request.method !== "GET" && request.method !== "HEAD") {
        return {
          status: 405,
          headers: { "content-type": "text/plain" },
          body: "Dashboard is read-only",
        };
      }

      // Authorization gate. A throwing/rejecting hook is treated as "deny" and
      // routed to the notifier — an auth failure must never crash the host.
      if (options.authorize) {
        let allowed: boolean;
        try {
          allowed = await options.authorize(request);
        } catch (error) {
          notify(toError(error));
          return {
            status: 403,
            headers: { "content-type": "text/plain" },
            body: "Forbidden",
          };
        }
        if (!allowed) {
          return {
            status: 401,
            headers: { "content-type": "text/plain" },
            body: "Unauthorized",
          };
        }
      }

      // SafeCache safety guarantee: a cache/stats failure must NEVER throw into
      // the host HTTP server. Catch every snapshot error, route it to the
      // notifier, and render a safe response so the host keeps serving.
      let snapshot: DashboardSnapshot;
      try {
        snapshot = await options.snapshot();
      } catch (error) {
        notify(toError(error));
        return errorResponse(request);
      }

      try {
        if (request.path === "/api/snapshot") {
          return {
            status: 200,
            headers: { "content-type": "application/json" },
            body: `${JSON.stringify(snapshot, null, 2)}\n`,
          };
        }

        return {
          status: 200,
          headers: { "content-type": "text/html; charset=utf-8" },
          body: renderDashboard(snapshot, { title: options.title }),
        };
      } catch (error) {
        // Rendering/serialization should not throw, but if a snapshot value is
        // non-serializable we still must not break the host server.
        notify(toError(error));
        return errorResponse(request);
      }
    },
  };
}

/**
 * Safe fallback response used whenever producing or rendering the snapshot
 * fails. It never leaks the underlying error message (that is routed to the
 * `onError` notifier instead) and keeps the host HTTP server alive.
 */
function errorResponse(request: DashboardRequest): DashboardResponse {
  if (request.path === "/api/snapshot") {
    return {
      status: 503,
      headers: { "content-type": "application/json" },
      body: `${JSON.stringify({ error: "dashboard snapshot unavailable" })}\n`,
    };
  }
  return {
    status: 503,
    headers: { "content-type": "text/html; charset=utf-8" },
    body: renderError(),
  };
}

function renderError(): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>SafeCache Dashboard</title>
</head>
<body>
  <main>
    <h1>Dashboard temporarily unavailable</h1>
    <p>The cache reported an error while building this snapshot. The host application is unaffected.</p>
  </main>
</body>
</html>`;
}

export function renderDashboard(
  snapshot: DashboardSnapshot,
  options: { title?: string } = {},
): string {
  const title = options.title ?? "SafeCache Dashboard";
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)}</title>
  <style>
    :root {
      color-scheme: light;
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      color: #17202a;
      background: #f7f9fb;
    }
    body {
      margin: 0;
      background: #f7f9fb;
    }
    main {
      max-width: 1180px;
      margin: 0 auto;
      padding: 32px 20px;
    }
    h1 {
      margin: 0 0 24px;
      font-size: 28px;
      line-height: 1.2;
      letter-spacing: 0;
    }
    .grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
      gap: 14px;
    }
    section {
      min-height: 126px;
      border: 1px solid #d8e0e8;
      border-radius: 8px;
      background: #ffffff;
      padding: 16px;
    }
    h2 {
      margin: 0 0 12px;
      font-size: 15px;
      line-height: 1.3;
      letter-spacing: 0;
    }
    .value {
      font-size: 26px;
      line-height: 1.2;
      font-weight: 700;
    }
    ul {
      margin: 0;
      padding-left: 18px;
    }
    li {
      margin: 6px 0;
      overflow-wrap: anywhere;
    }
    .ok {
      color: #0f766e;
    }
    .bad {
      color: #b42318;
    }
  </style>
</head>
<body>
  <main>
    <h1>${escapeHtml(title)}</h1>
    <div class="grid">
      ${panel("Hit rate", percent(snapshot.hitRate))}
      ${panel("Miss rate", percent(snapshot.missRate))}
      ${listPanel(
        "Hot keys",
        snapshot.hotKeys.map((item) => `${item.key} (${item.hits})`),
      )}
      ${listPanel(
        "Tags",
        snapshot.tags.map((item) => `${item.tag} (${item.keys})`),
      )}
      ${listPanel(
        "Invalidation events",
        snapshot.invalidationEvents.map((item) => `${item.type}:${item.target}`),
      )}
      ${panel("Stale served", String(snapshot.staleServed))}
      ${listPanel(
        "Errors",
        snapshot.errors.map((item) => `${item.operation}: ${item.message}`),
      )}
      ${listPanel(
        "Lock contention",
        snapshot.lockContention.map((item) => `${item.lock} (${item.waitMs}ms)`),
      )}
      ${listPanel(
        "Slow cache calls",
        snapshot.slowCacheCalls.map((item) => `${item.operation} (${item.durationMs}ms)`),
      )}
      ${healthPanel("Provider health", snapshot.providerHealth)}
      ${healthPanel("Plugin health", snapshot.pluginHealth)}
    </div>
  </main>
</body>
</html>`;
}

function panel(title: string, value: string): string {
  return `<section><h2>${escapeHtml(title)}</h2><div class="value">${escapeHtml(value)}</div></section>`;
}

function listPanel(title: string, items: string[]): string {
  const content =
    items.length === 0
      ? '<div class="value">0</div>'
      : `<ul>${items.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>`;
  return `<section><h2>${escapeHtml(title)}</h2>${content}</section>`;
}

function healthPanel(title: string, items: HealthMetric[]): string {
  const content =
    items.length === 0
      ? '<div class="value">0</div>'
      : `<ul>${items
          .map(
            (item) =>
              `<li class="${item.ok ? "ok" : "bad"}">${escapeHtml(item.name)}: ${
                item.ok ? "ok" : "failed"
              }</li>`,
          )
          .join("")}</ul>`;
  return `<section><h2>${escapeHtml(title)}</h2>${content}</section>`;
}

function percent(value: number): string {
  return `${Math.round(value * 100)}%`;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
