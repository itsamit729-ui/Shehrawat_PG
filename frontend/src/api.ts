export const DEMO = import.meta.env.VITE_DEMO_MODE === "true";
const BASE = (import.meta.env.VITE_API_BASE_URL || "").replace(/\/$/, "");
let csrf = "";
export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
  }
}
export async function request<T>(
  path: string,
  options: {
    method?: string;
    body?: unknown;
    key?: string;
    signal?: AbortSignal;
  } = {},
): Promise<T> {
  if (!BASE)
    throw new ApiError(
      "The service is not connected yet. Please try again later.",
      503,
    );
  const headers: Record<string, string> = { Accept: "application/json" };
  if (options.body !== undefined) headers["Content-Type"] = "application/json";
  if (csrf) headers["X-CSRF-Token"] = csrf;
  if (options.key) headers["Idempotency-Key"] = options.key;
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (options.signal?.aborted) controller.abort();
  options.signal?.addEventListener("abort", abort, { once: true });
  const timeout = setTimeout(() => controller.abort(), 15000);
  try {
    const r = await fetch(BASE + path, {
      method: options.method || "GET",
      headers,
      credentials: "include",
      body:
        options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: controller.signal,
    });
    const data = r.status === 204 ? null : await r.json().catch(() => null);
    if (!r.ok)
      throw new ApiError(
        data?.message || "Unable to complete this request. Please try again.",
        r.status,
      );
    if (data?.csrfToken) csrf = data.csrfToken;
    return data as T;
  } catch (e) {
    if (e instanceof ApiError) throw e;
    throw new ApiError(
      "Connection interrupted. Check your connection and try again.",
      0,
    );
  } finally {
    clearTimeout(timeout);
    options.signal?.removeEventListener("abort", abort);
  }
}
export function resetCsrf() {
  csrf = "";
}
