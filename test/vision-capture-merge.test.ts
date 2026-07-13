// Integration test: vision calls land in the captures table with is_vision=1.
// Spawns the real proxy + mock upstreams and verifies that after a vision
// handoff, the captures endpoint returns a row with is_vision=true.

import { describe, expect, test } from "bun:test";
import { startMockLlmUpstream } from "./helpers/mock-llm-upstream";
import { startProxy } from "./helpers/proxy";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const RED_PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

describe("vision capture merge", () => {
  test("vision call appears in /dashboard/api/captures with is_vision=true", async () => {
    const upstream = await startMockLlmUpstream();
    const visionServer = Bun.serve({
      port: 0,
      async fetch() {
        return Response.json({
          id: "chatcmpl-vision-mock",
          object: "chat.completion",
          created: Math.floor(Date.now() / 1000),
          model: "gpt-4o",
          choices: [
            {
              index: 0,
              message: { role: "assistant", content: "A red pixel." },
              finish_reason: "stop",
            },
          ],
          usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
        });
      },
    });

    const proxy = await startProxy({
      TARGET: `http://127.0.0.1:${upstream.port}`,
      envOverrides: {
        STAMP_CACHE_TTL_ENABLED: "false",
        WARMER_ENABLED: "false",
        VISION_STRATEGY: "always",
        VISION_TARGET: `http://127.0.0.1:${visionServer.port}/v1/chat/completions`,
        VISION_MODEL: "gpt-4o",
        UMANS_API_KEY: "test-key",
      },
    });

    try {
      await sleep(100);
      upstream.reset();

      const sentBody = {
        model: "umans-glm-5.2",
        max_tokens: 50,
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "What is in this image?" },
              {
                type: "image_url",
                image_url: { url: `data:image/png;base64,${RED_PNG_B64}` },
              },
            ],
          },
        ],
      };
      const res = await fetch(`${proxy.baseUrl}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(sentBody),
      });
      expect(res.status).toBe(200);
      await res.text();
      await sleep(300);

      const capsRes = await fetch(`${proxy.baseUrl}/dashboard/api/captures?limit=100`);
      expect(capsRes.status).toBe(200);
      const caps = (await capsRes.json()) as Array<{
        is_vision: boolean;
        model: string | null;
        state: string;
        incoming_protocol: string;
        upstream_protocol: string;
      }>;
      const visionCaps = caps.filter((c) => c.is_vision);
      expect(visionCaps.length).toBeGreaterThanOrEqual(1);
      const vc = visionCaps[0];
      expect(vc.model).toBe("gpt-4o");
      expect(vc.state).toBe("done");
      expect(vc.incoming_protocol).toBe("http1.1");
      expect(vc.upstream_protocol).toBe("http1.1");
    } finally {
      await proxy.kill();
      await upstream.close();
      visionServer.stop(true);
      await sleep(150);
    }
  });

  test("/dashboard/api/vision-calls returns VisionCallRecord[] with full fields", async () => {
    const upstream = await startMockLlmUpstream();
    const visionServer = Bun.serve({
      port: 0,
      async fetch() {
        return Response.json({
          id: "chatcmpl-vision-mock",
          object: "chat.completion",
          created: Math.floor(Date.now() / 1000),
          model: "gpt-4o",
          choices: [
            {
              index: 0,
              message: { role: "assistant", content: "A red pixel." },
              finish_reason: "stop",
            },
          ],
          usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
        });
      },
    });

    const proxy = await startProxy({
      TARGET: `http://127.0.0.1:${upstream.port}`,
      envOverrides: {
        STAMP_CACHE_TTL_ENABLED: "false",
        WARMER_ENABLED: "false",
        VISION_STRATEGY: "always",
        VISION_TARGET: `http://127.0.0.1:${visionServer.port}/v1/chat/completions`,
        VISION_MODEL: "gpt-4o",
        UMANS_API_KEY: "test-key",
      },
    });

    try {
      await sleep(100);
      upstream.reset();

      const sentBody = {
        model: "umans-glm-5.2",
        max_tokens: 50,
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "What is in this image?" },
              {
                type: "image_url",
                image_url: { url: `data:image/png;base64,${RED_PNG_B64}` },
              },
            ],
          },
        ],
      };
      const res = await fetch(`${proxy.baseUrl}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(sentBody),
      });
      expect(res.status).toBe(200);
      await res.text();
      await sleep(300);

      const vcRes = await fetch(`${proxy.baseUrl}/dashboard/api/vision-calls?limit=100`);
      expect(vcRes.status).toBe(200);
      const records = (await vcRes.json()) as Array<{
        id: number;
        timestamp: number;
        captureId: number | null;
        model: string;
        target: string;
        imageSize: number;
        imageHash: string | null;
        status: string;
        httpStatus: number | null;
        latencyMs: number;
        description: string;
        error: string | null;
        incomingProtocol: string;
        upstreamProtocol: string;
        state: string;
      }>;
      expect(records.length).toBeGreaterThanOrEqual(1);

      const r = records[0];
      expect(typeof r.id).toBe("number");
      expect(typeof r.timestamp).toBe("number");
      expect(r.model).toBe("gpt-4o");
      expect(typeof r.target).toBe("string");
      expect(typeof r.imageSize).toBe("number");
      expect(r.status).toBe("ok");
      expect(r.httpStatus).toBe(200);
      expect(typeof r.latencyMs).toBe("number");
      expect(r.description).toBe("A red pixel.");
      expect(r.error).toBeNull();
      expect(r.state).toBe("done");
      expect(r.incomingProtocol).toBe("http1.1");
      expect(r.upstreamProtocol).toBe("http1.1");
    } finally {
      await proxy.kill();
      await upstream.close();
      visionServer.stop(true);
      await sleep(150);
    }
  });
});
