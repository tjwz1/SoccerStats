import { useEffect, useRef } from "react";
import { clearSessionCache } from "./useApi";

const POLL_INTERVAL_MS = 15_000;

export function useServerWatchdog() {
  const lastStartedAt = useRef<number | null>(null);

  useEffect(() => {
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
