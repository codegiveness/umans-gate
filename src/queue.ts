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
  batchUpdate(items: Array<{ id: number; res: Omit<UpdateParams, "$id"> }>): Promise<void>;
  getUpstreamP50?(
    id: number,
  ): { upstream_ttft_p50_ms: number | null; upstream_tps_p50: number | null } | null;
}

/**
 * Batches response metadata updates and flushes them to the database
 * in a single transaction. Broadcasts WebSocket updates after each flush
 * via the optional onFlush callback.
 */
export class WriteQueue {
  private static readonly MAX_FLUSH_RETRIES = 10;
  private static readonly RETRY_BASE_MS = 1000;
  private static readonly RETRY_MAX_MS = 30000;
  private queue: QueuedUpdate[] = [];
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private flushRetryCount = 0;
  private flushing: Promise<void> | null = null;
  private readonly flushIntervalMs: number;
  private readonly flushBatch: number;
  private readonly queueMaxDepth: number;
  private store: CaptureStore;
  private onFlush?: (messages: WsMessage[]) => void;
  private onDrop?: (dropped: QueuedUpdate) => void;
  private config: QueueConfig & ProtocolConfig;
  droppedCount = 0;

  constructor(
    store: CaptureStore,
    config: QueueConfig & ProtocolConfig,
    onFlush?: (messages: WsMessage[]) => void,
    onDrop?: (dropped: QueuedUpdate) => void,
  ) {
    this.store = store;
    this.config = config;
    this.onFlush = onFlush;
    this.onDrop = onDrop;
    this.flushIntervalMs = config.flushIntervalMs;
    this.flushBatch = config.flushBatch;
    this.queueMaxDepth = config.queueMaxDepth;
  }

  /** Queue a response metadata update for a capture. */
  queueUpdate(id: number, reqMeta: RequestMeta, res: ResponseMeta): void {
    this.queue.push({ id, reqMeta, res });
    const shouldFlush =
      this.queue.length >= this.flushBatch || this.queue.length >= this.queueMaxDepth;
    if (!shouldFlush && !this.flushTimer) {
      this.flushTimer = setTimeout(() => {
        this.flushTimer = null;
        void this.guardedFlush().catch((err) => {
          logger.error("WriteQueue flush failed", {
            error: err instanceof Error ? err.message : String(err),
          });
        });
      }, this.flushIntervalMs);
      return;
    }
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    void this.guardedFlush().catch((err) => {
      logger.error("WriteQueue flush failed", {
        error: err instanceof Error ? err.message : String(err),
      });
    });
    if (this.queue.length >= this.queueMaxDepth) {
      const dropped = this.queue.shift();
      if (dropped) {
        this.droppedCount++;
        this.onDrop?.(dropped);
        logger.warn("WriteQueue overflow: dropped oldest entry", {
          captureId: dropped.id,
          depth: this.queue.length,
          maxDepth: this.queueMaxDepth,
          totalDropped: this.droppedCount,
        });
      }
    }
  }

  private guardedFlush(): Promise<void> {
    if (this.flushing) {
      return this.flushing.then(() => {
        if (this.queue.length > 0 && !this.flushing) {
          return this.guardedFlush();
        }
      });
    }
    this.flushing = this.flushNow().finally(() => {
      this.flushing = null;
    });
    return this.flushing;
  }

  get length(): number {
    return this.queue.length;
  }

  get hasTimer(): boolean {
    return this.flushTimer !== null;
  }

  /** Drain all remaining queue entries, marking each as dropped via the
   *  `onDrop` callback. Used during shutdown when flushNow has exhausted its
   *  retries and the store is about to close. Clears any pending flush/retry
   *  timers first so they cannot fire after drain. */
  drainForShutdown(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    while (this.queue.length > 0) {
      const dropped = this.queue.shift();
      if (dropped) {
        this.droppedCount++;
        this.onDrop?.(dropped);
        logger.warn("WriteQueue drained on shutdown", {
          captureId: dropped.id,
          remaining: this.queue.length,
        });
      }
    }
  }

  /** Flush all queued updates to the database immediately.
   *  On batchUpdate failure, re-queues the batch at the front and schedules a
   *  retry timer with exponential backoff (1s → 30s). After MAX_FLUSH_RETRIES
   *  consecutive failures, the batch is dropped (logged) to prevent an
   *  indefinite stall. A successful flush clears the retry timer and resets
   *  the retry count. */
  async flushNow(): Promise<void> {
    this.flushTimer = null;
    if (this.queue.length === 0) return;
    const batch = this.queue.splice(0, this.queue.length);
    try {
      await this.store.batchUpdate(batch.map((it) => ({ id: it.id, res: it.res })));
    } catch (err) {
      this.queue.unshift(...batch);
      this.flushRetryCount += 1;
      if (this.flushRetryCount >= WriteQueue.MAX_FLUSH_RETRIES) {
        logger.warn("WriteQueue flush retries exhausted, dropping batch", {
          batchSize: batch.length,
          retries: this.flushRetryCount,
          error: err instanceof Error ? err.message : String(err),
        });
        this.flushRetryCount = 0;
        if (this.retryTimer) {
          clearTimeout(this.retryTimer);
          this.retryTimer = null;
        }
        this.queue.splice(0, this.queue.length);
      } else {
        const delay = Math.min(
          WriteQueue.RETRY_BASE_MS * 2 ** (this.flushRetryCount - 1),
          WriteQueue.RETRY_MAX_MS,
        );
        logger.error("WriteQueue flush failed, re-queued batch", {
          batchSize: batch.length,
          depth: this.queue.length,
          retryCount: this.flushRetryCount,
          retryInMs: delay,
          error: err instanceof Error ? err.message : String(err),
        });
        if (this.retryTimer) clearTimeout(this.retryTimer);
        this.retryTimer = setTimeout(() => {
          this.retryTimer = null;
          void this.guardedFlush().catch((retryErr) => {
            logger.error("WriteQueue retry flush failed", {
              error: retryErr instanceof Error ? retryErr.message : String(retryErr),
            });
          });
        }, delay);
        this.retryTimer.unref?.();
      }
      return;
    }
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    this.flushRetryCount = 0;
    if (this.onFlush) {
      const messages: WsMessage[] = batch.map((it) => {
        const p50 = this.store.getUpstreamP50?.(it.id) ?? null;
        return {
          type: "update" as const,
          capture: buildSummary(it.id, it.reqMeta, it.res, this.config, p50),
        };
      });
      this.onFlush(messages);
    }
  }
}
