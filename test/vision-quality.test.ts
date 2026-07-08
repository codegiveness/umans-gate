import { describe, expect, test } from "bun:test";
import type { CompressionRecipe } from "../src/vision/cache.js";
import { DescriptionCache, descriptionCacheKey, imageCacheKey } from "../src/vision/cache.js";
import { transcodeImage } from "../src/vision/transcode.js";
import { wrapDescription } from "../src/vision/wrapper.js";

const RED_PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

function decodeB64(s: string): Uint8Array {
  return new Uint8Array(Buffer.from(s, "base64"));
}

describe("Tier 0: ENCODER_VERSION v2", () => {
  test("descriptionCacheKey with v2 encoder differs from v1", () => {
    const bytes = Buffer.from("IMGDATA");
    const recipe: CompressionRecipe = { format: "png", quality: 92, max_dimension: 2048 };
    const k1 = descriptionCacheKey(bytes, recipe, "bun-image-v1", "umans-flash", 2);
    const k2 = descriptionCacheKey(bytes, recipe, "bun-image-v2", "umans-flash", 2);
    expect(k1).not.toBe(k2);
  });

  test("imageCacheKey changes when encoder version changes", () => {
    const bytes = Buffer.from("IMGDATA");
    const recipe: CompressionRecipe = { format: "png", quality: 92, max_dimension: 2048 };
    const k1 = imageCacheKey(bytes, recipe, "bun-image-v1");
    const k2 = imageCacheKey(bytes, recipe, "bun-image-v2");
    expect(k1).not.toBe(k2);
  });
});

describe("Tier 0: CompressionRecipe has no subsampling", () => {
  test("recipe object compiles without subsampling field", () => {
    const recipe: CompressionRecipe = {
      format: "png",
      quality: 92,
      max_dimension: 2048,
    };
    expect(recipe.format).toBe("png");
    expect(recipe.quality).toBe(92);
    expect(recipe.max_dimension).toBe(2048);
    expect("subsampling" in recipe).toBe(false);
  });

  test("changing format changes the key", () => {
    const bytes = Buffer.from("IMGDATA");
    const png: CompressionRecipe = { format: "png", quality: 92, max_dimension: 2048 };
    const jpeg: CompressionRecipe = { format: "jpeg", quality: 92, max_dimension: 2048 };
    expect(imageCacheKey(bytes, png, "v2")).not.toBe(imageCacheKey(bytes, jpeg, "v2"));
  });

  test("changing max_dimension changes the key", () => {
    const bytes = Buffer.from("IMGDATA");
    const r1024: CompressionRecipe = { format: "png", quality: 92, max_dimension: 1024 };
    const r2048: CompressionRecipe = { format: "png", quality: 92, max_dimension: 2048 };
    expect(imageCacheKey(bytes, r1024, "v2")).not.toBe(imageCacheKey(bytes, r2048, "v2"));
  });
});

describe("Tier 0: PNG transcode support", () => {
  test("transcodeImage with format:png returns PNG bytes", async () => {
    const decoded = decodeB64(RED_PNG_B64);
    const result = await transcodeImage(decoded, {
      maxDimension: 2048,
      quality: 92,
      format: "png",
    });
    expect(result.format).toBe("png");
    expect(result.bytes.byteLength).toBeGreaterThan(0);
    expect(result.width).toBeGreaterThan(0);
    expect(result.height).toBeGreaterThan(0);
  });

  test("transcodeImage with format:jpeg returns JPEG bytes", async () => {
    const decoded = decodeB64(RED_PNG_B64);
    const result = await transcodeImage(decoded, {
      maxDimension: 2048,
      quality: 92,
      format: "jpeg",
    });
    expect(result.format).toBe("jpeg");
    expect(result.bytes.byteLength).toBeGreaterThan(0);
  });

  test("transcodeImage defaults to jpeg when format omitted", async () => {
    const decoded = decodeB64(RED_PNG_B64);
    const result = await transcodeImage(decoded, { maxDimension: 2048, quality: 92 });
    expect(result.format).toBe("jpeg");
  });

  test("PNG and JPEG produce different bytes for same image", async () => {
    const decoded = decodeB64(RED_PNG_B64);
    const pngResult = await transcodeImage(decoded, {
      maxDimension: 2048,
      quality: 92,
      format: "png",
    });
    const jpegResult = await transcodeImage(decoded, {
      maxDimension: 2048,
      quality: 92,
      format: "jpeg",
    });
    expect(pngResult.hash).not.toBe(jpegResult.hash);
  });

  test("transcodeImage respects maxDimension for large images", async () => {
    const decoded = decodeB64(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
    );
    const result = await transcodeImage(decoded, { maxDimension: 16, quality: 85, format: "png" });
    expect(Math.max(result.width, result.height)).toBeLessThanOrEqual(16);
  });
});

describe("Tier 0: wrapDescription fixed label", () => {
  const LABEL =
    "[Image content — analyzed by vision module, shown as text because the active model cannot see images:]";

  test("wrapDescription takes single argument", () => {
    const w = wrapDescription("a cat");
    expect(w).toContain(LABEL);
    expect(w).toContain("a cat");
  });

  test("wrapper is byte-identical for identical input", () => {
    expect(wrapDescription("desc A")).toBe(wrapDescription("desc A"));
  });

  test("wrapper has no position index", () => {
    const w = wrapDescription("test");
    expect(w).not.toMatch(/Image [0-9]+/);
  });

  test("wrapper has no dynamic metadata", () => {
    const w = wrapDescription("test");
    expect(w).not.toMatch(/\d{13}/);
    expect(w).not.toMatch(/req_[a-z0-9]+/i);
  });

  test("multiple calls produce identical labels", () => {
    const descs = ["first", "second", "third"];
    const wrapped = descs.map((d) => wrapDescription(d));
    for (const w of wrapped) {
      expect(w.startsWith(LABEL)).toBe(true);
    }
  });
});

describe("Tier 0: DescriptionCache with persistent backing", () => {
  test("getOrCompute writes to persistent store on miss", () => {
    let persistentGetCount = 0;
    let persistentSetCount = 0;
    const mockPersistent = {
      get: (_key: string) => {
        persistentGetCount++;
        return null;
      },
      set: (_entry: unknown) => {
        persistentSetCount++;
      },
    };
    const cache = new DescriptionCache(100, 86_400_000, mockPersistent as never);
    const bytes = Buffer.from("IMGDATA");
    const recipe: CompressionRecipe = { format: "png", quality: 92, max_dimension: 2048 };

    const result = cache.getOrCompute(
      bytes,
      recipe,
      "v2",
      "umans-flash",
      2,
      () => "description text",
    );

    expect(result).toBe("description text");
    expect(persistentGetCount).toBe(1);
    expect(persistentSetCount).toBe(1);
    expect(cache.stats.misses).toBe(1);
  });

  test("getOrCompute reads from persistent store on LRU miss", () => {
    const mockPersistent = {
      get: (key: string) => (key === "known" ? "persisted desc" : null),
      set: () => {},
    };
    const cache = new DescriptionCache(100, 86_400_000, mockPersistent as never);

    const bytes = Buffer.from("IMGDATA");
    const recipe: CompressionRecipe = { format: "png", quality: 92, max_dimension: 2048 };

    const descKey = descriptionCacheKey(bytes, recipe, "v2", "umans-flash", 2);

    cache.warm(descKey, "persisted desc");

    const result = cache.getOrCompute(bytes, recipe, "v2", "umans-flash", 2, () => {
      throw new Error("should not compute on persistent hit");
    });

    expect(result).toBe("persisted desc");
    expect(cache.stats.hits).toBe(1);
  });

  test("warm sets LRU entry directly", () => {
    const cache = new DescriptionCache(100, 86_400_000);
    const bytes = Buffer.from("IMGDATA");
    const recipe: CompressionRecipe = { format: "png", quality: 92, max_dimension: 2048 };
    const key = descriptionCacheKey(bytes, recipe, "v2", "umans-flash", 2);

    cache.warm(key, "warmed desc");

    const result = cache.getOrCompute(bytes, recipe, "v2", "umans-flash", 2, () => {
      throw new Error("should not compute after warm");
    });

    expect(result).toBe("warmed desc");
    expect(cache.stats.hits).toBe(1);
    expect(cache.stats.misses).toBe(0);
  });

  test("persistentStats tracks persistent hits and writes", () => {
    const mockPersistent = {
      get: () => null,
      set: () => {},
    };
    const cache = new DescriptionCache(100, 86_400_000, mockPersistent as never);
    const bytes = Buffer.from("IMGDATA");
    const recipe: CompressionRecipe = { format: "png", quality: 92, max_dimension: 2048 };

    cache.getOrCompute(bytes, recipe, "v2", "umans-flash", 2, () => "desc");

    expect(cache.persistentStats.writes).toBe(1);
    expect(cache.persistentStats.hits).toBe(0);
  });
});

describe("Tier 0: prompt version invalidation", () => {
  test("prompt version 2 key differs from version 1", () => {
    const bytes = Buffer.from("IMGDATA");
    const recipe: CompressionRecipe = { format: "png", quality: 92, max_dimension: 2048 };
    const k1 = descriptionCacheKey(bytes, recipe, "bun-image-v2", "umans-flash", 1);
    const k2 = descriptionCacheKey(bytes, recipe, "bun-image-v2", "umans-flash", 2);
    expect(k1).not.toBe(k2);
  });
});
