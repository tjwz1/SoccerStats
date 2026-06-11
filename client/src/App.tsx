import { Routes, Route } from "react-router-dom";
import MainView from "./pages/MainView";
import PlayerPage from "./pages/PlayerPage";
import { ThemeProvider } from "./contexts/ThemeContext";

export default function App() {
  return (
    <ThemeProvider>
      <Routes>
        <Route path="/" element={<MainView />} />
        <Route path="/player/:id" element={<PlayerPage />} />
      </Routes>
    </ThemeProvider>
  );
}
