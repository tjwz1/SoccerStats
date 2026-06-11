import { useState } from "react";
import { useParams, useSearchParams, useNavigate, useLocation } from "react-router-dom";
import type { Player, PlayerDetail, Trophy } from "../types";
import { useApi } from "../hooks/useApi";

export default function PlayerPage() {
  const { id } = useParams<{ id: string }>();
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const location = useLocation();

  const competition = searchParams.get("competition") ?? "PL";
  const statePlayer = (location.state as { player?: Player; teamName?: string } | null)?.player;
  const teamName = (location.state as { teamName?: string } | null)?.teamName;

  const { data, loading, error, retry } = useApi<PlayerDetail>(
    id ? `/api/players/${id}?competition=${competition}` : null
  );

  const displayName = data?.name ?? statePlayer?.name ?? "Player";
  const photo = statePlayer?.photo ?? null;

  const age = (dob: string | undefined) => {
    if (!dob) return null;
    return Math.floor((Date.now() - new Date(dob).getTime()) / 31557600000);
  };

  return (
    <div className="min-h-screen bg-slate-950 flex flex-col">
      {/* Header */}
      <header className="border-b border-slate-800 px-6 py-4 flex items-center gap-4">
        <button
          onClick={() => navigate(-1)}
          className="flex items-center gap-2 text-slate-400 hover:text-white transition-colors text-sm"
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
          </svg>
          Back
        </button>
        <div className="h-5 w-px bg-slate-700" />
        <div className="w-7 h-7 bg-green-600 rounded-lg flex items-center justify-center text-white font-bold text-xs">
          SS
        </div>
        <span className="text-slate-400 text-sm truncate">
          {teamName ?? "Soccer Stats"}
        </span>
      </header>

      <main className="flex-1 max-w-4xl mx-auto w-full px-6 py-8">
        {/* Player hero section */}
        <div className="flex gap-6 items-start mb-10">
          {/* Photo */}
          <div className="shrink-0 w-28 h-28 rounded-2xl overflow-hidden bg-slate-800 flex items-center justify-center shadow-xl ring-1 ring-white/10">
            {photo ? (
              <PlayerPhoto src={photo} name={displayName} />
            ) : (
              <span className="text-4xl font-black text-slate-600">
                {displayName.split(" ").map((w) => w[0]).join("").slice(0, 2).toUpperCase()}
              </span>
            )}
          </div>

          {/* Identity */}
          <div className="flex-1 min-w-0">
            <h1 className="text-3xl font-bold text-white leading-tight">{displayName}</h1>
            {(data?.position ?? statePlayer?.position) && (
              <p className="text-slate-400 mt-1">{data?.position ?? statePlayer?.position}</p>
            )}
            <div className="flex flex-wrap gap-x-6 gap-y-1 mt-3 text-sm text-slate-400">
              {(data?.nationality ?? statePlayer?.nationality) && (
                <span>
                  <span className="text-slate-500">Nationality</span>{" "}
                  <span className="text-white font-medium">{data?.nationality ?? statePlayer?.nationality}</span>
                </span>
              )}
              {age(data?.dateOfBirth ?? statePlayer?.dateOfBirth) !== null && (
                <span>
                  <span className="text-slate-500">Age</span>{" "}
                  <span className="text-white font-medium">{age(data?.dateOfBirth ?? statePlayer?.dateOfBirth)}</span>
                </span>
              )}
              {statePlayer?.shirtNumber != null && (
                <span>
                  <span className="text-slate-500">Shirt</span>{" "}
                  <span className="text-white font-medium">#{statePlayer.shirtNumber}</span>
                </span>
              )}
            </div>
          </div>
        </div>

        {/* Loading */}
        {loading && (
          <div className="flex flex-col items-center gap-3 py-20 text-slate-500">
            <div className="w-8 h-8 border-2 border-slate-600 border-t-white rounded-full animate-spin" />
            <p className="text-sm">Loading career stats…</p>
          </div>
        )}

        {/* Error */}
        {error && !loading && (
          <div className="flex flex-col items-center gap-4 py-20">
            <p className="text-slate-400">Could not load stats.</p>
            <button
              onClick={retry}
              className="px-5 py-2 bg-slate-700 hover:bg-slate-600 text-white rounded-lg text-sm transition-colors"
            >
              Retry
            </button>
          </div>
        )}

        {data && (() => {
          const hasData = data.totals.appearances > 0 || data.trophies.length > 0 || data.currentSeason.appearances > 0;
          if (!hasData) return (
            <div className="flex flex-col items-center gap-3 py-16 text-center">
              <p className="text-slate-400 font-medium">No career stats found</p>
              <p className="text-slate-600 text-sm max-w-sm">
                Stats are sourced from the scorers leaderboard and Wikipedia. Goalkeepers and players
                who haven&apos;t scored are often missing from the leaderboard.
              </p>
            </div>
          );
          return null;
        })()}

        {data && (data.totals.appearances > 0 || data.trophies.length > 0 || data.currentSeason.appearances > 0) && (
          <div className="space-y-10">
            {/* Career totals */}
            <section>
              <h2 className="text-xs font-semibold text-slate-500 uppercase tracking-widest mb-4">
                Career Totals
              </h2>
              <div className="grid grid-cols-3 gap-4">
                {[
                  { label: "Appearances", value: data.totals.appearances },
                  { label: "Goals", value: data.totals.goals },
                  { label: "Assists", value: data.totals.assists },
                ].map(({ label, value }) => (
                  <div key={label} className="bg-slate-900 border border-slate-800 rounded-2xl p-5 text-center">
                    <p className="text-4xl font-bold text-white">{value}</p>
                    <p className="text-xs text-slate-500 mt-1.5 uppercase tracking-wider">{label}</p>
                  </div>
                ))}
              </div>
            </section>

            {/* This season */}
            <section>
              <h2 className="text-xs font-semibold text-slate-500 uppercase tracking-widest mb-4">
                This Season
              </h2>
              <div className="grid grid-cols-3 gap-3">
                {[
                  { label: "Appearances", value: data.currentSeason.appearances },
                  { label: "Goals", value: data.currentSeason.goals },
                  { label: "Assists", value: data.currentSeason.assists },
                ].map(({ label, value }) => (
                  <div key={label} className="bg-slate-900 border border-slate-800 rounded-xl p-4">
                    <p className="text-2xl font-bold text-white">{value}</p>
                    <p className="text-xs text-slate-500 mt-1">{label}</p>
                  </div>
                ))}
              </div>
            </section>

            {/* Honours */}
            {data.trophies.length > 0 && (
              <Honours trophies={data.trophies} />
            )}

            {/* Season-by-season */}
            {data.career.length > 0 && (
              <section>
                <h2 className="text-xs font-semibold text-slate-500 uppercase tracking-widest mb-4">
                  Season by Season
                </h2>
                <div className="rounded-2xl border border-slate-800 overflow-hidden">
                  {/* Table header */}
                  <div className="grid grid-cols-[1fr_auto_auto_auto_auto_auto] gap-x-4 px-4 py-2.5 bg-slate-900 border-b border-slate-800 text-xs text-slate-500 uppercase tracking-wider">
                    <span>Club / Competition</span>
                    <span className="text-right">Season</span>
                    <span className="text-right">Apps</span>
                    <span className="text-right">G</span>
                    <span className="text-right">A</span>
                    <span className="text-right">G/G</span>
                  </div>
                  {/* Rows */}
                  {data.career.map((entry, i) => {
                    const gpg = entry.appearances > 0
                      ? (entry.goals / entry.appearances).toFixed(2)
                      : "—";
                    return (
                      <div
                        key={i}
                        className={`grid grid-cols-[1fr_auto_auto_auto_auto_auto] gap-x-4 px-4 py-3 items-center text-sm ${
                          i % 2 === 0 ? "bg-slate-950" : "bg-slate-900/50"
                        } border-b border-slate-800/50 last:border-0`}
                      >
                        <div className="min-w-0">
                          <p className="text-white font-medium truncate">{entry.team}</p>
                          <p className="text-slate-500 text-xs truncate">{entry.competition}</p>
                        </div>
                        <span className="text-slate-400 text-right tabular-nums">{entry.season}</span>
                        <span className="text-white font-semibold text-right tabular-nums">{entry.appearances}</span>
                        <span className="text-white font-semibold text-right tabular-nums">{entry.goals}</span>
                        <span className="text-white font-semibold text-right tabular-nums">{entry.assists}</span>
                        <span className="text-slate-400 text-right tabular-nums text-xs">{gpg}</span>
                      </div>
                    );
                  })}
                </div>
              </section>
            )}
          </div>
        )}
      </main>
    </div>
  );
}

function Honours({ trophies }: { trophies: Trophy[] }) {
  const club = trophies.filter((t) => t.category === "club");
  const intl = trophies.filter((t) => t.category === "international");
  const individual = trophies.filter((t) => t.category === "individual");

  const grouped = (list: Trophy[]) => {
    const map = new Map<string, Trophy[]>();
    for (const t of list) {
      const bucket = map.get(t.team) ?? [];
      bucket.push(t);
      map.set(t.team, bucket);
    }
    return map;
  };

  const renderTeamGroup = (label: string, list: Trophy[]) => {
    if (list.length === 0) return null;
    const byTeam = grouped(list);
    return (
      <div>
        <p className="text-xs font-semibold text-slate-500 uppercase tracking-widest mb-3">{label}</p>
        <div className="space-y-3">
          {Array.from(byTeam.entries()).map(([team, items]) => (
            <div key={team || "__no_team__"} className="bg-slate-900 border border-slate-800 rounded-2xl p-4">
              {team && <p className="text-sm font-semibold text-white mb-2">{team}</p>}
              <div className="space-y-1.5">
                {items.map((t, i) => (
                  <div key={i} className="flex items-baseline gap-2 flex-wrap">
                    <span className="text-slate-300 text-sm">{t.name}</span>
                    <span className="flex flex-wrap gap-1">
                      {t.years.map((y, yi) => (
                        <span key={`${y}-${yi}`} className="bg-slate-800 text-slate-400 text-xs px-1.5 py-0.5 rounded font-mono">
                          {y}
                        </span>
                      ))}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>
    );
  };

  const renderIndividual = (list: Trophy[]) => {
    if (list.length === 0) return null;
    return (
      <div>
        <p className="text-xs font-semibold text-slate-500 uppercase tracking-widest mb-3">Individual</p>
        <div className="bg-slate-900 border border-slate-800 rounded-2xl p-4 space-y-1.5">
          {list.map((t, i) => (
            <div key={i} className="flex items-baseline gap-2 flex-wrap">
              <span className="text-slate-300 text-sm">{t.name}</span>
              <span className="flex flex-wrap gap-1">
                {t.years.map((y, yi) => (
                  <span key={`${y}-${yi}`} className="bg-slate-800 text-slate-400 text-xs px-1.5 py-0.5 rounded font-mono">
                    {y}
                  </span>
                ))}
              </span>
            </div>
          ))}
        </div>
      </div>
    );
  };

  const colCount = [club, intl, individual].filter((l) => l.length > 0).length;

  return (
    <section>
      <h2 className="text-xs font-semibold text-slate-500 uppercase tracking-widest mb-4">
        Honours
      </h2>
      <div className={`grid grid-cols-1 gap-6 ${colCount >= 3 ? "sm:grid-cols-3" : colCount === 2 ? "sm:grid-cols-2" : ""}`}>
        {renderTeamGroup("Club", club)}
        {renderTeamGroup("International", intl)}
        {renderIndividual(individual)}
      </div>
    </section>
  );
}

function PlayerPhoto({ src, name }: { src: string; name: string }) {
  const [error, setError] = useState(false);
  if (error) {
    return (
      <span className="text-4xl font-black text-slate-600">
        {name.split(" ").map((w) => w[0]).join("").slice(0, 2).toUpperCase()}
      </span>
    );
  }
  return <img src={src} alt={name} className="w-full h-full object-contain object-bottom" onError={() => setError(true)} />;
}
