import { useState, useCallback } from "react";
import type { Team } from "../types";

export type FavTeam = Team & { competitionCode?: string };

const LS_KEY = "ss_favourites";

function load(): FavTeam[] {
  try { return JSON.parse(localStorage.getItem(LS_KEY) ?? "[]"); } catch { return []; }
}

export function useFavourites() {
  const [favourites, setFavourites] = useState<FavTeam[]>(load);

  const isFavourite = useCallback(
    (id: number) => favourites.some((t) => t.id === id),
    [favourites]
  );

  const toggleFavourite = useCallback((team: Team, competitionCode?: string) => {
    setFavourites((prev) => {
      const next = prev.some((t) => t.id === team.id)
        ? prev.filter((t) => t.id !== team.id)
        : [...prev, { ...team, competitionCode }];
      localStorage.setItem(LS_KEY, JSON.stringify(next));
      return next;
    });
  }, []);

  return { favourites, isFavourite, toggleFavourite };
}
