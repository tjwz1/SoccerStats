import { useEffect, useMemo } from "react";
import type { ScheduleMatch, StandingsData, StandingRow } from "../../types";
import { useApi, sessionGet } from "../../hooks/useApi";
import { useLiveMatches } from "../../contexts/LiveMatchesContext";
import TeamSchedule from "../../components/TeamSchedule";
import PositionChart from "../../components/PositionChart";

interface Props {
  teamId: number;
  teamName: string;
  competitionCode: string;
  season?: number;
}

export default function ScheduleView({ teamId, teamName, competitionCode, season }: Props) {
  const baseQuery = `competition=${competitionCode}&name=${encodeURIComponent(teamName)}${season ? `&season=${season}` : ""}`;
  const fullUrl = `/api/teams/${teamId}/schedule?${baseQuery}`;

  // Resolve a standing row from the session cache — available when the user
  // navigated from CompetitionLanding which already fetched standings.
  const standingsUrl = `/api/competitions/${competitionCode}/standings`;
  const cachedStandings = sessionGet(standingsUrl) as StandingsData | undefined;
  const cachedStandingRow: StandingRow | null = cachedStandings
    ? cachedStandings.groups.flatMap((g) => g.rows).find((r) => r.team.id === teamId) ?? null
    : null;

  // Phase 1: finished matches only from permanent Supabase cache (~50ms).
  // Skip when the full schedule is already cached to avoid a redundant request.
  const isFullCached = sessionGet(fullUrl) !== undefined;
  const { data: pastData } = useApi<ScheduleMatch[]>(
    (!season && !isFullCached) ? `${fullUrl}&past=true` : null
  );

  // Phase 2: full schedule (past + upcoming/live).
  const { data: fullData, error, retry } = useApi<ScheduleMatch[]>(fullUrl);

  const hasPastData = pastData !== null && pastData.length > 0;
  const matches = fullData ?? (hasPastData ? pastData! : null) ?? [];
  const loading = !fullData && !hasPastData;
  const upcomingLoading = !fullData;

  // Live overlay — from the app-level context; one poll for the whole app
  const { liveById } = useLiveMatches();

  const overlaidMatches = useMemo(() => {
    return matches.map((m) => {
      const live = liveById.get(m.id);
      return live
        ? { ...m, status: live.status, scoreHome: live.scoreHome, scoreAway: live.scoreAway }
        : m;
    });
  }, [matches, liveById]);

  // Refresh the full schedule while a match is live so event data stays current
  const hasLive = overlaidMatches.some((m) => m.status === "IN_PLAY" || m.status === "PAUSED");
  useEffect(() => {
    if (!hasLive) return;
    const id = setInterval(retry, 2 * 60_000);
    return () => clearInterval(id);
  }, [hasLive, retry]);

  return (
    <div className="space-y-6">
      {!season && (
        <PositionChart competitionCode={competitionCode} teamId={teamId} />
      )}
      <TeamSchedule
        matches={overlaidMatches}
        loading={loading}
        error={error}
        teamId={teamId}
        teamName={teamName}
        competitionCode={competitionCode}
        onRetry={retry}
        upcomingLoading={upcomingLoading}
        standingRow={cachedStandingRow}
      />
    </div>
  );
}
