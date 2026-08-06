import { lazy, Suspense } from "react";
import { Routes, Route } from "react-router-dom";
import MainView from "./pages/MainView";
import { ThemeProvider } from "./contexts/ThemeContext";
import { LiveMatchesProvider } from "./contexts/LiveMatchesContext";
import { CompetitionsProvider } from "./contexts/CompetitionsContext";
import { AuthProvider } from "./contexts/AuthContext";
import { useServerWatchdog } from "./hooks/useServerWatchdog";

const PlayerPage = lazy(() => import("./pages/PlayerPage"));

function NotFound() {
  return (
    <div className="flex items-center justify-center min-h-screen text-slate-400 dark:text-slate-500 text-sm">
      Page not found
    </div>
  );
}

const PageSpinner = () => (
  <div className="flex items-center justify-center h-screen">
    <div className="w-6 h-6 border-2 border-slate-600 border-t-white rounded-full animate-spin" />
  </div>
);

function AppInner() {
  useServerWatchdog();
  return (
    <Routes>
      <Route path="/" element={<MainView />} />
      <Route path="/competitions/:code" element={<MainView />} />
      <Route path="/competitions/:code/teams/:teamId" element={<MainView />} />
      <Route
        path="/player/:id"
        element={
          <Suspense fallback={<PageSpinner />}>
            <PlayerPage />
          </Suspense>
        }
      />
      <Route path="*" element={<NotFound />} />
    </Routes>
  );
}

export default function App() {
  return (
    <AuthProvider>
      <ThemeProvider>
        <CompetitionsProvider>
          <LiveMatchesProvider>
            <AppInner />
          </LiveMatchesProvider>
        </CompetitionsProvider>
      </ThemeProvider>
    </AuthProvider>
  );
}
