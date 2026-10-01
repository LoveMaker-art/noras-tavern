import { NoraRequestError } from "./errors.js";

export interface RequestOptions { timeoutMs?: number; binary?: boolean; binaryKind?: "chat-backup"; }

/** One cookie session and single-flight CSRF handshake for Nora and ST adapters. */
export class NoraHttpClient {
  private csrfToken = "";
  private csrfFlight: Promise<string> | null = null;
  private cookies = new Map<string, string>();
  constructor(readonly baseUrl: string, readonly timeoutMs: number) {}
  get(path: string, options?: RequestOptions): Promise<unknown> { return this.send("GET", path, undefined, options); }
  post(path: string, body: unknown = {}, options?: RequestOptions): Promise<unknown> { return this.send("POST", path, body, options); }
  put(path: string, body: unknown = {}, options?: RequestOptions): Promise<unknown> { return this.send("PUT", path, body, options); }
  delete(path: string, body: unknown = {}, options?: RequestOptions): Promise<unknown> { return this.send("DELETE", path, body, options); }
  async download(path: string, body: unknown, binaryKind?: "chat-backup"): Promise<Buffer> {
    if (binaryKind && path !== "/api/backups/chat/snapshot") throw new NoraRequestError("Invalid backup download route.", "NORA_INVALID_ROUTE");
    return await this.send("POST", path, body, { binary: true, binaryKind }) as Buffer;
  }
  csrf(): Promise<string> {
    if (this.csrfToken) return Promise.resolve(this.csrfToken);
    if (!this.csrfFlight) {
      this.csrfFlight = this.send("GET", "/csrf-token").then(value => {
        if (!isRecord(value) || typeof value.token !== "string" || !value.token) throw new NoraRequestError("Server returned no CSRF token", "NORA_CSRF_UNAVAILABLE");
        this.csrfToken = value.token;
        return value.token;
      }).finally(() => { this.csrfFlight = null; });
    }
    return this.csrfFlight;
  }
  private async send(method: string, route: string, body?: unknown, options: RequestOptions = {}, retried = false): Promise<unknown> {
    if (!route.startsWith("/") || route.startsWith("//")) throw new NoraRequestError("Invalid relative route", "NORA_INVALID_ROUTE");
    const writes = method !== "GET";
    const token = writes ? await this.csrf() : "";
    const headers = new Headers({ Accept: "application/json" });
    if (this.cookies.size) headers.set("Cookie", [...this.cookies].map(([k,v]) => `${k}=${v}`).join("; "));
    if (token) headers.set("X-CSRF-Token", token);
    let payload: BodyInit | undefined;
    if (body instanceof FormData) payload = body;
    else if (body !== undefined) { headers.set("Content-Type", "application/json"); payload = JSON.stringify(body); }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? this.timeoutMs);
    try {
      const response = await fetch(this.baseUrl + route, { method, headers, body: payload, signal: controller.signal, redirect: "error" });
      for (const value of response.headers.getSetCookie()) {
        const pair = value.split(";", 1)[0]; const i = pair.indexOf("=");
        if (i > 0) this.cookies.set(pair.slice(0, i), pair.slice(i + 1));
      }
      if (options.binary && response.ok) {
        const backup = options.binaryKind === "chat-backup";
        const allowedTypes = backup ? ["application/octet-stream", "application/json", "application/x-ndjson", "application/jsonl"] : ["image/png", "application/json"];
        const contentType = (response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
        if (!allowedTypes.includes(contentType)) throw new NoraRequestError("Unexpected export response type.", "NORA_INVALID_RESPONSE");
        const maxBytes = (backup ? 256 : 64) * 1024 * 1024;
        const chunks: Uint8Array[] = []; let size = 0;
        const reader = response.body?.getReader();
        if (!reader) throw new NoraRequestError("Export has no body.", "NORA_INVALID_RESPONSE");
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            size += value.length;
            if (size > maxBytes) throw new NoraRequestError("Export exceeds its size limit.", "NORA_EXPORT_TOO_LARGE");
            chunks.push(value);
          }
        } finally { await reader.cancel(); }
        return Buffer.concat(chunks);
      }
      const text = await response.text();
      if (response.status === 403 && writes && !retried && text.includes("Invalid CSRF token")) {
        if (this.csrfToken === token) this.csrfToken = "";
        return this.send(method, route, body, options, true);
      }
      let value: unknown;
      try { value = text ? JSON.parse(text) : {}; } catch {
        throw new NoraRequestError(`Expected JSON from ${method} ${route}`, "NORA_INVALID_RESPONSE", response.status, writes && (response.ok || response.status >= 500) ? "unknown" : "rejected");
      }
      if (!response.ok || (isRecord(value) && (value.ok === false || Boolean(value.error)))) {
        const error = isRecord(value) && isRecord(value.error) ? value.error : value;
        const candidate = isRecord(error) ? typeof error.error === "string" ? error.error : error.code : undefined;
        const code = typeof candidate === "string" && /^[A-Z0-9_]{3,100}$/.test(candidate) ? candidate : "NORA_HTTP_FAILED";
        const details = isRecord(error) ? { operationId: error.operation_id, worldId: error.world_id } : {};
        throw new NoraRequestError(`${method} ${route} failed (HTTP ${response.status})`, code, response.status,
          writes && response.status >= 500 ? "unknown" : "rejected", details);
      }
      return value;
    } catch (error) {
      if (error instanceof NoraRequestError) throw error;
      throw new NoraRequestError(controller.signal.aborted ? "Request deadline exceeded; query the outcome before retrying." : "Transport failed; query the outcome before retrying.",
        controller.signal.aborted ? "NORA_REQUEST_TIMEOUT" : "NORA_TRANSPORT_FAILED", null, writes ? "unknown" : "rejected");
    } finally { clearTimeout(timeout); }
  }
}
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
