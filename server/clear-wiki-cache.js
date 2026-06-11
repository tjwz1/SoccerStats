require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const ws = require('ws');

async function main() {
  const client = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
    realtime: { transport: ws },
  });
  const { error, count } = await client
    .from('api_cache')
    .delete({ count: 'exact' })
    .like('path', 'wiki_career:%');
  if (error) {
    console.error('Error:', error.message);
  } else {
    console.log(`Deleted ${count} wiki_career cache entries`);
  }
}

main().catch(console.error);
