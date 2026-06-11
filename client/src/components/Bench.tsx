import { useState } from "react";
import type { Player } from "../types";

interface Props {
  bench: Player[];
  onClick: (player: Player) => void;
  onHover: (player: Player | null, x: number, y: number) => void;
}

const POSITION_LABEL: Record<string, string> = {
  Goalkeeper: "GK",
  Defender: "DEF",
  Midfielder: "MID",
  Attacker: "FWD",
};

export default function Bench({ bench, onClick, onHover }: Props) {
  return (
    <div className="mt-3">
      <div className="flex items-center gap-2 mb-2">
        <div className="h-px flex-1 bg-slate-700" />
        <span className="text-[10px] font-semibold text-slate-500 uppercase tracking-widest">Bench</span>
        <div className="h-px flex-1 bg-slate-700" />
      </div>
      <div className="flex justify-center gap-3 flex-wrap">
        {bench.map((player, idx) => (
          <button
            key={player.id !== 0 ? player.id : `bench-${idx}-${player.name}`}
            className="flex flex-col items-center gap-1 cursor-pointer group"
            onMouseEnter={(e) => onHover(player, e.clientX, e.clientY)}
            onMouseLeave={() => onHover(null, 0, 0)}
            onClick={() => onClick(player)}
          >
            {/* Avatar */}
            <div className="relative">
              <BenchAvatar player={player} />
            </div>
            {/* Name + position */}
            <div className="text-center">
              <p className="text-[9px] font-semibold text-white/80 whitespace-nowrap max-w-[52px] truncate leading-tight">
                {player.name.split(" ").pop()}
              </p>
              <p className="text-[8px] text-slate-500">{POSITION_LABEL[player.position]}</p>
            </div>
          </button>
        ))}
      </div>
    </div>
  );
}

function BenchAvatar({ player }: { player: Player }) {
  const [imgError, setImgError] = useState(false);
  const [imgLoaded, setImgLoaded] = useState(false);
  const showPhoto = !!player.photo && !imgError;
  const initials = player.name.split(" ").map((w) => w[0]).join("").slice(0, 2).toUpperCase();

  const COLORS: Record<string, string> = {
    Goalkeeper: "#facc15",
    Defender: "#60a5fa",
    Midfielder: "#a78bfa",
    Attacker: "#f87171",
  };
  const color = COLORS[player.position] ?? "#94a3b8";

  return (
    <div
      className="w-9 h-9 rounded-full overflow-hidden flex items-center justify-center text-[10px] font-bold text-slate-900 shadow ring-1 ring-white/20 group-hover:ring-white group-hover:scale-110 transition-all"
      style={showPhoto ? {} : { backgroundColor: color }}
    >
      {showPhoto ? (
        <>
          {!imgLoaded && <div className="absolute inset-0 rounded-full animate-pulse bg-slate-600" />}
          <img
            src={player.photo!}
            alt={player.name}
            className={`w-full h-full object-cover object-top transition-opacity duration-200 ${imgLoaded ? "opacity-100" : "opacity-0"}`}
            onLoad={() => setImgLoaded(true)}
            onError={() => setImgError(true)}
          />
        </>
      ) : (
        <span>{initials}</span>
      )}
    </div>
  );
}

