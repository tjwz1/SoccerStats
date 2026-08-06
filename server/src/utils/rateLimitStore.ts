import type { Store, Options, ClientRateLimitInfo } from "express-rate-limit";
import { getClient } from "../db/supabase";

// Shared rate-limit store backed by Supabase so counters are consistent across
// all Vercel function instances. Requires the migration in server/migrations/001_rate_limits.sql.
// Falls open on Supabase errors so a DB outage never blocks legitimate traffic.
export class SupabaseRateLimitStore implements Store {
  private windowMs: number;

  constructor(windowMs: number) {
    this.windowMs = windowMs;
  }

  init(options: Options): void {
    this.windowMs = options.windowMs;
  }

  async increment(key: string): Promise<ClientRateLimitInfo> {
    try {
      const { data, error } = await getClient()
        .rpc("rate_limit_increment", { p_key: key, p_window_ms: this.windowMs });

      if (error) throw error;
      const row = Array.isArray(data) ? data[0] : data;
      return {
        totalHits: (row?.hits as number) ?? 1,
        resetTime: row?.reset_time ? new Date(row.reset_time as string) : new Date(Date.now() + this.windowMs),
      };
    } catch {
      // Fail open: a store error should never block legitimate traffic
      return { totalHits: 0, resetTime: new Date(Date.now() + this.windowMs) };
    }
  }

  // Decrement is a best-effort no-op — the count being slightly high is acceptable
  // and safer than a broken atomic decrement causing under-counting.
  async decrement(_key: string): Promise<void> {}

  async resetKey(key: string): Promise<void> {
    try {
      await getClient().from("rate_limits").delete().eq("key", key);
    } catch {}
  }

  async resetAll(): Promise<void> {
    try {
      await getClient().from("rate_limits").delete().neq("key", "");
    } catch {}
  }
}
