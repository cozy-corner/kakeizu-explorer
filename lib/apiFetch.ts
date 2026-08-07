export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

// Every route funnels an unreachable Neo4j into a 503 (`serviceUnavailable` in
// lib/api.ts), so the status alone tells the client the DB is down — the body
// stays generic on purpose.
export function isUnavailable(err: unknown): boolean {
  return err instanceof ApiError && err.status === 503;
}

export async function fetchJson<T>(
  url: string,
  context: string,
  init?: RequestInit,
): Promise<T> {
  const res = await fetch(url, init);
  if (!res.ok) throw new ApiError(res.status, `${context} (${res.status})`);
  return (await res.json()) as T;
}

export function toError(err: unknown, fallback: string): Error {
  return err instanceof Error ? err : new Error(fallback);
}
