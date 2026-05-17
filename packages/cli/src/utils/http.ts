/**
 * KyberBot — Centralized outbound HTTP client.
 *
 * One canonical wrapper around fetch for future outbound integrations
 * (Gmail, Calendar, Ollama, webhooks, etc.). Existing third-party SDKs
 * (Anthropic, OpenAI, ChromaDB, grammy, Baileys) already encapsulate
 * their HTTP — don't route those through here.
 *
 * Combines:
 *   - retries with exponential backoff (delegated to fetchWithRetry)
 *   - per-request timeout via AbortSignal
 *   - structured logging (createLogger('http'))
 *   - optional X-Request-Id header so server logs can be correlated
 *
 * Designed to fail predictably: timeouts throw TimeoutError, network
 * errors propagate as Error, non-2xx responses are still returned as
 * Response objects so callers can decide how to handle them (consistent
 * with native fetch). 5xx responses are retried by fetchWithRetry.
 */

import { randomUUID } from 'node:crypto';
import { fetchWithRetry, type RetryOptions } from './retry.js';
import { createLogger } from '../logger.js';

const logger = createLogger('http');

const DEFAULT_TIMEOUT_MS = 30_000;

export interface HttpRequestOptions extends Omit<RequestInit, 'signal'> {
  /** Per-request timeout in milliseconds. Default: 30s. */
  timeoutMs?: number;
  /** Override the auto-generated X-Request-Id. */
  requestId?: string;
  /** Override retry behaviour. Default: 3 attempts, 1s base delay, 2x backoff. */
  retry?: RetryOptions;
  /** Tag for log lines so call sites are distinguishable. */
  tag?: string;
}

export class HttpTimeoutError extends Error {
  readonly url: string;
  readonly timeoutMs: number;
  constructor(url: string, timeoutMs: number) {
    super(`HTTP request to ${url} timed out after ${timeoutMs}ms`);
    this.name = 'HttpTimeoutError';
    this.url = url;
    this.timeoutMs = timeoutMs;
  }
}

/**
 * Make an outbound HTTP request. Returns the raw Response so the caller
 * decides how to parse the body. Use this for any new external API
 * integration — never call `fetch` directly from a new file.
 */
export async function httpRequest(
  url: string,
  options: HttpRequestOptions = {},
): Promise<Response> {
  const {
    timeoutMs = DEFAULT_TIMEOUT_MS,
    requestId = randomUUID(),
    retry,
    tag,
    headers,
    ...init
  } = options;

  const mergedHeaders = new Headers(headers);
  if (!mergedHeaders.has('X-Request-Id')) {
    mergedHeaders.set('X-Request-Id', requestId);
  }

  const start = Date.now();
  const method = (init.method ?? 'GET').toUpperCase();

  logger.debug('http request', { tag, method, url, requestId });

  try {
    const response = await fetchWithRetry(
      url,
      {
        ...init,
        headers: mergedHeaders,
        signal: AbortSignal.timeout(timeoutMs),
      },
      retry,
    );

    const elapsedMs = Date.now() - start;
    if (response.ok) {
      logger.debug('http response', { tag, method, url, status: response.status, elapsedMs, requestId });
    } else {
      logger.warn('http non-ok response', { tag, method, url, status: response.status, elapsedMs, requestId });
    }
    return response;
  } catch (err) {
    const elapsedMs = Date.now() - start;
    if (err instanceof Error && err.name === 'TimeoutError') {
      logger.warn('http timeout', { tag, method, url, timeoutMs, elapsedMs, requestId });
      throw new HttpTimeoutError(url, timeoutMs);
    }
    logger.warn('http error', { tag, method, url, elapsedMs, requestId, error: String(err) });
    throw err;
  }
}

/**
 * GET convenience wrapper. Returns parsed JSON on 2xx, throws on non-2xx.
 * Use httpRequest directly when you need finer control over the response.
 */
export async function httpGetJson<T = unknown>(
  url: string,
  options: HttpRequestOptions = {},
): Promise<T> {
  const res = await httpRequest(url, { ...options, method: 'GET' });
  if (!res.ok) {
    throw new Error(`GET ${url} failed: HTTP ${res.status} ${res.statusText}`);
  }
  return res.json() as Promise<T>;
}

/**
 * POST JSON convenience wrapper. Sets Content-Type, serializes body,
 * returns parsed JSON on 2xx, throws on non-2xx.
 */
export async function httpPostJson<T = unknown>(
  url: string,
  body: unknown,
  options: HttpRequestOptions = {},
): Promise<T> {
  const headers = new Headers(options.headers);
  if (!headers.has('Content-Type')) headers.set('Content-Type', 'application/json');

  const res = await httpRequest(url, {
    ...options,
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`POST ${url} failed: HTTP ${res.status} ${res.statusText}`);
  }
  return res.json() as Promise<T>;
}
