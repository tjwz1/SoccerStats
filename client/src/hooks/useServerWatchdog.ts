import { useEffect, useRef } from "react";
import { clearSessionCache } from "./useApi";

const POLL_INTERVAL_MS = 15_000;

export function useServerWatchdog() {
  const lastStartedAt = useRef<number | null>(null);

  useEffect(() => {
    // Serverless deployments (Vercel) create new function instances on every cold start,
    // so startedAt changes constantly — disable the watchdog outside local dev to prevent
    // a false-restart loop that clears the session cache every 15 seconds.
    if (!import.meta.env.DEV) return;

    const check = async () => {
      try {
        const res = await fetch("/api/health");
        if (!res.ok) return;
        const { startedAt } = await res.json() as { startedAt?: number };
        if (!startedAt) return;

        if (lastStartedAt.current === null) {
          lastStartedAt.current = startedAt;
        } else if (startedAt !== lastStartedAt.current) {
          lastStartedAt.current = startedAt;
          clearSessionCache();
          window.dispatchEvent(new CustomEvent("server-restart"));
        }
      } catch {
        // Server down — ignore, will retry next interval
      }
    };

    check();
    const id = setInterval(check, POLL_INTERVAL_MS);
    return () => clearInterval(id);
  }, []);
}
