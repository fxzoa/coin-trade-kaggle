import { Redis } from "ioredis";

const QUEUE_KEY = Deno.env.get("REDIS_QUEUE_KEY") ??
  Deno.env.get("SLACK_QUEUE_KEY") ??
  "slack:alert:queue";
const DEDUPLICATION_WINDOW_MS = 5 * 60 * 1000;
const MAX_ERROR_LENGTH = 2_000;

let redisUrl: string | undefined;
let serviceName = "hl-dashboard-webui";
let installed = false;
const recentErrors = new Map<string, number>();
const originalConsoleError = console.error.bind(console);

function redact(value: string): string {
  return value
    .replace(/(xox[baprs]-)[A-Za-z0-9-]+/gi, "$1[REDACTED]")
    .replace(
      /((?:token|password|secret|api[_-]?key)\s*[:=]\s*)["']?[^,\s"']+/gi,
      "$1[REDACTED]",
    )
    .slice(0, MAX_ERROR_LENGTH);
}

function serializeError(value: unknown): string {
  if (value instanceof Error) return `${value.name}: ${value.message}`;
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export async function reportSlackError(
  error: unknown,
  context = "runtime",
): Promise<void> {
  const errorMessage = redact(serializeError(error));
  const key = `${context}:${errorMessage}`;
  const now = Date.now();
  const lastReported = recentErrors.get(key);
  if (
    lastReported !== undefined && now - lastReported < DEDUPLICATION_WINDOW_MS
  ) return;
  recentErrors.set(key, now);

  if (!redisUrl) {
    originalConsoleError(
      `[${serviceName}] Slack error reporter is not initialized`,
    );
    return;
  }

  const client = new Redis(redisUrl, {
    lazyConnect: true,
    maxRetriesPerRequest: 1,
    retryStrategy: (times: number) => times < 2 ? Math.min(times * 500, 1_000) : null,
  });
  const message = {
    type: "ERROR",
    worker: serviceName,
    timestamp: new Date(now).toISOString(),
    payload: { errorMessage, context, worker: serviceName },
  };
  try {
    await client.lpush(QUEUE_KEY, JSON.stringify(message)).finally(() => client.disconnect());
  } catch (reportingError) {
    originalConsoleError(
      `[${serviceName}] Failed to enqueue Slack error alert:`,
      reportingError,
    );
  }
}

export function installSlackErrorReporter(name = serviceName): void {
  if (installed) return;
  installed = true;
  serviceName = name;

  redisUrl = Deno.env.get("REDIS_URL");
  if (!redisUrl) {
    console.warn(
      `[${serviceName}] REDIS_URL is not set; Slack error alerts are disabled`,
    );
    return;
  }

  console.error = (...args: unknown[]) => {
    originalConsoleError(...args);
    void reportSlackError(args.map(serializeError).join(" "), "console.error");
  };

  globalThis.addEventListener("unhandledrejection", (event) => {
    void reportSlackError(event.reason, "unhandledrejection");
  });
  globalThis.addEventListener("error", (event) => {
    void reportSlackError(event.error ?? event.message, "uncaught exception");
  });
}
