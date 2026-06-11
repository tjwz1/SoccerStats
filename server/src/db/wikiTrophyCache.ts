import { getCached, setCached, FOREVER_TTL_MS } from "./apiCache";

export interface Trophy {
  name: string;
  team: string;
  category: "club" | "international" | "individual";
  years: string[];
}

const key = (playerId: number) => `wiki_honours:${playerId}`;

export async function getWikiTrophies(playerId: number): Promise<Trophy[] | null> {
  const cached = await getCached(key(playerId));
  if (!cached) return null;
  const trophies = (cached as any).trophies as Trophy[];
  // Treat empty arrays as cache miss — allows re-fetch if a previous attempt was interrupted
  return trophies && trophies.length > 0 ? trophies : null;
}

export async function setWikiTrophies(
  playerId: number,
  trophies: Trophy[]
): Promise<void> {
  await setCached(key(playerId), { trophies }, FOREVER_TTL_MS);
}
