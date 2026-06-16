import { useState } from "react";
import type { Player } from "../types";

interface Props {
  player: Player;
  x: number;
  y: number;
  size?: "normal" | "small";
  subbedOut?: boolean;
  onHover?: (player: Player | null, clientX: number, clientY: number) => void;
  onClick: (player: Player) => void;
}

const POSITION_COLORS: Record<string, string> = {
  Goalkeeper: "#facc15",
  Defender: "#60a5fa",
  Midfielder: "#a78bfa",
  Attacker: "#f87171",
};

const POSITION_BG: Record<string, string> = {
  Goalkeeper: "bg-yellow-400",
  Defender: "bg-blue-400",
  Midfielder: "bg-violet-400",
  Attacker: "bg-red-400",
};

export default function PlayerMarker({ player, x, y, size = "normal", subbedOut = false, onHover, onClick }: Props) {
  const [imgError, setImgError] = useState(false);
  const color = POSITION_COLORS[player.position] ?? "#94a3b8";
  const bg = POSITION_BG[player.position] ?? "bg-slate-400";
  const initials = player.name.split(" ").map((w) => w[0]).join("").slice(0, 2).toUpperCase();
  const showPhoto = !!player.photo && !imgError;

  const avatarSize = size === "small" ? "w-8 h-8 text-[10px]" : "w-10 h-10 text-xs";
  const lastName = player.name.split(" ").pop() ?? player.name;

  const hasStats = player.id !== 0;
  return (
    <button
      className={`absolute flex flex-col items-center gap-0.5 -translate-x-1/2 -translate-y-1/2 group ${hasStats ? "cursor-pointer" : "cursor-default opacity-75"}`}
      style={{ left: `${x}%`, top: `${y}%` }}
      onMouseEnter={onHover ? (e) => onHover(player, e.clientX, e.clientY) : undefined}
      onMouseLeave={onHover ? () => onHover(null, 0, 0) : undefined}
      onClick={() => onClick(player)}
    >
      <div className="relative">
        <div
          className={`${avatarSize} rounded-full overflow-hidden flex items-center justify-center font-bold text-slate-900 shadow-lg ring-2 ring-white/30 group-hover:ring-white group-hover:scale-110 transition-all duration-150 shrink-0`}
          style={showPhoto ? {} : { backgroundColor: color }}
        >
          {showPhoto ? (
            <img
              src={player.photo!}
              alt={player.name}
              className="w-full h-full object-cover object-top"
              onError={() => setImgError(true)}
            />
          ) : (
            <span>{initials}</span>
          )}
        </div>
        {subbedOut && (
          <span className="absolute -top-1 -right-1 w-3.5 h-3.5 bg-red-500 rounded-full flex items-center justify-center text-[7px] text-white font-bold leading-none pointer-events-none">
            ↓
          </span>
        )}
      </div>

      {size === "normal" && (
        <>
          <span className="text-[10px] font-semibold text-white drop-shadow-md whitespace-nowrap max-w-[68px] truncate leading-tight">
            {lastName}
          </span>
          {player.shirtNumber && (
            <span className="text-[9px] text-white/60 -mt-0.5">{player.shirtNumber}</span>
          )}
        </>
      )}

      {size === "small" && player.shirtNumber && (
        <span
          className={`text-[8px] font-bold text-slate-900 w-4 h-4 rounded-full flex items-center justify-center -mt-1.5 ring-1 ring-white/50 ${bg}`}
        >
          {player.shirtNumber}
        </span>
      )}
    </button>
  );
}
