import { randomBytes, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import { extname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { dashboard, markSeen, refresh, register, remove } from "@agent-corpus/project-watch";
import { report } from "@agent-corpus/task-report";
export async function serve(port = 17999, pollMs = 60000) {
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("Invalid port");
  if (!Number.isFinite(pollMs) || pollMs < 5000)
    throw new Error("Poll interval must be >= 5 seconds");
  const token = randomBytes(32).toString("hex");
  const clients = new Set<ServerResponse>();
  const assets = fileURLToPath(new URL("./web/", import.meta.url));
  let sequence = 0,
    closed = false;
  let expectedOrigin = "";
  let collecting = false;
  const boardState = async () => ({ ...(await dashboard()), refreshing: collecting });
  async function publish() {
    const payload = JSON.stringify(await boardState());
    for (const client of clients) {
      if (client.writableLength > 1024 * 1024) {
        client.destroy();
        clients.delete(client);
        continue;
      }
      client.write(`id: ${++sequence}\ndata: ${payload}\n\n`);
    }
  }
  const server = createServer(async (req, res) => {
    try {
      const localPort = new URL(expectedOrigin).port;
      if (![`127.0.0.1:${localPort}`, `localhost:${localPort}`].includes(req.headers.host ?? "")) {
        res.writeHead(403).end();
        return;
      }
      const origin = req.headers.origin;
      if (origin && origin !== `http://${req.headers.host}`) {
        res.writeHead(403).end();
        return;
      }
      if (req.headers["sec-fetch-site"] === "cross-site") {
        res.writeHead(403).end();
        return;
      }
      res.setHeader("X-Content-Type-Options", "nosniff");
      res.setHeader("Cache-Control", "no-store");
      res.setHeader(
        "Content-Security-Policy",
        "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'",
      );
      const url = new URL(req.url ?? "/", expectedOrigin);
      const json = (value: unknown) => {
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify(value));
      };
      if (req.method === "GET" && url.pathname === "/api/session") {
        json({ token });
        return;
      }
      if (req.method === "GET" && url.pathname === "/api/state") {
        json(await boardState());
        return;
      }
      if (req.method === "GET" && url.pathname === "/api/events") {
        res.writeHead(200, { "Content-Type": "text/event-stream", Connection: "keep-alive" });
        clients.add(res);
        res.write(`data: ${JSON.stringify(await boardState())}\n\n`);
        req.on("close", () => clients.delete(res));
        return;
      }
      if (req.method === "POST" && url.pathname.startsWith("/api/")) {
        const supplied = Buffer.from(String(req.headers["x-tracker-token"] ?? ""));
        const expected = Buffer.from(token);
        if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
          res.writeHead(403).end();
          return;
        }
        let body = "";
        for await (const chunk of req) {
          body += chunk;
          if (Buffer.byteLength(body) > 65536) {
            res.writeHead(413).end();
            return;
          }
        }
        const input = JSON.parse(body || "{}") as Record<string, unknown>;
        if (url.pathname === "/api/projects") {
          if (typeof input.source !== "string" || !input.source.startsWith("https://github.com/"))
            throw new Error(
              "Browser additions require a GitHub issue URL; register local files with the CLI",
            );
          await register(input.source);
        } else if (url.pathname === "/api/remove") {
          if (typeof input.id !== "string") throw new Error("id required");
          await remove(input.id);
        } else if (url.pathname === "/api/tasks") await report(input);
        else if (url.pathname === "/api/seen") await markSeen();
        else if (url.pathname !== "/api/refresh") {
          res.writeHead(404).end();
          return;
        }
        if (url.pathname === "/api/refresh" || url.pathname === "/api/projects") void tick();
        await publish();
        json({ ok: true });
        return;
      }
      if (req.method !== "GET") {
        res.writeHead(405).end();
        return;
      }
      const relative = decodeURIComponent(
        url.pathname === "/" ? "index.html" : url.pathname.slice(1),
      );
      const file = resolve(assets, relative);
      if (!file.startsWith(resolve(assets) + sep)) {
        res.writeHead(403).end();
        return;
      }
      try {
        const data = await readFile(file);
        res.setHeader(
          "Content-Type",
          (
            {
              ".html": "text/html",
              ".js": "text/javascript",
              ".css": "text/css",
              ".svg": "image/svg+xml",
            } as Record<string, string>
          )[extname(file)] ?? "application/octet-stream",
        );
        res.end(data);
      } catch {
        res.writeHead(404).end();
      }
    } catch (e) {
      if (!res.headersSent) res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: e instanceof Error ? e.message : String(e) }));
    }
  });
  await new Promise<void>((ok, fail) => {
    server.once("error", fail);
    server.listen(port, "127.0.0.1", () => ok());
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No listening address");
  expectedOrigin = `http://127.0.0.1:${address.port}`;
  async function tick() {
    if (collecting || closed) return;
    collecting = true;
    try {
      await publish();
      await refresh();
    } catch (e) {
      process.stderr.write(`${String(e)}\n`);
    } finally {
      collecting = false;
      if (!closed) await publish().catch((e) => process.stderr.write(`${String(e)}\n`));
    }
  }
  const timer = setInterval(() => void tick(), pollMs);
  const heartbeat = setInterval(() => {
    for (const c of clients) c.write(": heartbeat\n\n");
  }, 15000);
  void tick();
  return {
    url: expectedOrigin,
    close: async () => {
      closed = true;
      clearInterval(timer);
      clearInterval(heartbeat);
      for (const c of clients) c.end();
      await new Promise<void>((ok, fail) => server.close((e) => (e ? fail(e) : ok())));
    },
  };
}
