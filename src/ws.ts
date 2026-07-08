// WebSocket broadcast manager.
// Tracks connected inspector clients and fans out capture updates.

import type { WsMessage } from "./types.js";

export type { WsMessage };

/** A Bun WebSocket server instance. */
export interface BunServerWebSocket {
  send(data: string): number;
  close(code?: number, reason?: string): void;
  readyState: number;
}

/**
 * Manages the set of connected WebSocket clients and broadcasts messages.
 * Decoupled from the server lifecycle so tests can stub it.
 */
export class WsBroadcaster {
  private clients = new Set<BunServerWebSocket>();

  /** Add a client to the broadcast set. */
  add(ws: BunServerWebSocket): void {
    this.clients.add(ws);
  }

  /** Remove a client from the broadcast set. */
  remove(ws: BunServerWebSocket): void {
    this.clients.delete(ws);
  }

  /** Broadcast a message to all connected clients. Swallows per-client errors. */
  broadcast(msg: WsMessage): void {
    const s = JSON.stringify(msg);
    for (const ws of this.clients) {
      try {
        const sent = ws.send(s);
        if (sent === 0) {
          // Message dropped — the connection is dead or over backpressure.
          this.clients.delete(ws);
          try {
            ws.close(1013, "backpressure");
          } catch {
            // Ignore close failures on already-closed sockets.
          }
        }
      } catch {
        this.clients.delete(ws);
      }
    }
  }

  /** Current number of connected clients. */
  get size(): number {
    return this.clients.size;
  }
}
