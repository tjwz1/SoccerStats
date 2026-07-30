import { useState, useEffect, useCallback } from "react";

async function fetchWithRetry(url: string, signal: AbortSignal, retries = 2, delayMs = 1500): Promise<Response> {
  for (let attempt = 0; attempt <= retries; attempt++) {
    const res = await fetch(url, { signal });
    if (res.ok || attempt === retries) return res;
    // Retry on 429 (rate limit) or 500 (transient server error)
    if (res.status === 429 || res.status === 500) {
      await new Promise<void>((resolve, reject) => {
        if (signal.aborted) { reject(new DOMException("Aborted", "AbortError")); return; }
        const t = setTimeout(resolve, delayMs * (attempt + 1));
        signal.addEventListener("abort", () => { clearTimeout(t); reject(new DOMException("Aborted", "AbortError")); }, { once: true });
      });
    } else {
      return res; // non-retryable error
    }
  }
  throw new Error("unreachable");
}

// In-memory cache keyed by URL; survives React re-renders within the same session.
// Default TTL is 5 minutes; immutable past-season data can use Infinity via clientTtlMs option.
const SESSION_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes default
const SESSION_CACHE_MAX = 300; // evict oldest when over this limit
const SESSION_CACHE = new Map<string, { data: unknown; at: number; ttl: number }>();

// In-flight deduplication: if two useApi calls request the same URL concurrently,
// the second attaches to the first's promise rather than making a duplicate HTTP request.
// Ref-counted so an in-flight request is aborted only when ALL its listeners have unmounted.
interface InflightEntry {
  promise: Promise<unknown>;
  controller: AbortController;
  refs: number;
}
const INFLIGHT = new Map<string, InflightEntry>();

export function sessionGet(url: string): unknown | undefined {
  const entry = SESSION_CACHE.get(url);
  if (!entry) return undefined;
  if (Date.now() - entry.at > entry.ttl) { SESSION_CACHE.delete(url); return undefined; }
  // Move to end so the Map's insertion-order eviction acts as LRU.
  SESSION_CACHE.delete(url);
  SESSION_CACHE.set(url, entry);
  return entry.data;
}

export function sessionSet(url: string, data: unknown, ttlMs = SESSION_CACHE_TTL_MS) {
  if (SESSION_CACHE.size >= SESSION_CACHE_MAX) {
    const firstKey = SESSION_CACHE.keys().next().value;
    if (firstKey !== undefined) SESSION_CACHE.delete(firstKey);
  }
  SESSION_CACHE.set(url, { data, at: Date.now(), ttl: ttlMs });
}

export function clearSessionCache() {
  SESSION_CACHE.clear();
}

// Release one listener's hold on an in-flight entry, aborting when the last one detaches.
function releaseInflight(targetUrl: string, entry: InflightEntry) {
  entry.refs--;
  if (entry.refs <= 0 && INFLIGHT.get(targetUrl) === entry) {
    entry.controller.abort();
    INFLIGHT.delete(targetUrl);
  }
}

// Returns Infinity for past-season URLs (season param < current year) — those are immutable.
function inferClientTtl(url: string | null, explicitTtl?: number): number {
  if (explicitTtl !== undefined) return explicitTtl;
  if (!url) return SESSION_CACHE_TTL_MS;
  const m = url.match(/[?&]season=(\d{4})(?:&|$)/);
  if (m) {
    const seasonYear = parseInt(m[1], 10);
    const currentYear = new Date().getFullYear();
    // Season param < current year means the season has finished — data won't change.
    if (seasonYear < currentYear - 1 || (seasonYear === currentYear - 1 && new Date().getMonth() >= 7)) {
      return Infinity;
    }
  }
  return SESSION_CACHE_TTL_MS;
}

export function useApi<T>(url: string | null, options?: { noCache?: boolean; clientTtlMs?: number }) {
  const noCache = options?.noCache ?? false;
  const clientTtlMs = inferClientTtl(url, options?.clientTtlMs);
  const [data, setData] = useState<T | null>(() => {
    if (!url || noCache) return null;
    return (sessionGet(url) as T) ?? null;
  });
  const [loading, setLoading] = useState(() => !!url && (noCache || sessionGet(url) === undefined));
  const [error, setError] = useState<string | null>(null);

  const load = useCallback((targetUrl: string, skipCache: boolean, ttlMs: number) => {
    const cached = !skipCache ? sessionGet(targetUrl) : undefined;
    if (cached !== undefined) {
      setData(cached as T);
      setLoading(false);
      setError(null);
      return () => {};
    }

    // If a request for this URL is already in-flight, attach to it
    if (!skipCache && INFLIGHT.has(targetUrl)) {
      const entry = INFLIGHT.get(targetUrl)!;
      entry.refs++;
      let cancelled = false;
      setLoading(true);
      setError(null);
      entry.promise
        .then((d) => { if (!cancelled) { setData(d as T); setLoading(false); } })
        .catch((e) => { if (!cancelled && (e as Error)?.name !== "AbortError") { setError((e as Error).message); setLoading(false); } });
      return () => { cancelled = true; releaseInflight(targetUrl, entry); };
    }

    let cancelled = false;
    setLoading(true);
    setError(null);
    setData(null);

    const controller = new AbortController();

    const promise = fetchWithRetry(targetUrl, controller.signal)
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then((d) => {
        if (!skipCache) sessionSet(targetUrl, d, ttlMs);
        return d;
      })
      .finally(() => {
        // Only remove if this entry is still the active one for this URL
        if (INFLIGHT.get(targetUrl)?.controller === controller) INFLIGHT.delete(targetUrl);
      });

    const entry: InflightEntry = { promise, controller, refs: 1 };
    INFLIGHT.set(targetUrl, entry);

    promise
      .then((d) => { if (!cancelled) { setData(d as T); setLoading(false); } })
      .catch((e) => { if (!cancelled && (e as Error)?.name !== "AbortError") { setError((e as Error).message); setLoading(false); } });

    return () => { cancelled = true; releaseInflight(targetUrl, entry); };
  }, []);

  useEffect(() => {
    if (!url) {
      setData(null);
      setLoading(false);
      setError(null);
      return;
    }
    return load(url, noCache, clientTtlMs);
  }, [url, load, noCache, clientTtlMs]);

  // Re-fetch when the server restarts (SESSION_CACHE was cleared before this fires).
  useEffect(() => {
    if (!url) return;
    const onRestart = () => load(url, false, clientTtlMs);
    window.addEventListener("server-restart", onRestart);
    return () => window.removeEventListener("server-restart", onRestart);
  }, [url, load, clientTtlMs]);

  const retry = useCallback(() => {
    if (!url) return;
    SESSION_CACHE.delete(url); // force re-fetch on explicit retry
    load(url, false, clientTtlMs);
  }, [url, load, clientTtlMs]);

  return { data, loading, error, retry };
}
