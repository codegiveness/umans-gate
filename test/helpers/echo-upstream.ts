// Echo upstream: returns EXACTLY what it receives (method, path, headers, body)
// so tests can diff "direct" vs "through proxy" to isolate what the proxy changes.

import type { Server } from "bun";

let server: ReturnType<typeof Bun.serve> | null = null;
let currentPort = 9098;

export function startEchoUpstream(port = 0): ReturnType<typeof Bun.serve> {
  if (server) return server;

  const actualPort = port === 0 ? 0 : port;
  server = Bun.serve({
    port: actualPort,
    async fetch(req) {
      const url = new URL(req.url);
      const headers: Record<string, string> = {};
      req.headers.forEach((v, k) => {
        headers[k] = v;
      });
      const body = req.method !== "GET" && req.method !== "HEAD" ? await req.text() : "";
      return Response.json(
        {
          method: req.method,
          path: url.pathname,
          received_headers: headers,
          body,
        },
        { headers: { "x-echo": "yes" } },
      );
    },
  });

  currentPort = server.port ?? currentPort;
  return server;
}

export function stopEchoUpstream(): void {
  if (server) {
    server.stop();
    server = null;
  }
}

export function getEchoPort(): number {
  return server?.port ?? currentPort;
}
