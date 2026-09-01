/**
 * Preview the News "Overview" digest pipeline for one team: fetch the Google News
 * RSS feed, scrape article bodies, and print the OLD heuristic digest next to the
 * NEW AI-generated digest for eyeballing.
 *
 * Usage (from server/):
 *   npx ts-node --project scripts/tsconfig.json --transpile-only scripts/preview-digest.ts "Arsenal"
 *
 * Without a real GEMINI_API_KEY the AI call fails and the script reports the
 * heuristic fallback instead of crashing.
 */
import { config } from "dotenv";
import path from "path";
config({ path: path.resolve(__dirname, "../.env") });

import {
  fetchRssArticles,
  fetchArticleBodies,
  buildDigestInput,
  generateDigest,
  type NewsArticle,
} from "../src/services/newsService";
import { summarizeNews } from "../src/services/aiSummary";
import { resolveGoogleNewsUrls } from "../src/services/googleNewsUrl";

const DAY_MS = 24 * 60 * 60 * 1000;

function windowArticles(data: NewsArticle[]): { recent: NewsArticle[]; widened: boolean } {
  let recent = data.filter((a) => Date.parse(a.publishedAt) >= Date.now() - DAY_MS);
  if (recent.length >= 3) return { recent, widened: false };
  recent = data.filter((a) => Date.parse(a.publishedAt) >= Date.now() - 2 * DAY_MS);
  return { recent, widened: true };
}

function printBullets(label: string, bullets: string[]) {
  console.log(`\n--- ${label} ---`);
  if (!bullets.length) {
    console.log("(empty)");
    return;
  }
  for (const b of bullets) console.log(` • ${b}`);
}

async function main() {
  const teamName = process.argv[2] || "Arsenal";
  console.log(`Preview digest for: ${teamName}\n`);

  const { data, descByUrl, rawCount } = await fetchRssArticles(teamName);
  console.log(`# RSS <item>s parsed:        ${rawCount}`);
  console.log(`# articles after dedupe:     ${data.length}`);

  if (data.length === 0) {
    console.log("\nNo articles — nothing to summarise (digest would be []).");
    process.exit(0);
  }

  const { recent, widened } = windowArticles(data);
  console.log(`# within 24h window:         ${recent.length}${widened ? "  (widened to 48h)" : ""}`);

  if (recent.length === 0) {
    printBullets("NEW AI digest", [
      `Quiet news day — no major ${teamName} stories in the last 24 hours.`,
    ]);
    printBullets("OLD heuristic digest", generateDigest(data, teamName));
    process.exit(0);
  }

  const resolvedByUrl = await resolveGoogleNewsUrls(recent.map((a) => a.url));
  console.log(`# Google News URLs resolved: ${resolvedByUrl.size} / ${recent.length}`);

  const bodies = await fetchArticleBodies([...new Set(resolvedByUrl.values())]);
  console.log(`# article bodies scraped:    ${bodies.size} / ${recent.length}`);

  const joined = buildDigestInput(recent, bodies, descByUrl, resolvedByUrl);
  console.log(`# LLM input size:            ${joined.split(/\s+/).filter(Boolean).length} words`);

  printBullets("OLD heuristic digest", generateDigest(data, teamName));

  try {
    const aiDigest = await summarizeNews(teamName, joined);
    printBullets("NEW AI digest", aiDigest);
  } catch (e) {
    console.log(`\n--- NEW AI digest ---`);
    console.log(`AI call failed: ${(e as Error).message}`);
    console.log(`→ endpoint would fall back to the OLD heuristic digest above.`);
  }

  process.exit(0);
}

main().catch((e) => {
  console.error("Fatal:", e);
  process.exit(1);
});
