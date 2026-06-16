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

  function fetchLive() {
    fetch("/api/live-matches")
      .then((r) => (r.ok ? r.json() : []))
      .then((data: ScheduleMatch[]) => setLiveMatches(data))
      .catch(() => {});
  }

  useEffect(() => {
    fetchLive();
    const id = setInterval(fetchLive, 30_000);
    // Re-fetch immediately when the server restarts
    window.addEventListener("server-restart", fetchLive);
    return () => {
      clearInterval(id);
      window.removeEventListener("server-restart", fetchLive);
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
