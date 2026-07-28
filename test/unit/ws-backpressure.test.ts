import { describe, expect, test } from "bun:test";
import { type BunServerWebSocket, WsBroadcaster } from "../../src/ws.js";

function makeStub(sendResult: number | (() => number), closeImpl?: () => void): BunServerWebSocket {
  return {
    readyState: 1,
    send: typeof sendResult === "function" ? sendResult : () => sendResult,
    close: (_code?: number, _reason?: string) => {
      closeImpl?.();
    },
  };
}

describe("WsBroadcaster.backpressure", () => {
  test("keeps client when send returns -1 (backpressure, message enqueued)", () => {
    const ws = new WsBroadcaster();
    let closed = false;
    const stub = makeStub(-1, () => {
      closed = true;
    });
    ws.add(stub);
    ws.broadcast({ type: "new", capture: { id: "1" } as never });
    expect(ws.size).toBe(1);
    expect(closed).toBe(false);
  });

  test("removes and closes client when send returns 0", () => {
    const ws = new WsBroadcaster();
    let closed = false;
    const stub = makeStub(0, () => {
      closed = true;
    });
    ws.add(stub);
    ws.broadcast({ type: "new", capture: { id: "2" } as never });
    expect(ws.size).toBe(0);
    expect(closed).toBe(true);
  });

  test("removes client when send throws", () => {
    const ws = new WsBroadcaster();
    const stub = makeStub(() => {
      throw new Error("send failed");
    });
    ws.add(stub);
    ws.broadcast({ type: "new", capture: { id: "3" } as never });
    expect(ws.size).toBe(0);
  });

  test("keeps client when send returns a positive number", () => {
    const ws = new WsBroadcaster();
    let sent = false;
    const stub = makeStub(() => {
      sent = true;
      return 42;
    });
    ws.add(stub);
    ws.broadcast({ type: "new", capture: { id: "4" } as never });
    expect(ws.size).toBe(1);
    expect(sent).toBe(true);
  });
});
