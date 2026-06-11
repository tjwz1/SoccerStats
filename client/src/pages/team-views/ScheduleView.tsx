import { useEffect } from "react";
import type { ScheduleMatch } from "../../types";
import { useApi } from "../../hooks/useApi";
import TeamSchedule from "../../components/TeamSchedule";
import PositionChart from "../../components/PositionChart";

interface Props {
  teamId: number;
  teamName: string;
  competitionCode: string;
  season?: number;
}

const LIVE_POLL_MS = 30_000; // refresh every 30 s while a match is in play

export default function ScheduleView({ teamId, teamName, competitionCode, season }: Props) {
  const baseQuery = `competition=${competitionCode}&name=${encodeURIComponent(teamName)}${season ? `&season=${season}` : ""}`;

  // Phase 1: finished matches only from permanent Supabase cache (~50ms).
  // Skip when a specific season is requested — the cache key doesn't include season.
  const { data: pastData } = useApi<ScheduleMatch[]>(
    season ? null : `/api/teams/${teamId}/schedule?${baseQuery}&past=true`
  );

  // Phase 2: full schedule (past + upcoming/live).
  const { data: fullData, error, retry } = useApi<ScheduleMatch[]>(
    `/api/teams/${teamId}/schedule?${baseQuery}`
  );

  const hasPastData = pastData !== null && pastData.length > 0;
  const matches = fullData ?? (hasPastData ? pastData! : null) ?? [];
  const loading = !fullData && !hasPastData;
  const upcomingLoading = !fullData;

  // Auto-refresh while a match is live — clears session cache and re-fetches.
  // Server-side schedule cache TTL is 2 min, so fd.org is polled at most every 2 min.
  const hasLive = (fullData ?? []).some(
    (m) => m.status === "IN_PLAY" || m.status === "PAUSED"
  );
  useEffect(() => {
    if (!hasLive) return;
    const id = setInterval(retry, LIVE_POLL_MS);
    return () => clearInterval(id);
  }, [hasLive, retry]);

  return (
    <div className="space-y-6">
      {!season && (
        <PositionChart competitionCode={competitionCode} teamId={teamId} />
      )}
      <TeamSchedule
        matches={matches}
        loading={loading}
        error={error}
        teamId={teamId}
        teamName={teamName}
        onRetry={retry}
        upcomingLoading={upcomingLoading}
      />
    </div>
  );
}
