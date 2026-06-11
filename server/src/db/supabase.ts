import { createClient, SupabaseClient } from "@supabase/supabase-js";
import ws from "ws";

let _client: SupabaseClient | null = null;

export function getClient(): SupabaseClient {
  if (!_client) {
    const url = process.env.SUPABASE_URL;
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!url || !key) {
      throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set in server/.env");
    }
    _client = createClient(url, key, {
      realtime: { transport: ws as any },
    });
  }
  return _client;
}
