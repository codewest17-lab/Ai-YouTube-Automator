// Shared across Edge Functions. Uses the service_role key, which is only
// ever available as a server-side secret (SUPABASE_SERVICE_ROLE_KEY) — it
// is never sent to the app and bypasses Row Level Security, which is exactly
// why only Edge Functions, never the client, should ever use it.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

export function supabaseAdmin() {
  const url = Deno.env.get("SUPABASE_URL")!;
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  return createClient(url, serviceKey, {
    auth: { persistSession: false }
  });
}

export function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type"
  };
}
