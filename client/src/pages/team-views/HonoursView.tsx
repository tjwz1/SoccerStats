import type { ClubTrophy } from "../../types";
import { useApi } from "../../hooks/useApi";
import ClubTrophies from "../../components/ClubTrophies";

interface Props {
  teamId: number;
  teamName: string;
}

export default function HonoursView({ teamId, teamName }: Props) {
  const { data, loading, error, retry } = useApi<ClubTrophy[]>(
    `/api/teams/${teamId}/honours?name=${encodeURIComponent(teamName)}`
  );
  return (
    <ClubTrophies
      trophies={data ?? []}
      loading={loading}
      error={error}
      teamName={teamName}
      onRetry={retry}
    />
  );
}
