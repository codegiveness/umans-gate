// Echo upstream: returns EXACTLY what it receives (method, path, headers, body)
// so tests can diff "direct" vs "through proxy" to isolate what the proxy changes.

import type { Server } from "bun";

export function startEchoUpstream(port = 0): ReturnType<typeof Bun.serve> {
  return Bun.serve({
    port,
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
}

export function stopEchoUpstream(server: ReturnType<typeof Bun.serve>): void {
  server.stop();
}

export function getEchoPort(server: ReturnType<typeof Bun.serve>): number {
  return server.port ?? 0;
}
