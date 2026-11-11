import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
// Imported before any env is set: configuration must be read at call time.
import { getOpenRouterEmbedding, getOpenRouterEmbeddingBatch } from "./openrouter.js";

const ENV_KEYS = ["OPENROUTER_API_KEY", "EMBEDDING_MODEL", "EMBEDDING_DIMS", "EMBEDDING_BATCH_SIZE"] as const;
const savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));

const fetchMock = vi.fn();

function vec(dims: number, fill: number): number[] {
  return new Array(dims).fill(fill);
}

function okResponse(data: Array<{ embedding: number[]; index?: number }>): Response {
  return new Response(JSON.stringify({ data }), { status: 200 });
}

function errorResponse(status: number, headers: Record<string, string> = {}): Response {
  return new Response("error body", { status, headers });
}

function requestBody(call: number): Record<string, unknown> {
  return JSON.parse(fetchMock.mock.calls[call][1].body as string);
}

describe("openrouter embeddings", () => {
  beforeEach(() => {
    for (const k of ENV_KEYS) delete process.env[k];
    process.env.OPENROUTER_API_KEY = "sk-or-test";
    process.env.EMBEDDING_DIMS = "3";
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    for (const k of ENV_KEYS) {
      if (savedEnv[k] === undefined) delete process.env[k];
      else process.env[k] = savedEnv[k];
    }
  });

  it("reads key, model and dimensions from env at call time", async () => {
    process.env.OPENROUTER_API_KEY = "sk-or-late";
    process.env.EMBEDDING_MODEL = "custom/model";
    fetchMock.mockResolvedValueOnce(okResponse([{ embedding: vec(3, 1), index: 0 }]));

    await getOpenRouterEmbedding("hello");

    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe("Bearer sk-or-late");
    expect(requestBody(0)).toMatchObject({ model: "custom/model", input: ["hello"], dimensions: 3 });
  });

  it("omits dimensions unless EMBEDDING_DIMS is set, expecting the default size", async () => {
    delete process.env.EMBEDDING_DIMS;
    fetchMock.mockResolvedValueOnce(okResponse([{ embedding: vec(4096, 1), index: 0 }]));

    await expect(getOpenRouterEmbedding("hello")).resolves.toHaveLength(4096);
    expect(requestBody(0)).not.toHaveProperty("dimensions");
  });

  it("throws when the API key is missing", async () => {
    delete process.env.OPENROUTER_API_KEY;
    await expect(getOpenRouterEmbedding("hello")).rejects.toThrow("OPENROUTER_API_KEY");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("places batch results by response index, not response order", async () => {
    fetchMock.mockResolvedValueOnce(
      okResponse([
        { embedding: vec(3, 2), index: 2 },
        { embedding: vec(3, 0), index: 0 },
        { embedding: vec(3, 1), index: 1 },
      ])
    );

    const result = await getOpenRouterEmbeddingBatch(["a", "b", "c"]);

    expect(result.map((v) => v[0])).toEqual([0, 1, 2]);
  });

  it("splits input larger than EMBEDDING_BATCH_SIZE into sequential requests", async () => {
    process.env.EMBEDDING_BATCH_SIZE = "2";
    fetchMock
      .mockResolvedValueOnce(okResponse([{ embedding: vec(3, 0), index: 0 }, { embedding: vec(3, 1), index: 1 }]))
      .mockResolvedValueOnce(okResponse([{ embedding: vec(3, 2), index: 0 }]));

    const result = await getOpenRouterEmbeddingBatch(["a", "b", "c"]);

    expect(requestBody(0).input).toEqual(["a", "b"]);
    expect(requestBody(1).input).toEqual(["c"]);
    expect(result.map((v) => v[0])).toEqual([0, 1, 2]);
  });

  it("throws without retrying on a dimension mismatch", async () => {
    fetchMock.mockResolvedValue(okResponse([{ embedding: vec(5, 1), index: 0 }]));

    await expect(getOpenRouterEmbedding("hello")).rejects.toThrow(/dimension mismatch.*5.*expected 3/i);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not retry 402 (out of credits)", async () => {
    fetchMock.mockResolvedValue(errorResponse(402));

    await expect(getOpenRouterEmbedding("hello")).rejects.toThrow("402");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("waits for Retry-After on 429 before retrying", async () => {
    vi.useFakeTimers();
    fetchMock
      .mockResolvedValueOnce(errorResponse(429, { "Retry-After": "5" }))
      .mockResolvedValueOnce(okResponse([{ embedding: vec(3, 1), index: 0 }]));

    const pending = getOpenRouterEmbedding("hello");
    await vi.advanceTimersByTimeAsync(4999);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);

    await expect(pending).resolves.toHaveLength(3);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("reports rate limiting after 429 exhaustion without sleeping after the last attempt", async () => {
    vi.useFakeTimers();
    fetchMock.mockImplementation(async () => errorResponse(429));

    let error: Error | undefined;
    getOpenRouterEmbedding("hello").catch((e: Error) => {
      error = e;
    });
    // Backoff before attempts 2 and 3 only: 2000ms + 4000ms
    await vi.advanceTimersByTimeAsync(6000);

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(error?.message).toMatch(/after 3 attempts: Rate limited by OpenRouter \(429\)/);
  });
});
