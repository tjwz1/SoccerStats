import { Routes, Route } from "react-router-dom";
import MainView from "./pages/MainView";
import PlayerPage from "./pages/PlayerPage";
import { ThemeProvider } from "./contexts/ThemeContext";
import { LiveMatchesProvider } from "./contexts/LiveMatchesContext";

export default function App() {
  return (
    <ThemeProvider>
      <LiveMatchesProvider>
        <Routes>
          <Route path="/" element={<MainView />} />
          <Route path="/player/:id" element={<PlayerPage />} />
        </Routes>
      </LiveMatchesProvider>
    </ThemeProvider>
  );
}
