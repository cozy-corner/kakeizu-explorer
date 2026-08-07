export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

// The API deliberately keeps the 503 body generic, so the status is the only
// thing the client can key on to tell "DB is down" from any other failure.
export function isUnavailable(err: unknown): boolean {
  return err instanceof ApiError && err.status === 503;
}

export async function fetchJson<T>(
  url: string,
  context: string,
  init?: RequestInit,
): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, init);
  } catch (err) {
    // A transport failure rejects with `TypeError: Failed to fetch`, whose
    // message would otherwise reach the Japanese UI verbatim.
    if (err instanceof DOMException && err.name === "AbortError") throw err;
    throw new Error(context);
  }
  if (!res.ok) throw new ApiError(res.status, `${context} (${res.status})`);
  return (await res.json()) as T;
}

export function toError(err: unknown, fallback: string): Error {
  return err instanceof Error ? err : new Error(fallback);
}
