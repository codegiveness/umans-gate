import { describe, expect, test } from "bun:test";
import { type BunServerWebSocket, WsBroadcaster } from "../../src/ws.js";

function makeStub(): {
  ws: BunServerWebSocket;
  state: { closed: { code: number; reason: string } | null };
} {
  const state = { closed: null as { code: number; reason: string } | null };
  const ws: BunServerWebSocket = {
    readyState: 1,
    send: () => 1,
    close: (code?: number, reason?: string) => {
      state.closed = { code: code ?? 0, reason: reason ?? "" };
    },
  };
  return { ws, state };
}

describe("WsBroadcaster.closeAll", () => {
  test("closes all connected clients with 1001 and clears the set", () => {
    const b = new WsBroadcaster();
    const a = makeStub();
    const b2 = makeStub();
    b.add(a.ws);
    b.add(b2.ws);
    expect(b.size).toBe(2);

    b.closeAll();

    expect(b.size).toBe(0);
    expect(a.state.closed).toEqual({ code: 1001, reason: "server shutting down" });
    expect(b2.state.closed).toEqual({ code: 1001, reason: "server shutting down" });
  });

  test("swallows close errors on already-closed sockets", () => {
    const b = new WsBroadcaster();
    const { ws } = makeStub();
    b.add(ws);
    ws.close = () => {
      throw new Error("already closed");
    };

    b.closeAll();
    expect(b.size).toBe(0);
  });

  test("closeAll on empty set is a no-op", () => {
    const b = new WsBroadcaster();
    b.closeAll();
    expect(b.size).toBe(0);
  });
});
