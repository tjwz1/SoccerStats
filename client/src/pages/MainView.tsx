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
    return (VALID_VIEWS.includes(saved as ViewId) ? saved : "schedule") as ViewId;
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

  // URL → state: restore team when navigating to /competitions/:code/teams/:id.
  // Tries sessionStorage first; falls back to fetching the competition's teams so
  // direct links and browser refreshes work even with a cold session.
  useEffect(() => {
    if (!urlTeamId || !selectedComp) return;
    const id = parseInt(urlTeamId, 10);
    if (selectedTeam?.id === id) return;
    const saved = readSession<Team>("ss_team");
    if (saved?.id === id) { setSelectedTeam(saved); return; }
    fetch(`/api/competitions/${selectedComp.code}/teams`)
      .then((r) => r.json())
      .then((teams: Team[]) => {
        const team = Array.isArray(teams) ? teams.find((t) => t.id === id) : null;
        if (team) setSelectedTeam(team);
      })
      .catch(() => {});
  }, [urlTeamId, selectedComp?.code]); // eslint-disable-line react-hooks/exhaustive-deps

  // State → URL: keep address bar in sync so links are shareable.
  // Only blocked during an active URL→state transition (while state hasn't caught up yet).
  useEffect(() => {
    // urlCode present but competitions not yet loaded — URL→state can't have fired yet, wait.
    if (urlCode && !competitions?.length) return;
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
    setView((s.navView as ViewId | undefined) ?? "schedule");
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

  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [headerSearchOpen, setHeaderSearchOpen] = useState(false);
  const [headerSearchQuery, setHeaderSearchQuery] = useState("");
  const [headerSearchResults, setHeaderSearchResults] = useState<Team[] | null>(null);
  const [headerSearchLoading, setHeaderSearchLoading] = useState(false);
  const activeViewDef = VIEW_REGISTRY.find((v) => v.id === view) ?? VIEW_REGISTRY[0];

  useEffect(() => {
    const q = headerSearchQuery.trim();
    if (q.length < 2) { setHeaderSearchResults(null); return; }
    const timer = setTimeout(async () => {
      setHeaderSearchLoading(true);
      try {
        const res = await fetch(`/api/teams/search?q=${encodeURIComponent(q)}`);
        setHeaderSearchResults(await res.json());
      } catch {
        setHeaderSearchResults([]);
      } finally {
        setHeaderSearchLoading(false);
      }
    }, 250);
    return () => clearTimeout(timer);
  }, [headerSearchQuery]);

  function closeHeaderSearch() {
    setHeaderSearchOpen(false);
    setHeaderSearchQuery("");
    setHeaderSearchResults(null);
  }

  function handleSelectTeam(team: Team) {
    setSelectedTeam(team);
    setView("schedule");
    setHoveredPlayer(null);
    setSidebarOpen(false);
    closeHeaderSearch();
    if (team.competitionCode) {
      const comp = competitions?.find((c) => c.code === team.competitionCode);
      if (comp) setSelectedComp(comp);
    }
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
      <header className="border-b border-slate-800 px-4 py-4 flex items-center gap-3 relative">
        <button
          onClick={() => setSidebarOpen((o) => !o)}
          aria-label="Toggle navigation"
          className="md:hidden p-1.5 rounded-lg text-slate-400 hover:text-white hover:bg-slate-800 transition-colors shrink-0"
        >
          <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h16" />
          </svg>
        </button>
        <button
          onClick={() => { setSelectedComp(null); setSelectedTeam(null); setSelectedSeason(null); setHoveredPlayer(null); setSidebarOpen(false); closeHeaderSearch(); }}
          title="Home"
          className="w-8 h-8 bg-green-600 rounded-lg flex items-center justify-center text-white font-bold text-sm hover:bg-green-500 transition-colors shrink-0"
        >
          SS
        </button>
        <h1 className="text-lg font-bold text-white hidden sm:block">Soccer Stats</h1>

        {/* Header search — shown when open */}
        {headerSearchOpen ? (
          <div className="flex-1 flex items-center gap-2 min-w-0">
            <input
              autoFocus
              type="text"
              value={headerSearchQuery}
              onChange={(e) => setHeaderSearchQuery(e.target.value)}
              placeholder="Search any team…"
              className="flex-1 min-w-0 bg-slate-800 border border-slate-600 rounded-lg px-3 py-1.5 text-sm text-white placeholder:text-slate-500 focus:outline-none focus:border-green-500"
            />
            <button
              onClick={closeHeaderSearch}
              className="p-1.5 rounded-lg text-slate-400 hover:text-white hover:bg-slate-800 transition-colors shrink-0"
              aria-label="Close search"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>
        ) : (
          <>
            {(selectedTeam || selectedComp) && (
              <span className="ml-1 text-sm flex items-center gap-1 min-w-0 overflow-hidden">
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
                    <span className="text-white font-medium truncate max-w-[120px] sm:max-w-none">{selectedTeam.name}</span>
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
          </>
        )}

        {/* Right-side controls: search icon (mobile) + theme toggle */}
        <div className={`flex items-center gap-1 shrink-0 ${headerSearchOpen ? "" : "ml-auto"}`}>
          {!headerSearchOpen && (
            <button
              onClick={() => setHeaderSearchOpen(true)}
              aria-label="Search teams"
              className="p-1.5 rounded-lg text-slate-400 hover:text-white hover:bg-slate-800 transition-colors md:hidden"
            >
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
              </svg>
            </button>
          )}
          <button
            onClick={toggleTheme}
            title={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
            className="p-1.5 rounded-lg text-slate-400 hover:text-white hover:bg-slate-800 transition-colors text-base leading-none"
          >
            {theme === "dark" ? "☀️" : "🌙"}
          </button>
        </div>

        {/* Search results dropdown */}
        {headerSearchOpen && (headerSearchLoading || (headerSearchResults !== null)) && (
          <div className="absolute top-full left-0 right-0 z-50 bg-slate-950 border-b border-slate-800 shadow-xl max-h-80 overflow-y-auto">
            {headerSearchLoading && (
              <div className="space-y-1 p-3">
                {Array.from({ length: 4 }).map((_, i) => (
                  <div key={i} className="h-10 bg-slate-800 rounded animate-pulse" />
                ))}
              </div>
            )}
            {!headerSearchLoading && headerSearchQuery.trim().length < 2 && (
              <p className="text-xs text-slate-500 text-center py-4">Type at least 2 characters</p>
            )}
            {!headerSearchLoading && headerSearchResults?.length === 0 && (
              <p className="text-xs text-slate-500 text-center py-4">
                No teams found for &ldquo;{headerSearchQuery}&rdquo;
              </p>
            )}
            {!headerSearchLoading && (headerSearchResults ?? []).map((team) => (
              <button
                key={team.id}
                onClick={() => handleSelectTeam(team)}
                className="w-full flex items-center gap-3 px-4 py-2.5 text-left text-sm transition-colors hover:bg-slate-800 border-b border-slate-800/60 last:border-0"
              >
                {team.crest ? (
                  <img src={team.crest} alt="" className="w-6 h-6 object-contain shrink-0" />
                ) : (
                  <div className="w-6 h-6 rounded-full bg-slate-700 flex items-center justify-center text-[10px] font-bold shrink-0 text-slate-300">
                    {team.tla?.slice(0, 2)}
                  </div>
                )}
                <div className="min-w-0">
                  <p className="text-white font-medium truncate">{team.shortName || team.name}</p>
                  <p className="text-slate-500 text-xs truncate">{team.name}</p>
                </div>
              </button>
            ))}
          </div>
        )}
      </header>

      <div className="flex flex-1 overflow-hidden relative">
        {/* Mobile overlay backdrop */}
        {sidebarOpen && (
          <div
            className="fixed inset-0 bg-black/60 z-30 md:hidden"
            onClick={() => setSidebarOpen(false)}
          />
        )}

        {/* Sidebar — drawer on mobile, static on md+ */}
        <aside className={`
          fixed top-0 left-0 h-full z-40 w-72 bg-slate-950 border-r border-slate-800 px-4 py-5 flex flex-col overflow-y-auto shrink-0
          transform transition-transform duration-200 ease-in-out
          ${sidebarOpen ? "translate-x-0" : "-translate-x-full"}
          md:relative md:top-auto md:left-auto md:z-auto md:translate-x-0 md:transition-none
        `}>
          {/* Mobile close button */}
          <button
            onClick={() => setSidebarOpen(false)}
            className="md:hidden self-end mb-3 p-1.5 rounded-lg text-slate-400 hover:text-white hover:bg-slate-800 transition-colors"
            aria-label="Close navigation"
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
          <TeamSearch
            onSelectTeam={handleSelectTeam}
            selectedTeam={selectedTeam}
            selectedComp={selectedComp}
            onSelectComp={(c) => { setSelectedComp(c); setSelectedTeam(null); setSelectedSeason(null); setHoveredPlayer(null); setSidebarOpen(false); }}
            selectedSeason={selectedSeason}
            onSelectSeason={setSelectedSeason}
            favourites={favourites}
            isFavourite={isFavourite}
            toggleFavourite={toggleFavourite}
          />
        </aside>

        {/* Main content */}
        <main className="flex-1 flex items-start justify-center p-3 sm:p-6 overflow-auto min-w-0">
          {!selectedTeam && !selectedComp && (
            <div className="w-full max-w-2xl">
              <FixtureCalendar
                onNavigateToTeam={(team, comp) => {
                  setSelectedComp(comp);
                  setSelectedTeam(team);
                  setSelectedSeason(null);
                  setHoveredPlayer(null);
                  setView("schedule");
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
