/**
 * Slack 送信履歴 WebUI サーバー (履歴 API + 静的HTML)
 */

import type { MessageHistoryStore } from "../shared/message_history_store.ts";

export interface WebServerOptions {
  port: number;
  store: MessageHistoryStore;
  /** テストメッセージをキューへ投入し、traceId を返す */
  enqueueTestMessage: () => Promise<string>;
}

export class HistoryWebServer {
  private readonly startedAt = Date.now();
  private readonly html: string;
  private server?: Deno.HttpServer;

  constructor(private readonly opts: WebServerOptions) {
    this.html = Deno.readTextFileSync(new URL("./public/index.html", import.meta.url));
  }

  public start(): Deno.HttpServer {
    this.server = Deno.serve({
      port: this.opts.port,
      onListen: ({ hostname, port }) =>
        console.log(`[SlackWebUI] running at http://${hostname}:${port}/`),
    }, (req) => this.handle(req));
    return this.server;
  }

  public async stop(): Promise<void> {
    await this.server?.shutdown();
  }

  private json(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
    });
  }

  private async handle(req: Request): Promise<Response> {
    const url = new URL(req.url);
    try {
      switch (url.pathname) {
        case "/":
        case "/index.html":
          return new Response(this.html, {
            headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-cache" },
          });
        case "/api/health":
          return this.json({
            status: "ok",
            uptimeSeconds: Math.floor((Date.now() - this.startedAt) / 1000),
            timestamp: Date.now(),
            version: "1.0.0",
          });
        case "/api/test-slack": {
          if (req.method !== "POST") return this.json({ error: "Method Not Allowed" }, 405);
          return this.json({ traceId: await this.opts.enqueueTestMessage() });
        }
        case "/api/stats":
          return this.json(this.opts.store.getStats());
        case "/api/messages": {
          if (req.method !== "GET") return this.json({ error: "Method Not Allowed" }, 405);
          const p = url.searchParams;
          const okParam = p.get("ok");
          return this.json(this.opts.store.query({
            hours: Number(p.get("hours") || 0) || undefined,
            type: p.get("type") || undefined,
            ok: okParam === null || okParam === "" ? undefined : okParam === "true",
            keyword: p.get("keyword") || undefined,
            limit: Number(p.get("limit") || 100),
            offset: Number(p.get("offset") || 0),
          }));
        }
      }

      const messageIdMatch = /^\/api\/messages\/([^/]+)$/.exec(url.pathname);
      if (messageIdMatch) {
        if (req.method !== "DELETE") return this.json({ error: "Method Not Allowed" }, 405);
        if (!/^[1-9]\d*$/.test(messageIdMatch[1])) {
          return this.json({ error: "Invalid message ID" }, 400);
        }
        const id = Number(messageIdMatch[1]);
        if (!Number.isSafeInteger(id)) return this.json({ error: "Invalid message ID" }, 400);
        if (!this.opts.store.deleteById(id)) return this.json({ error: "Not Found" }, 404);
        return this.json({ deleted: true, id });
      }

      return this.json({ error: "Not Found", path: url.pathname }, 404);
    } catch (err) {
      console.error("[SlackWebUI] request error:", err);
      return this.json({ error: "Internal Server Error", message: String(err) }, 500);
    }
  }
}
