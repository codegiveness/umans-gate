// Write-behind queue for capture updates.
// Batches database writes to reduce SQLite contention during streaming.

import type { UpdateParams } from "./db.js";
import { buildSummary } from "./helpers.js";
import { createLogger } from "./logger.js";
import type { ProtocolConfig, QueueConfig, RequestMeta, ResponseMeta, WsMessage } from "./types.js";

const logger = createLogger("queue");

interface QueuedUpdate {
  id: number;
  reqMeta: RequestMeta;
  res: ResponseMeta;
}

/** Abstraction over the capture persistence layer used by WriteQueue. */
export interface CaptureStore {
  updateCapture(params: UpdateParams): void;
  batchUpdate(items: Array<{ id: number; res: Omit<UpdateParams, "$id"> }>): void;
}

/**
 * Batches response metadata updates and flushes them to the database
 * in a single transaction. Broadcasts WebSocket updates after each flush
 * via the optional onFlush callback.
 */
export class WriteQueue {
  private queue: QueuedUpdate[] = [];
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly flushIntervalMs: number;
  private readonly flushBatch: number;
  private readonly queueMaxDepth: number;
  private store: CaptureStore;
  private onFlush?: (messages: WsMessage[]) => void;
  private config: QueueConfig & ProtocolConfig;

  constructor(
    store: CaptureStore,
    config: QueueConfig & ProtocolConfig,
    onFlush?: (messages: WsMessage[]) => void,
  ) {
    this.store = store;
    this.config = config;
    this.onFlush = onFlush;
    this.flushIntervalMs = config.flushIntervalMs;
    this.flushBatch = config.flushBatch;
    this.queueMaxDepth = config.queueMaxDepth;
  }

  /** Queue a response metadata update for a capture. */
  queueUpdate(id: number, reqMeta: RequestMeta, res: ResponseMeta): void {
    this.queue.push({ id, reqMeta, res });
    if (this.queue.length >= this.flushBatch) {
      if (this.flushTimer) {
        clearTimeout(this.flushTimer);
        this.flushTimer = null;
      }
      this.flushNow();
    } else if (!this.flushTimer) {
      this.flushTimer = setTimeout(() => this.flushNow(), this.flushIntervalMs);
    }
    if (this.queue.length >= this.queueMaxDepth) {
      if (this.flushTimer) {
        clearTimeout(this.flushTimer);
        this.flushTimer = null;
      }
      this.flushNow();
      if (this.queue.length >= this.queueMaxDepth) {
        const dropped = this.queue.shift();
        logger.warn("WriteQueue overflow: dropped oldest entry", {
          captureId: dropped?.id,
          depth: this.queue.length,
          maxDepth: this.queueMaxDepth,
        });
      }
    }
  }

  get length(): number {
    return this.queue.length;
  }

  get hasTimer(): boolean {
    return this.flushTimer !== null;
  }

  /** Flush all queued updates to the database immediately. */
  flushNow(): void {
    this.flushTimer = null;
    if (this.queue.length === 0) return;
    const batch = this.queue.splice(0, this.queue.length);
    this.store.batchUpdate(batch.map((it) => ({ id: it.id, res: it.res })));
    if (this.onFlush) {
      const messages: WsMessage[] = batch.map((it) => ({
        type: "update" as const,
        capture: buildSummary(it.id, it.reqMeta, it.res, this.config),
      }));
      this.onFlush(messages);
    }
  }
}
