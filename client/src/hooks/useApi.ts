import { useState, useEffect, useCallback } from "react";

async function fetchWithRetry(url: string, retries = 2, delayMs = 1500): Promise<Response> {
  for (let attempt = 0; attempt <= retries; attempt++) {
    const res = await fetch(url);
    if (res.ok || attempt === retries) return res;
    // Retry on 429 (rate limit) or 500 (transient server error)
    if (res.status === 429 || res.status === 500) {
      await new Promise((r) => setTimeout(r, delayMs * (attempt + 1)));
    } else {
      return res; // non-retryable error
    }
  }
  throw new Error("unreachable");
}

// In-memory cache keyed by URL; survives React re-renders within the same session.
// Entries expire after SESSION_CACHE_TTL_MS so live scores/standings refresh automatically.
const SESSION_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const SESSION_CACHE_MAX = 150; // evict oldest when over this limit
const SESSION_CACHE = new Map<string, { data: unknown; at: number }>();

// In-flight deduplication: if two useApi calls request the same URL concurrently,
// the second attaches to the first's promise rather than making a duplicate HTTP request.
const INFLIGHT = new Map<string, Promise<unknown>>();

export function sessionGet(url: string): unknown | undefined {
  const entry = SESSION_CACHE.get(url);
  if (!entry) return undefined;
  if (Date.now() - entry.at > SESSION_CACHE_TTL_MS) { SESSION_CACHE.delete(url); return undefined; }
  return entry.data;
}

export function sessionSet(url: string, data: unknown) {
  if (SESSION_CACHE.size >= SESSION_CACHE_MAX) {
    const firstKey = SESSION_CACHE.keys().next().value;
    if (firstKey !== undefined) SESSION_CACHE.delete(firstKey);
  }
  SESSION_CACHE.set(url, { data, at: Date.now() });
}

export function clearSessionCache() {
  SESSION_CACHE.clear();
}

export function useApi<T>(url: string | null, options?: { noCache?: boolean }) {
  const noCache = options?.noCache ?? false;
  const [data, setData] = useState<T | null>(() => {
    if (!url || noCache) return null;
    return (sessionGet(url) as T) ?? null;
  });
  const [loading, setLoading] = useState(() => !!url && (noCache || sessionGet(url) === undefined));
  const [error, setError] = useState<string | null>(null);

  const load = useCallback((targetUrl: string, skipCache: boolean) => {
    const cached = !skipCache ? sessionGet(targetUrl) : undefined;
    if (cached !== undefined) {
      setData(cached as T);
      setLoading(false);
      setError(null);
      return () => {};
    }

    // If a request for this URL is already in-flight, attach to it instead of making a new one
    if (!skipCache && INFLIGHT.has(targetUrl)) {
      let cancelled = false;
      setLoading(true);
      setError(null);
      INFLIGHT.get(targetUrl)!.then((d) => {
        if (!cancelled) { setData(d as T); setLoading(false); }
      }).catch((e) => {
        if (!cancelled) { setError((e as Error).message); setLoading(false); }
      });
      return () => { cancelled = true; };
    }

    let cancelled = false;
    setLoading(true);
    setError(null);
    setData(null);

    const promise = fetchWithRetry(targetUrl)
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then((d) => {
        if (!skipCache) sessionSet(targetUrl, d);
        return d;
      })
      .finally(() => INFLIGHT.delete(targetUrl));

    INFLIGHT.set(targetUrl, promise);

    promise
      .then((d) => { if (!cancelled) { setData(d as T); setLoading(false); } })
      .catch((e) => { if (!cancelled) { setError((e as Error).message); setLoading(false); } });

    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (!url) {
      setData(null);
      setLoading(false);
      setError(null);
      return;
    }
    return load(url, noCache);
  }, [url, load, noCache]);

  // Re-fetch when the server restarts (SESSION_CACHE was cleared before this fires).
  useEffect(() => {
    if (!url) return;
    const onRestart = () => load(url, false);
    window.addEventListener("server-restart", onRestart);
    return () => window.removeEventListener("server-restart", onRestart);
  }, [url, load]);

  const retry = useCallback(() => {
    if (!url) return;
    SESSION_CACHE.delete(url); // force re-fetch on explicit retry
    load(url, false);
  }, [url, load]);

  return { data, loading, error, retry };
}
