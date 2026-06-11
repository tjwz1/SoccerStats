import { useState } from "react";
import type { ClubTrophy } from "../types";

interface Props {
  trophies: ClubTrophy[];
  loading: boolean;
  error: string | null;
  teamName: string;
  onRetry?: () => void;
}

const CATEGORY_ORDER = ["Domestic", "European", "International", "Other"];

export default function ClubTrophies({ trophies, loading, error, teamName, onRetry }: Props) {
  if (loading) {
    return (
      <div className="flex flex-col items-center gap-3 py-20 text-slate-500">
        <div className="w-6 h-6 border-2 border-slate-600 border-t-white rounded-full animate-spin" />
        <p className="text-sm">Loading honours…</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex flex-col items-center gap-3 py-20 text-slate-500">
        <p className="text-sm">Could not load honours.</p>
        {onRetry && (
          <button
            onClick={onRetry}
            className="px-4 py-1.5 bg-slate-700 hover:bg-slate-600 text-white text-xs rounded-lg transition-colors"
          >
            Retry
          </button>
        )}
      </div>
    );
  }

  if (trophies.length === 0) {
    return (
      <div className="flex flex-col items-center gap-2 py-20 text-slate-500">
        <p className="text-sm">No honours data found for {teamName}.</p>
      </div>
    );
  }

  const byCategory = new Map<string, ClubTrophy[]>();
  for (const t of trophies) {
    const list = byCategory.get(t.category) ?? [];
    list.push(t);
    byCategory.set(t.category, list);
  }

  const categories = CATEGORY_ORDER.filter((c) => byCategory.has(c));
  for (const c of byCategory.keys()) {
    if (!categories.includes(c)) categories.push(c);
  }

  return (
    <div className="space-y-8 w-full max-w-4xl mx-auto">
      {categories.map((cat) => (
        <section key={cat}>
          <h2 className="text-xs font-semibold text-slate-500 uppercase tracking-widest mb-4">
            {cat}
          </h2>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {(byCategory.get(cat) ?? []).map((trophy, i) => (
              <TrophyCard key={i} trophy={trophy} />
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}

function TrophyCard({ trophy }: { trophy: ClubTrophy }) {
  const [expanded, setExpanded] = useState(false);
  const [imgError, setImgError] = useState(false);
  const VISIBLE = 8;
  const showToggle = trophy.years.length > VISIBLE;
  const visibleYears = expanded ? trophy.years : trophy.years.slice(0, VISIBLE);
  const showImg = !!trophy.imageUrl && !imgError;

  return (
    <div className="bg-slate-800/60 border border-slate-700/60 rounded-2xl p-4">
      <div className="flex items-start justify-between gap-2 mb-3">
        <div className="flex items-center gap-2.5 min-w-0">
          {showImg && (
            <div className="w-10 h-10 bg-white rounded-lg flex items-center justify-center shrink-0 p-1.5 shadow-sm">
              <img
                src={trophy.imageUrl}
                alt={trophy.name}
                onError={() => setImgError(true)}
                className="w-full h-full object-contain"
              />
            </div>
          )}
          <p className="text-sm font-semibold text-white leading-tight">{trophy.name}</p>
        </div>
        <span className="shrink-0 bg-green-600/20 text-green-400 text-xs font-bold px-2 py-0.5 rounded-full border border-green-600/30">
          ×{trophy.count}
        </span>
      </div>
      <div className="flex flex-wrap gap-1">
        {visibleYears.map((y, i) => (
          <span
            key={i}
            className="bg-slate-700/70 text-slate-300 text-xs px-1.5 py-0.5 rounded font-mono"
          >
            {y}
          </span>
        ))}
        {showToggle && (
          <button
            onClick={() => setExpanded(!expanded)}
            className="text-xs text-slate-500 hover:text-slate-300 px-1.5 py-0.5 transition-colors"
          >
            {expanded ? "show less" : `+${trophy.years.length - VISIBLE} more`}
          </button>
        )}
      </div>
    </div>
  );
}
