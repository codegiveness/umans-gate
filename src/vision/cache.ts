// Description LRU cache + SHA-256 key generation for vision handoff.
// In-memory only; entries are lost on restart. Backed by lru-cache v11.

import { LRUCache } from "lru-cache";
import type { PersistentDescriptionStore } from "./persistent-cache.js";

export interface CompressionRecipe {
  format: string;
  quality: number;
  max_dimension: number;
}

/**
 * Stable image-hash key over (original_bytes || canonical_settings || encoder_version).
 * Uses Bun's built-in CryptoHasher — faster than node:crypto.
 */
export function imageCacheKey(
  bytes: Buffer | Uint8Array,
  recipe: CompressionRecipe,
  encoderVersion: string,
): string {
  const h = new Bun.CryptoHasher("sha256");
  h.update(bytes);
  h.update(JSON.stringify(recipe));
  h.update(encoderVersion);
  return h.digest("hex");
}

/**
 * Description-cache key over (image_hash, prompt_version, model_id).
 * Description text is a VALUE, not part of the KEY.
 */
export function descriptionCacheKey(
  bytes: Buffer | Uint8Array,
  recipe: CompressionRecipe,
  encoderVersion: string,
  modelId: string,
  promptVersion: number,
  contextHash?: string,
): string {
  const base = imageCacheKey(bytes, recipe, encoderVersion);
  const h = new Bun.CryptoHasher("sha256");
  h.update(base);
  h.update(`|pv=${promptVersion}|model=${modelId}`);
  if (contextHash) {
    h.update(`|ctx=${contextHash}`);
  }
  return h.digest("hex");
}

/** Stats surfaced by {@link DescriptionCache}. */
export interface DescriptionCacheStats {
  hits: number;
  misses: number;
  evictions: number;
  size: number;
}

/**
 * Synchronous LRU description cache. Lets the VisionHandoff orchestrator
 * check for a hit before issuing an async vision-model call.
 *
 * `getOrCompute` is intentionally SYNCHRONOUS: JS event loop is single
 * threaded, so no locking is needed; the orchestrator performs async work
 * OUTSIDE the cache and stores the result via a second call on hit-less
 * paths (or by supplying a `compute` that has already resolved).
 */
export class DescriptionCache {
  private readonly cache: LRUCache<string, string>;
  private readonly persistent: PersistentDescriptionStore | null;
  private hits = 0;
  private misses = 0;
  private evictions = 0;
  private persistentHits = 0;
  private persistentWrites = 0;

  constructor(maxSize: number, ttlMs: number, persistent?: PersistentDescriptionStore | null) {
    this.persistent = persistent ?? null;
    this.cache = new LRUCache<string, string>({
      max: maxSize,
      ttl: ttlMs,
      dispose: (_value, _key, reason) => {
        if (reason === "evict" || reason === "expire") this.evictions++;
      },
    });
  }

  get size(): number {
    return this.cache.size;
  }

  get stats(): DescriptionCacheStats {
    return {
      hits: this.hits,
      misses: this.misses,
      evictions: this.evictions,
      size: this.cache.size,
    };
  }

  get persistentStats(): { hits: number; writes: number } {
    return { hits: this.persistentHits, writes: this.persistentWrites };
  }

  warm(key: string, description: string): void {
    this.cache.set(key, description);
  }

  getOrCompute(
    bytes: Buffer | Uint8Array,
    recipe: CompressionRecipe,
    encoderVersion: string,
    modelId: string,
    promptVersion: number,
    compute: () => string,
    isCacheable?: (value: string) => boolean,
    contextHash?: string,
  ): string {
    const key = descriptionCacheKey(
      bytes,
      recipe,
      encoderVersion,
      modelId,
      promptVersion,
      contextHash,
    );
    if (this.cache.has(key)) {
      const v = this.cache.get(key);
      if (v !== undefined) {
        this.hits++;
        return v;
      }
    }

    if (this.persistent) {
      const persisted = this.persistent.get(key);
      if (persisted !== null) {
        this.persistentHits++;
        this.cache.set(key, persisted);
        this.hits++;
        return persisted;
      }
    }

    // Image-only tier fallback (only when a contextHash is present — the
    // context-keyed entry is a strict superset of the image-only entry).
    // On hit, promote the value into the context tier so subsequent lookups
    // with the same context are direct hits.
    if (contextHash) {
      const imageOnly = this.getImageOnly(bytes, recipe, encoderVersion, modelId, promptVersion);
      if (imageOnly !== null) {
        this.cache.set(key, imageOnly);
        this.hits++;
        return imageOnly;
      }
    }

    const value = compute();
    this.misses++;

    const cacheable = !isCacheable || isCacheable(value);
    if (cacheable) {
      if (contextHash) {
        this.storeDual(bytes, recipe, encoderVersion, modelId, promptVersion, contextHash, value);
      } else {
        this.cache.set(key, value);
        if (this.persistent) {
          const imageHash = imageCacheKey(bytes, recipe, encoderVersion);
          this.persistent.set({
            key,
            description: value,
            imageHash,
            model: modelId,
            promptVersion,
          });
          this.persistentWrites++;
        }
      }
    }
    return value;
  }

  /**
   * Look up the image-only tier (no contextHash). Checks the in-memory LRU
   * first, then the persistent store. Returns null on miss. Synchronous.
   */
  getImageOnly(
    bytes: Buffer | Uint8Array,
    recipe: CompressionRecipe,
    encoderVersion: string,
    modelId: string,
    promptVersion: number,
  ): string | null {
    const key = descriptionCacheKey(bytes, recipe, encoderVersion, modelId, promptVersion);
    const cached = this.cache.get(key);
    if (cached !== undefined) {
      return cached;
    }
    if (this.persistent) {
      const persisted = this.persistent.get(key);
      if (persisted !== null) {
        this.cache.set(key, persisted);
        return persisted;
      }
    }
    return null;
  }

  /**
   * Write the description to BOTH the context-keyed tier and the image-only
   * tier (in-memory + persistent). Does NOT check `isCacheable` — the caller
   * is responsible for that gate. Synchronous.
   */
  storeDual(
    bytes: Buffer | Uint8Array,
    recipe: CompressionRecipe,
    encoderVersion: string,
    modelId: string,
    promptVersion: number,
    contextHash: string,
    description: string,
  ): void {
    const ctxKey = descriptionCacheKey(
      bytes,
      recipe,
      encoderVersion,
      modelId,
      promptVersion,
      contextHash,
    );
    const imgKey = descriptionCacheKey(bytes, recipe, encoderVersion, modelId, promptVersion);
    const imageHash = imageCacheKey(bytes, recipe, encoderVersion);
    this.cache.set(ctxKey, description);
    this.cache.set(imgKey, description);
    if (this.persistent) {
      this.persistent.set({
        key: ctxKey,
        description,
        imageHash,
        model: modelId,
        promptVersion,
      });
      this.persistent.set({
        key: imgKey,
        description,
        imageHash,
        model: modelId,
        promptVersion,
      });
      this.persistentWrites += 2;
    }
  }
}
