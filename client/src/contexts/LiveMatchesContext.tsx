import { createContext, useContext, useState, useEffect, useMemo } from "react";
import type { ScheduleMatch } from "../types";

interface LiveMatchesContextValue {
  liveMatches: ScheduleMatch[];
  liveById: Map<number, ScheduleMatch>;
}

const LiveMatchesContext = createContext<LiveMatchesContextValue>({
  liveMatches: [],
  liveById: new Map(),
});

export function LiveMatchesProvider({ children }: { children: React.ReactNode }) {
  const [liveMatches, setLiveMatches] = useState<ScheduleMatch[]>([]);

  useEffect(() => {
    let es: EventSource | null = null;
    let fallbackInterval: ReturnType<typeof setInterval> | null = null;
    let alive = true;

    function applyData(data: ScheduleMatch[]) {
      if (alive) setLiveMatches(data);
    }

    function fetchOnce() {
      fetch("/api/live-matches")
        .then((r) => (r.ok ? r.json() : []))
        .then((d: ScheduleMatch[]) => applyData(d))
        .catch(() => {});
    }

    function startFallback() {
      fetchOnce();
      fallbackInterval = setInterval(fetchOnce, 30_000);
    }

    function startSSE() {
      try {
        es = new EventSource("/api/live-matches/stream");
        es.onmessage = (e) => {
          try { applyData(JSON.parse(e.data) as ScheduleMatch[]); } catch {}
        };
        es.onerror = () => {
          es?.close();
          es = null;
          // Switch to polling if SSE fails (e.g. Vercel function timeout, proxy issue)
          if (!fallbackInterval) startFallback();
        };
      } catch {
        startFallback();
      }
    }

    startSSE();

    function onRestart() {
      // Clear live state and re-establish connection after server restart
      if (es) { es.close(); es = null; }
      if (fallbackInterval) { clearInterval(fallbackInterval); fallbackInterval = null; }
      startSSE();
    }
    window.addEventListener("server-restart", onRestart);

    return () => {
      alive = false;
      es?.close();
      if (fallbackInterval) clearInterval(fallbackInterval);
      window.removeEventListener("server-restart", onRestart);
    };
  }, []);

  const liveById = useMemo(() => {
    const map = new Map<number, ScheduleMatch>();
    for (const m of liveMatches) map.set(m.id, m);
    return map;
  }, [liveMatches]);

  return (
    <LiveMatchesContext.Provider value={{ liveMatches, liveById }}>
      {children}
    </LiveMatchesContext.Provider>
  );
}

export function useLiveMatches() {
  return useContext(LiveMatchesContext);
}
