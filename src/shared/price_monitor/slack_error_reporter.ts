import { Redis } from "ioredis";

const QUEUE_KEY = Deno.env.get("REDIS_QUEUE_KEY") ??
  Deno.env.get("SLACK_QUEUE_KEY") ?? "slack:alert:queue";
const REDIS_URL = Deno.env.get("REDIS_URL") ?? "redis://127.0.0.1:6379";
const DUPLICATE_WINDOW_MS = 5 * 60 * 1000;

export function installSlackErrorReporter(service: string): void {
  const originalError = console.error.bind(console);
  const originalWarn = console.warn.bind(console);
  const recentErrors = new Map<string, number>();
  const pendingErrors = new Set<string>();
  let lastQueueFailureAt = 0;

  const enqueueError = async (values: unknown[]): Promise<void> => {
    const errorMessage = values.map(formatValue).join(" ")
      .replace(/\b(xox[baprs]-)[A-Za-z0-9-]+/g, "$1[REDACTED]")
      .replace(/\b(Bearer\s+)[A-Za-z0-9._~+/-]+=*/gi, "$1[REDACTED]")
      .replace(/((?:redis|https?):\/\/[^:/\s]+:)[^@\s]+@/gi, "$1[REDACTED]@")
      .replace(
        /\b(password|secret|token|api[_-]?key)\s*([=:])\s*(['"]?)[^\s,;'"`]+/gi,
        "$1$2[REDACTED]",
      )
      .trim()
      .slice(0, 1200);
    if (!errorMessage) return;

    const key = `${service}:${errorMessage}`;
    const now = Date.now();
    const lastSentAt = recentErrors.get(key);
    if (
      (lastSentAt && now - lastSentAt < DUPLICATE_WINDOW_MS) ||
      pendingErrors.has(key)
    ) return;

    pendingErrors.add(key);
    const redis = new Redis(REDIS_URL, {
      connectTimeout: 1000,
      commandTimeout: 2000,
      maxRetriesPerRequest: 1,
      retryStrategy: (attempt) => attempt === 1 ? 200 : null,
    });
    redis.on("error", () => {});

    try {
      await redis.lpush(
        QUEUE_KEY,
        JSON.stringify({
          type: "ERROR",
          worker: service,
          timestamp: now,
          payload: {
            errorMessage,
            context: "runtime",
            worker: service,
          },
        }),
      );
      recentErrors.set(key, now);
      if (recentErrors.size > 200) {
        for (const [errorKey, timestamp] of recentErrors) {
          if (now - timestamp >= DUPLICATE_WINDOW_MS) {
            recentErrors.delete(errorKey);
          }
        }
      }
    } catch (error) {
      if (now - lastQueueFailureAt >= 30_000) {
        lastQueueFailureAt = now;
        originalWarn(
          `[${service}] Slack error notification enqueue failed:`,
          error,
        );
      }
    } finally {
      pendingErrors.delete(key);
      redis.disconnect();
    }
  };

  enqueueSlackError = enqueueError;
  console.error = (...values: Parameters<typeof console.error>) => {
    originalError(...values);
    void enqueueError(values);
  };

  globalThis.addEventListener("unhandledrejection", (event) => {
    void enqueueError([event.reason]);
  });
  globalThis.addEventListener("error", (event) => {
    const value = event instanceof ErrorEvent ? event.error ?? event.message : event;
    void enqueueError([value]);
  });
}

function formatValue(value: unknown): string {
  if (value instanceof Error) return `${value.name}: ${value.message}`;
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}
type ErrorValues = Parameters<typeof console.error>;

let enqueueSlackError: ((values: ErrorValues) => Promise<void>) | undefined;

export async function reportSlackError(
  error: unknown,
  context = "runtime",
): Promise<void> {
  if (!enqueueSlackError) {
    console.warn("Slack error reporter is not initialized");
    return;
  }
  const values: ErrorValues = [`[${context}]`, error];
  await enqueueSlackError(values);
}
