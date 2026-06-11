require('dotenv').config();
const fetch = require('node-fetch');

const WIKI_HEADERS = {
  "User-Agent": "SoccerStatsApp/1.0 (educational project; node-fetch)",
};

async function testPlayer(name) {
  const url = `https://en.wikipedia.org/w/api.php?action=opensearch&search=${encodeURIComponent(name)}&limit=5&namespace=0&format=json`;
  try {
    const res = await fetch(url, { headers: WIKI_HEADERS, signal: AbortSignal.timeout(8000) });
    console.log(`  HTTP ${res.status}`);
    const data = await res.json();
    console.log(`  titles: ${JSON.stringify(data[1])}`);
  } catch (e) {
    console.log(`  ERROR: ${e.message}`);
  }
}

async function run() {
  const players = ['Robert Lewandowski', 'Kylian Mbappé', 'Lamine Yamal', 'Jude Bellingham', 'Vinicius Junior', 'Thibaut Courtois'];
  for (const p of players) {
    console.log(`\n${p}:`);
    await testPlayer(p);
    await new Promise(r => setTimeout(r, 1500));
  }
}

run().catch(console.error);
