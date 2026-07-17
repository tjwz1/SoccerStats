import { Routes, Route } from "react-router-dom";
import MainView from "./pages/MainView";
import PlayerPage from "./pages/PlayerPage";
import { ThemeProvider } from "./contexts/ThemeContext";
import { LiveMatchesProvider } from "./contexts/LiveMatchesContext";
import { useServerWatchdog } from "./hooks/useServerWatchdog";

function NotFound() {
  return (
    <div className="flex items-center justify-center min-h-screen text-slate-400 dark:text-slate-500 text-sm">
      Page not found
    </div>
  );
}

function AppInner() {
  useServerWatchdog();
  return (
    <Routes>
      <Route path="/" element={<MainView />} />
      <Route path="/competitions/:code" element={<MainView />} />
      <Route path="/competitions/:code/teams/:teamId" element={<MainView />} />
      <Route path="/player/:id" element={<PlayerPage />} />
      <Route path="*" element={<NotFound />} />
    </Routes>
  );
}

export default function App() {
  return (
    <ThemeProvider>
      <LiveMatchesProvider>
        <AppInner />
      </LiveMatchesProvider>
    </ThemeProvider>
  );
}
