import { useState, useCallback } from "react";
import type { Team } from "../types";

const LS_KEY = "ss_favourites";

function load(): Team[] {
  try { return JSON.parse(localStorage.getItem(LS_KEY) ?? "[]"); } catch { return []; }
}

export function useFavourites() {
  const [favourites, setFavourites] = useState<Team[]>(load);

  const isFavourite = useCallback(
    (id: number) => favourites.some((t) => t.id === id),
    [favourites]
  );

  const toggleFavourite = useCallback((team: Team) => {
    setFavourites((prev) => {
      const next = prev.some((t) => t.id === team.id)
        ? prev.filter((t) => t.id !== team.id)
        : [...prev, team];
      localStorage.setItem(LS_KEY, JSON.stringify(next));
      return next;
    });
  }, []);

  return { favourites, isFavourite, toggleFavourite };
}
