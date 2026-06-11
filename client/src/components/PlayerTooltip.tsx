import { useEffect, useRef, useState } from "react";
import type { Player } from "../types";

interface Props {
  player: Player;
  anchorX: number;
  anchorY: number;
}

export default function PlayerTooltip({ player, anchorX, anchorY }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const [style, setStyle] = useState<React.CSSProperties>({ opacity: 0 });

  useEffect(() => {
    if (!ref.current) return;
    const { innerWidth, innerHeight } = window;
    const { width, height } = ref.current.getBoundingClientRect();
    let left = anchorX + 12;
    let top = anchorY - height / 2;
    if (left + width > innerWidth - 8) left = anchorX - width - 12;
    if (top < 8) top = 8;
    if (top + height > innerHeight - 8) top = innerHeight - height - 8;
    setStyle({ left, top, opacity: 1 });
  }, [anchorX, anchorY]);

  const age = player.dateOfBirth
    ? Math.floor((Date.now() - new Date(player.dateOfBirth).getTime()) / 31557600000)
    : null;

  return (
    <div
      ref={ref}
      className="fixed z-50 pointer-events-none transition-opacity duration-100 w-52"
      style={style}
    >
      <div className="bg-slate-800 border border-slate-600 rounded-xl p-3 shadow-2xl">
        <p className="font-semibold text-white text-sm leading-tight">{player.name}</p>
        <p className="text-xs text-slate-400 mt-0.5">{player.position}</p>
        <div className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1 text-xs">
          {player.nationality && (
            <>
              <span className="text-slate-400">Nationality</span>
              <span className="text-white font-medium">{player.nationality}</span>
            </>
          )}
          {age !== null && (
            <>
              <span className="text-slate-400">Age</span>
              <span className="text-white font-medium">{age}</span>
            </>
          )}
          {player.shirtNumber && (
            <>
              <span className="text-slate-400">Shirt</span>
              <span className="text-white font-medium">#{player.shirtNumber}</span>
            </>
          )}
        </div>
        <p className="text-[10px] text-slate-500 mt-2 italic">Click for career stats</p>
      </div>
    </div>
  );
}
