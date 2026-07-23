// Raw TCP upstream that captures the exact wire bytes (headers + body).
// Used for testing TTL stamping by inspecting what the proxy actually sent.

import type { AddressInfo } from "node:net";
import { createServer, type Server as NetServer, type Socket } from "node:net";

export interface RawRequest {
  head: string;
  body: string;
}

export interface RawUpstreamHandle {
  server: NetServer;
  port: number;
  getLastRequest(): RawRequest | null;
  close(): Promise<void>;
}

/** Start a raw TCP server that captures the exact HTTP request bytes. */
export function startRawUpstream(port = 0): Promise<RawUpstreamHandle> {
  return new Promise((resolve, reject) => {
    let lastReq: RawRequest | null = null;

    const server = createServer((sock: Socket) => {
      let buf = Buffer.alloc(0);
      let headEnd = -1;
      let responded = false;

      sock.on("data", (d: Buffer) => {
        buf = Buffer.concat([buf, d]);
        if (headEnd === -1) {
          headEnd = buf.indexOf("\r\n\r\n");
          if (headEnd !== -1 && !responded) {
            responded = true;
            setTimeout(() => {
              lastReq = {
                head: buf.slice(0, headEnd).toString("latin1"),
                body: buf.slice(headEnd + 4).toString("utf8"),
              };
              const resp = '{"ok":true}';
              sock.end(
                `HTTP/1.1 200 OK\r\nContent-Length: ${resp.length}\r\nConnection: close\r\n\r\n${resp}`,
              );
            }, 80);
          }
        }
      });
      sock.on("error", () => {});
    });

    server.listen(port, "127.0.0.1", () => {
      const addr = server.address() as AddressInfo;
      resolve({
        server,
        port: addr.port,
        getLastRequest: () => lastReq,
        close: () =>
          new Promise<void>((res) => {
            server.close(() => res());
          }),
      });
    });

    server.on("error", reject);
  });
}
