import { useState, useEffect, useRef } from "react";
import { useNavigate, useLocation, useParams } from "react-router-dom";
import type { Player, Team, LineupData, Competition, ClubTrophy } from "../types";
import { useApi, sessionGet, sessionSet } from "../hooks/useApi";
import { useFavourites } from "../hooks/useFavourites";
import { useTheme } from "../contexts/ThemeContext";
import TeamSearch from "../components/TeamSearch";
import PlayerTooltip from "../components/PlayerTooltip";
import FixtureCalendar from "../components/FixtureCalendar";
import SquadView from "./team-views/SquadView";
import HonoursView from "./team-views/HonoursView";
import ScheduleView from "./team-views/ScheduleView";
import NewsView from "./team-views/NewsView";
import CompetitionLanding from "./CompetitionLanding";

function readSession<T>(key: string): T | null {
  try { return JSON.parse(sessionStorage.getItem(key) ?? "null") as T; } catch { return null; }
}

// ── View registry ─────────────────────────────────────────────────────────────
const VIEW_REGISTRY = [
  { id: "squad",    label: "Squad",    maxWidth: "max-w-4xl", preload: false },
  { id: "honours",  label: "Honours",  maxWidth: "max-w-4xl", preload: true  },
  { id: "schedule", label: "Schedule", maxWidth: "max-w-2xl", preload: false },
  { id: "news",     label: "News",     maxWidth: "max-w-2xl", preload: false },
] as const;

type ViewId = typeof VIEW_REGISTRY[number]["id"];

export default function MainView() {
  const navigate = useNavigate();
  const location = useLocation();
  const { code: urlCode, teamId: urlTeamId } = useParams<{ code?: string; teamId?: string }>();
  const { theme, toggle: toggleTheme } = useTheme();
  const [selectedComp, setSelectedComp] = useState<Competition | null>(() => readSession("ss_comp"));
  const [selectedTeam, setSelectedTeam] = useState<Team | null>(() => readSession("ss_team"));
  const [selectedSeason, setSelectedSeason] = useState<number | null>(null);
  const { favourites, isFavourite, toggleFavourite } = useFavourites();
  const [hoveredPlayer, setHoveredPlayer] = useState<{ player: Player; x: number; y: number } | null>(null);
  const VALID_VIEWS = VIEW_REGISTRY.map((v) => v.id);
  const [view, setView] = useState<ViewId>(() => {
    const saved = sessionStorage.getItem("ss_view");
    return (VALID_VIEWS.includes(saved as ViewId) ? saved : "squad") as ViewId;
  });

  useEffect(() => {
    if (selectedComp) sessionStorage.setItem("ss_comp", JSON.stringify(selectedComp));
  }, [selectedComp]);

  useEffect(() => {
    if (selectedTeam) sessionStorage.setItem("ss_team", JSON.stringify(selectedTeam));
    else sessionStorage.removeItem("ss_team");
  }, [selectedTeam]);

  useEffect(() => {
    sessionStorage.setItem("ss_view", view);
  }, [view]);

  // URL → state: auto-select competition when navigating directly to /competitions/:code
  const { data: competitions } = useApi<Competition[]>("/api/competitions");
  // Tracks which urlCode is currently being applied to state so state→URL doesn't
  // clobber the URL before the URL→state effect finishes.
  const urlTransitionPending = useRef<string | null>(null);
  useEffect(() => {
    if (!urlCode || !competitions?.length) return;
    if (selectedComp?.code === urlCode) return;
    const comp = competitions.find((c) => c.code === urlCode);
    if (comp) {
      urlTransitionPending.current = urlCode;
      setSelectedComp(comp);
      setSelectedTeam(null);
    }
  }, [urlCode, competitions?.length]); // eslint-disable-line react-hooks/exhaustive-deps

  // URL → state: restore team from sessionStorage when navigating to /competitions/:code/teams/:id
  useEffect(() => {
    if (!urlTeamId) return;
    const id = parseInt(urlTeamId, 10);
    const saved = readSession<Team>("ss_team");
    if (saved?.id === id && !selectedTeam) setSelectedTeam(saved);
  }, [urlTeamId]); // eslint-disable-line react-hooks/exhaustive-deps

  // State → URL: keep address bar in sync so links are shareable.
  // Only blocked during an active URL→state transition (while state hasn't caught up yet).
  useEffect(() => {
    // URL→state is in flight: state hasn't applied the new urlCode yet — wait.
    if (urlTransitionPending.current !== null && selectedComp?.code !== urlTransitionPending.current) return;
    urlTransitionPending.current = null;
    // URL has a team but state hasn't restored it yet — wait.
    if (urlTeamId && selectedComp && !selectedTeam) return;
    const target = !selectedComp ? "/"
      : !selectedTeam ? `/competitions/${selectedComp.code}`
      : `/competitions/${selectedComp.code}/teams/${selectedTeam.id}`;
    if (location.pathname !== target) navigate(target, { replace: true });
  }, [selectedComp?.code, selectedTeam?.id, urlCode, urlTeamId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Handle team navigation from match card team name buttons
  useEffect(() => {
    const s = location.state as { navTeam?: Team; navComp?: Competition; navView?: string } | null;
    if (!s?.navTeam) return;
    setSelectedTeam(s.navTeam);
    if (s.navComp) setSelectedComp(s.navComp);
    setView((s.navView as ViewId | undefined) ?? "squad");
    setHoveredPlayer(null);
    navigate("/", { replace: true, state: null });
  }, [location.key]); // eslint-disable-line react-hooks/exhaustive-deps

  const { data: lineup, loading: lineupLoading } = useApi<LineupData>(
    selectedTeam
      ? `/api/teams/${selectedTeam.id}/lineup${selectedComp ? `?competition=${selectedComp.code}` : ""}`
      : null
  );

  // When the lineup resolves its competition (server checks runningCompetitions), auto-correct
  // selectedComp if it's missing or points at the wrong league. This fixes favourites that have
  // no stored competitionCode and any other case where the wrong league is active.
  useEffect(() => {
    const code = lineup?.competitionCode;
    if (!code || code === selectedComp?.code) return;
    const matched = competitions?.find((c) => c.code === code);
    if (matched) setSelectedComp(matched);
  }, [lineup?.competitionCode]); // eslint-disable-line react-hooks/exhaustive-deps

  // Preload honours immediately on team selection so switching to Honours is instant.
  const { loading: honoursPreloading } = useApi<ClubTrophy[]>(
    selectedTeam
      ? `/api/teams/${selectedTeam.id}/honours?name=${encodeURIComponent(selectedTeam.name)}`
      : null
  );

  // Preload schedule in the background when a team is selected so the Schedule tab opens instantly.
  useEffect(() => {
    if (!selectedTeam || !selectedComp) return;
    const url = `/api/teams/${selectedTeam.id}/schedule?competition=${selectedComp.code}&name=${encodeURIComponent(selectedTeam.name)}`;
    if (sessionGet(url)) return; // already cached
    fetch(url)
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => { if (data) sessionSet(url, data); })
      .catch(() => {});
  }, [selectedTeam?.id, selectedComp?.code]); // eslint-disable-line react-hooks/exhaustive-deps

  const activeViewDef = VIEW_REGISTRY.find((v) => v.id === view) ?? VIEW_REGISTRY[0];

  function handleSelectTeam(team: Team) {
    setSelectedTeam(team);
    setHoveredPlayer(null);
  }

  function handlePlayerClick(player: Player) {
    if (!player.id) return; // id=0 = TM/wiki supplemented player, no career data
    navigate(`/player/${player.id}?competition=${selectedComp?.code ?? "PL"}`, {
      state: { player, teamName: selectedTeam?.name },
    });
  }

  function handleHover(player: Player | null, x: number, y: number) {
    setHoveredPlayer(player ? { player, x, y } : null);
  }

  function renderView() {
    if (!selectedTeam) return null;
    switch (view) {
      case "squad":
        return lineup
          ? <SquadView lineup={lineup} onPlayerClick={handlePlayerClick} onPlayerHover={handleHover} season={selectedSeason ?? undefined} />
          : lineupLoading
            ? <div className="flex justify-center py-20"><div className="w-6 h-6 border-2 border-slate-600 border-t-white rounded-full animate-spin" /></div>
            : null;
      case "honours":
        return <HonoursView teamId={selectedTeam.id} teamName={selectedTeam.name} />;
      case "schedule":
        return <ScheduleView teamId={selectedTeam.id} teamName={selectedTeam.name} competitionCode={selectedComp?.code ?? "PL"} season={selectedSeason ?? undefined} />;
      case "news":
        return <NewsView teamId={selectedTeam.id} teamName={selectedTeam.name} />;
    }
  }

  return (
    <div className="min-h-screen bg-slate-950 flex flex-col">
      {/* Header */}
      <header className="border-b border-slate-800 px-6 py-4 flex items-center gap-3">
        <button
          onClick={() => { setSelectedComp(null); setSelectedTeam(null); setSelectedSeason(null); setHoveredPlayer(null); }}
          title="Home"
          className="w-8 h-8 bg-green-600 rounded-lg flex items-center justify-center text-white font-bold text-sm hover:bg-green-500 transition-colors shrink-0"
        >
          SS
        </button>
        <h1 className="text-lg font-bold text-white">Soccer Stats</h1>
        {(selectedTeam || selectedComp) && (
          <span className="ml-2 text-sm flex items-center gap-1.5">
            <button
              onClick={() => { setSelectedComp(null); setSelectedTeam(null); setSelectedSeason(null); setHoveredPlayer(null); }}
              className="text-slate-500 hover:text-green-400 transition-colors"
            >
              Fixtures
            </button>
            {selectedComp && (
              <>
                <span className="text-slate-700">›</span>
                <button
                  onClick={() => { setSelectedTeam(null); setHoveredPlayer(null); }}
                  className={selectedTeam ? "text-slate-400 hover:text-green-400 transition-colors" : "text-slate-400 cursor-default"}
                >
                  {selectedComp.name}
                </button>
              </>
            )}
            {selectedTeam && (
              <>
                <span className="text-slate-700">›</span>
                <span className="text-white font-medium">{selectedTeam.name}</span>
                {selectedSeason && (
                  <span className="bg-slate-800 px-2 py-0.5 rounded text-xs font-mono text-slate-300">
                    {selectedSeason}
                  </span>
                )}
                {lineup?.formation && view === "squad" && !selectedSeason && (
                  <span className="bg-slate-800 px-2 py-0.5 rounded text-xs font-mono text-slate-300">
                    {lineup.formation}
                  </span>
                )}
              </>
            )}
          </span>
        )}
        {/* Theme toggle */}
        <button
          onClick={toggleTheme}
          title={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
          className="ml-auto p-1.5 rounded-lg text-slate-400 hover:text-white hover:bg-slate-800 transition-colors text-base leading-none"
        >
          {theme === "dark" ? "☀️" : "🌙"}
        </button>
      </header>

      <div className="flex flex-1 overflow-hidden">
        {/* Sidebar */}
        <aside className="w-72 border-r border-slate-800 px-4 py-5 flex flex-col overflow-y-auto shrink-0">
          <TeamSearch
            onSelectTeam={handleSelectTeam}
            selectedTeam={selectedTeam}
            selectedComp={selectedComp}
            onSelectComp={(c) => { setSelectedComp(c); setSelectedTeam(null); setSelectedSeason(null); setHoveredPlayer(null); }}
            selectedSeason={selectedSeason}
            onSelectSeason={setSelectedSeason}
            favourites={favourites}
            isFavourite={isFavourite}
            toggleFavourite={toggleFavourite}
          />
        </aside>

        {/* Main content */}
        <main className="flex-1 flex items-start justify-center p-6 overflow-auto">
          {!selectedTeam && !selectedComp && (
            <div className="w-full max-w-2xl">
              <FixtureCalendar
                onNavigateToTeam={(team, comp) => {
                  setSelectedComp(comp);
                  setSelectedTeam(team);
                  setSelectedSeason(null);
                  setHoveredPlayer(null);
                }}
                favouriteTeamIds={favourites.map((f) => f.id)}
              />
            </div>
          )}

          {!selectedTeam && selectedComp && (
            <div className="w-full max-w-3xl">
              <CompetitionLanding
                comp={selectedComp}
                onSelectTeam={handleSelectTeam}
                selectedSeason={selectedSeason}
                onSeasonChange={setSelectedSeason}
                isFavourite={isFavourite}
                toggleFavourite={toggleFavourite}
              />
            </div>
          )}

          {selectedTeam && (
            <div className={`w-full ${activeViewDef.maxWidth}`}>
              {/* Tab bar */}
              <div className="flex gap-1 mb-5 bg-slate-900 rounded-lg p-1 w-fit mx-auto">
                {VIEW_REGISTRY.map(({ id, label, preload }) => (
                  <button
                    key={id}
                    onClick={() => setView(id)}
                    className={`px-4 py-1.5 rounded-md text-xs font-medium transition-colors flex items-center gap-1.5 ${
                      view === id ? "bg-green-600 text-white" : "text-slate-400 hover:text-white"
                    }`}
                  >
                    {label}
                    {preload && honoursPreloading && (
                      <span className="w-1.5 h-1.5 rounded-full bg-current opacity-60 animate-pulse" />
                    )}
                  </button>
                ))}
              </div>

              {renderView()}
            </div>
          )}
        </main>
      </div>

      {hoveredPlayer && (
        <PlayerTooltip
          player={hoveredPlayer.player}
          anchorX={hoveredPlayer.x}
          anchorY={hoveredPlayer.y}
        />
      )}
    </div>
  );
}
