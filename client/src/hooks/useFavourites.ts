import { useState, useCallback, useEffect, useRef } from "react";
import type { Team } from "../types";
import { useAuth } from "../contexts/AuthContext";
import { supabase } from "../lib/supabase";

export type FavTeam = Team & { competitionCode?: string };

const LS_KEY = "ss_favourites";

function loadLocal(): FavTeam[] {
  try { return JSON.parse(localStorage.getItem(LS_KEY) ?? "[]"); } catch { return []; }
}

function saveLocal(favs: FavTeam[]) {
  localStorage.setItem(LS_KEY, JSON.stringify(favs));
}

async function apiFetch(path: string, token: string, options?: RequestInit): Promise<Response> {
  const res = await fetch(`/api/favourites${path}`, {
    ...options,
    headers: { "Authorization": `Bearer ${token}`, "Content-Type": "application/json", ...options?.headers },
  });
  // On 401, attempt a token refresh and retry once.
  if (res.status === 401) {
    const { data } = await supabase.auth.refreshSession();
    if (data.session) {
      return fetch(`/api/favourites${path}`, {
        ...options,
        headers: { "Authorization": `Bearer ${data.session.access_token}`, "Content-Type": "application/json", ...options?.headers },
      });
    }
  }
  return res;
}

export function useFavourites() {
  const { session } = useAuth();
  const [favourites, setFavourites] = useState<FavTeam[]>(loadLocal);
  const migratedRef = useRef(false);

  // When a session becomes available, load server favourites and do a one-time localStorage migration.
  useEffect(() => {
    if (!session) return;
    const token = session.access_token;

    apiFetch("", token)
      .then((r) => r.ok ? r.json() as Promise<{ teamId: number; competitionCode: string }[]> : Promise.reject())
      .then((serverFavs) => {
        // One-time migration: push any local favourites not yet on the server.
        if (!migratedRef.current) {
          migratedRef.current = true;
          const local = loadLocal();
          const serverIds = new Set(serverFavs.map((f) => f.teamId));
          const toMigrate = local.filter((t) => !serverIds.has(t.id));
          for (const team of toMigrate) {
            apiFetch("", token, {
              method: "POST",
              body: JSON.stringify({ teamId: team.id, competitionCode: team.competitionCode ?? "PL" }),
            }).catch(() => {});
          }
        }
        // Merge: server is source of truth for IDs; local map fills in Team shape details.
        const localMap = new Map(loadLocal().map((t) => [t.id, t]));
        const merged: FavTeam[] = serverFavs.map((f) => {
          const local = localMap.get(f.teamId);
          return local
            ? { ...local, competitionCode: f.competitionCode }
            : { id: f.teamId, name: String(f.teamId), competitionCode: f.competitionCode } as FavTeam;
        });
        setFavourites(merged);
        saveLocal(merged);
      })
      .catch(() => {});
  }, [session?.access_token]); // eslint-disable-line react-hooks/exhaustive-deps

  const isFavourite = useCallback(
    (id: number) => favourites.some((t) => t.id === id),
    [favourites]
  );

  const toggleFavourite = useCallback((team: Team, competitionCode?: string) => {
    setFavourites((prev) => {
      const isAdding = !prev.some((t) => t.id === team.id);
      const next = isAdding
        ? [...prev, { ...team, competitionCode }]
        : prev.filter((t) => t.id !== team.id);
      saveLocal(next);

      if (session) {
        const token = session.access_token;
        if (isAdding) {
          apiFetch("", token, {
            method: "POST",
            body: JSON.stringify({ teamId: team.id, competitionCode: competitionCode ?? "PL" }),
          }).catch(() => {});
        } else {
          apiFetch(`/${team.id}`, token, { method: "DELETE" }).catch(() => {});
        }
      }

      return next;
    });
  }, [session]);

  return { favourites, isFavourite, toggleFavourite };
}
