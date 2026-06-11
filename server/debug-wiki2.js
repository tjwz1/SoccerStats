require('dotenv').config();
const fetch = require('node-fetch');

async function testSearch(name) {
  // Try different search strategies
  const urls = [
    `https://en.wikipedia.org/w/api.php?action=opensearch&search=${encodeURIComponent(name)}&limit=5&format=json`,
    `https://en.wikipedia.org/w/api.php?action=opensearch&search=${encodeURIComponent(name + ' footballer')}&limit=5&format=json`,
  ];

  console.log('\nSearching:', JSON.stringify(name));
  for (const url of urls) {
    try {
      const res = await fetch(url, {
        signal: AbortSignal.timeout(10000),
        headers: { 'User-Agent': 'Mozilla/5.0 SoccerStatsApp/1.0 (educational project)' }
      });
      console.log('  Status:', res.status, res.statusText);
      const data = await res.json();
      console.log('  Results for', url.includes('footballer') ? 'WITH footballer' : 'WITHOUT footballer', ':', JSON.stringify(data[1]));
    } catch (e) {
      console.log('  Error:', e.message);
    }
  }
}

async function run() {
  await testSearch('Robert Lewandowski');
  await testSearch('Lamine Yamal');
}

run().catch(console.error);
