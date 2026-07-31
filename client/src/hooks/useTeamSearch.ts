import { useState, useEffect } from "react";
import type { Team } from "../types";
import { useApi } from "./useApi";

/**
 * Debounces the query, then routes through useApi so the INFLIGHT deduplication
 * map prevents concurrent identical searches from firing duplicate HTTP requests.
 */
export function useTeamSearch(
  query: string,
  debounceMs = 300
): { results: Team[] | null; loading: boolean } {
  const [debouncedQuery, setDebouncedQuery] = useState<string>(() => {
    const q = query.trim();
    return q.length >= 2 ? q : "";
  });

  useEffect(() => {
    const q = query.trim();
    if (q.length < 2) {
      setDebouncedQuery("");
      return;
    }
    const timer = setTimeout(() => setDebouncedQuery(q), debounceMs);
    return () => clearTimeout(timer);
  }, [query, debounceMs]);

  const url = debouncedQuery ? `/api/teams/search?q=${encodeURIComponent(debouncedQuery)}` : null;
  const { data, loading, error } = useApi<Team[]>(url);

  const active = debouncedQuery.length >= 2;
  return {
    results: active ? (data ?? (error ? [] : null)) : null,
    loading: active ? loading : false,
  };
}
