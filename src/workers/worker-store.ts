import type { UpdateParams } from "../db.js";
import { createLogger } from "../logger.js";
import type { CaptureStore } from "../queue.js";

const logger = createLogger("worker-store");

const ACK_TIMEOUT_MS = 10_000;

interface PendingBatch {
  resolve: () => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  itemCount: number;
}

export class WorkerCaptureStore implements CaptureStore {
  private worker: Worker;
  private dbPath: string;
  private compressionEnabled: boolean;
  private nextBatchId = 1;
  private pending = new Map<number, PendingBatch>();

  constructor(dbPath: string, compressionEnabled: boolean) {
    this.dbPath = dbPath;
    this.compressionEnabled = compressionEnabled;
    this.worker = new Worker(new URL("./write-worker.ts", import.meta.url));
    this.worker.onmessage = (e: MessageEvent) => {
      const msg = e.data as { type: string; batchId?: number; count?: number; error?: string };
      if (!msg.batchId) return;
      const pending = this.pending.get(msg.batchId);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pending.delete(msg.batchId);
      if (msg.type === "error") {
        logger.error("worker batch write failed", { error: msg.error, count: msg.count });
        pending.reject(new Error(msg.error ?? "unknown worker error"));
      } else {
        pending.resolve();
      }
    };
    this.worker.onerror = (e: ErrorEvent) => {
      logger.error("worker error", { message: e.message });
      for (const [id, pending] of this.pending) {
        clearTimeout(pending.timer);
        this.pending.delete(id);
        pending.reject(new Error(`worker crashed: ${e.message}`));
      }
    };
  }

  updateCapture(_params: UpdateParams): void {
    throw new Error(
      "updateCapture should not be called on WorkerCaptureStore — use the main db for single updates",
    );
  }

  batchUpdate(items: Array<{ id: number; res: Omit<UpdateParams, "$id"> }>): Promise<void> {
    const batchId = this.nextBatchId++;
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(batchId);
        logger.error("worker ack timeout", { batchId, count: items.length });
        reject(new Error(`worker ack timeout for batch ${batchId}`));
      }, ACK_TIMEOUT_MS);
      this.pending.set(batchId, { resolve, reject, timer, itemCount: items.length });
      this.worker.postMessage({
        type: "batch",
        batchId,
        dbPath: this.dbPath,
        items,
        compressionEnabled: this.compressionEnabled,
      });
    });
  }

  async close(): Promise<void> {
    this.worker.postMessage({ type: "close" });
    const drainDeadline = Date.now() + ACK_TIMEOUT_MS;
    while (this.pending.size > 0 && Date.now() < drainDeadline) {
      await Bun.sleep(50);
    }
    for (const [, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(new Error("worker closed before ack"));
    }
    this.pending.clear();
    this.worker.terminate();
  }
}
