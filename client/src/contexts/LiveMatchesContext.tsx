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
    let alive = true;

    function fetchOnce() {
      fetch("/api/live-matches")
        .then((r) => (r.ok ? r.json() : []))
        .then((d: ScheduleMatch[]) => { if (alive) setLiveMatches(d); })
        .catch(() => {});
    }

    fetchOnce();
    const interval = setInterval(fetchOnce, 30_000);

    return () => {
      alive = false;
      clearInterval(interval);
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
