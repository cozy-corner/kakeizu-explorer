import { afterEach, expect, test } from "bun:test";
import { ApiError, fetchJson, isUnavailable } from "./apiFetch";

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

function stubFetch(impl: () => Promise<Response>) {
  globalThis.fetch = impl as unknown as typeof fetch;
}

test("isUnavailable is true only for a 503 ApiError", () => {
  expect(isUnavailable(new ApiError(503, "down"))).toBe(true);
  expect(isUnavailable(new ApiError(500, "boom"))).toBe(false);
  expect(isUnavailable(new ApiError(404, "missing"))).toBe(false);
  expect(isUnavailable(new Error("Failed to fetch"))).toBe(false);
  expect(isUnavailable(null)).toBe(false);
});

test("fetchJson returns the parsed body on success", async () => {
  stubFetch(async () => Response.json({ nodes: [] }));
  expect(await fetchJson<{ nodes: unknown[] }>("/api/x", "失敗")).toEqual({
    nodes: [],
  });
});

test("fetchJson throws an ApiError carrying the status", async () => {
  stubFetch(async () => Response.json({ status: "error" }, { status: 503 }));
  const err = await fetchJson("/api/x", "取得に失敗しました").catch(
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(ApiError);
  expect((err as ApiError).status).toBe(503);
  expect((err as ApiError).message).toBe("取得に失敗しました (503)");
});

test("fetchJson replaces a transport failure's message with the context", async () => {
  stubFetch(() => Promise.reject(new TypeError("Failed to fetch")));
  const err = await fetchJson("/api/x", "取得に失敗しました").catch(
    (e: unknown) => e,
  );
  expect((err as Error).message).toBe("取得に失敗しました");
});

// Callers distinguish an abort from a real failure by its name, so it has to
// pass through the transport-failure rewrite untouched.
test("fetchJson rethrows an abort unchanged", async () => {
  stubFetch(() => Promise.reject(new DOMException("aborted", "AbortError")));
  const err = await fetchJson("/api/x", "取得に失敗しました").catch(
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(DOMException);
  expect((err as DOMException).name).toBe("AbortError");
});
