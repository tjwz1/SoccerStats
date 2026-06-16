import { useState } from "react";
import type { Player } from "../types";

interface Props {
  starters: Player[];
  bench: Player[];
  onClick: (player: Player) => void;
  onHover: (player: Player | null, x: number, y: number) => void;
}

const GROUPS: { label: string; position: Player["position"]; accent: string; dot: string }[] = [
  { label: "Goalkeepers", position: "Goalkeeper", accent: "border-yellow-400",  dot: "bg-yellow-400"  },
  { label: "Defenders",   position: "Defender",   accent: "border-blue-400",    dot: "bg-blue-400"    },
  { label: "Midfielders", position: "Midfielder", accent: "border-purple-400",  dot: "bg-purple-400"  },
  { label: "Forwards",    position: "Attacker",   accent: "border-red-400",     dot: "bg-red-400"     },
];

function PlayerCard({
  player,
  accent,
  onClick,
  onHover,
}: {
  player: Player;
  accent: string;
  onClick: (p: Player) => void;
  onHover: (p: Player | null, x: number, y: number) => void;
}) {
  const [imgError, setImgError] = useState(false);
  const [imgLoaded, setImgLoaded] = useState(false);
  const showPhoto = !!player.photo && !imgError;
  const initials = player.name
    .split(" ")
    .map((w) => w[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();

  const lastName = player.name.split(" ").slice(1).join(" ") || player.name;
  // id=0 means a Wikipedia-supplemented player with no fd.org ID — show them
  // in the squad grid but disable the career stats click (no data to load).
  const hasStats = player.id > 0;

  return (
    <button
      onClick={() => { if (hasStats) onClick(player); }}
      onMouseEnter={(e) => {
        const rect = e.currentTarget.getBoundingClientRect();
        onHover(player, rect.left + rect.width / 2, rect.top);
      }}
      onMouseLeave={() => onHover(null, 0, 0)}
      className={`group relative flex flex-col bg-slate-800 rounded-xl overflow-hidden border-t-2 ${accent} transition-all text-left w-full ${hasStats ? "hover:bg-slate-700 hover:scale-[1.02] hover:shadow-xl cursor-pointer" : "opacity-60 cursor-default"}`}
    >
      {/* Photo area */}
      <div className="relative w-full aspect-[3/4] bg-gradient-to-b from-slate-700 to-slate-800 overflow-hidden flex items-end justify-center">
        {showPhoto ? (
          <>
            {/* Skeleton shown until image finishes loading */}
            {!imgLoaded && (
              <div className="absolute inset-0 animate-pulse bg-gradient-to-b from-slate-600/40 to-slate-700/40" />
            )}
            <img
              src={player.photo!}
              alt={player.name}
              onLoad={() => setImgLoaded(true)}
              onError={() => setImgError(true)}
              className={`w-full h-full object-contain object-bottom transition-opacity duration-300 ${imgLoaded ? "opacity-100" : "opacity-0"}`}
            />
          </>
        ) : (
          <div className="absolute inset-0 flex items-center justify-center">
            <span className="text-4xl font-black text-slate-600">{initials}</span>
          </div>
        )}

        {/* Jersey number */}
        {player.shirtNumber != null && (
          <span className="absolute top-2 right-2 text-xs font-bold text-white/60 leading-none">
            #{player.shirtNumber}
          </span>
        )}

        {/* Hover overlay */}
        <div className="absolute inset-0 bg-green-600/0 group-hover:bg-green-600/10 transition-colors pointer-events-none" />
      </div>

      {/* Name strip */}
      <div className="px-2 py-2 border-t border-slate-700">
        <div className="flex items-center justify-between gap-1">
          <p className="text-white font-semibold text-xs truncate leading-tight">{lastName}</p>
          {hasStats && (
            <svg className="w-3 h-3 text-slate-600 group-hover:text-slate-400 shrink-0 transition-colors" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
            </svg>
          )}
        </div>
        <p className="text-slate-500 text-[10px] mt-0.5">{player.position}</p>
        {((player.appearances ?? 0) > 0 || (player.goals ?? 0) > 0 || (player.assists ?? 0) > 0) && (
          <div className="flex gap-1.5 mt-1 text-[9px] text-slate-400 font-mono">
            <span>{player.appearances ?? 0} apps</span>
            <span className="text-slate-600">·</span>
            <span>{player.goals ?? 0}G</span>
            <span className="text-slate-600">·</span>
            <span>{player.assists ?? 0}A</span>
          </div>
        )}
      </div>
    </button>
  );
}

export default function SquadGrid({ starters, bench, onClick, onHover }: Props) {
  const all = [...starters, ...bench];

  return (
    <div className="space-y-8 w-full">
      {GROUPS.map(({ label, position, accent, dot }) => {
        const players = all.filter((p) => p.position === position);
        if (players.length === 0) return null;
        return (
          <section key={position}>
            <div className="flex items-center gap-2 mb-4">
              <span className={`w-2.5 h-2.5 rounded-full shrink-0 ${dot}`} />
              <h3 className="text-xs font-semibold text-slate-400 uppercase tracking-widest">
                {label}
              </h3>
              <div className="flex-1 h-px bg-slate-800" />
              <span className="text-xs text-slate-600">{players.length}</span>
            </div>
            <div className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-5 gap-3">
              {players.map((player) => (
                <PlayerCard
                  key={player.id}
                  player={player}
                  accent={accent}
                  onClick={onClick}
                  onHover={onHover}
                />
              ))}
            </div>
          </section>
        );
      })}
    </div>
  );
}
