import type { LineupData, Player } from "../../types";
import SquadGrid from "../../components/SquadGrid";

interface Props {
  lineup: LineupData;
  onPlayerClick: (player: Player) => void;
  onPlayerHover: (player: Player | null, x: number, y: number) => void;
  season?: number;
}

const CURRENT_YEAR = new Date().getFullYear();

export default function SquadView({ lineup, onPlayerClick, onPlayerHover, season }: Props) {
  const isHistorical = season && season < CURRENT_YEAR;

  return (
    <div>
      {isHistorical && (
        <p className="text-xs text-slate-500 text-center mb-4 bg-slate-900 rounded-lg px-4 py-2">
          Showing current squad roster — historical {season} squad data is not available in the free tier.
        </p>
      )}
      <SquadGrid
        starters={lineup.starters}
        bench={lineup.bench}
        onClick={onPlayerClick}
        onHover={onPlayerHover}
      />
    </div>
  );
}
