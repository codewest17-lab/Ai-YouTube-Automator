// ---------------------------------------------------------------------------
// Supabase client — frontend side.
//
// SECURITY NOTE:
// The "anon" key below is a PUBLIC key. It is meant to be shipped in a client.
// It has no power on its own — every table it can touch is locked down with
// Row Level Security (see supabase/schema.sql). It can never read
// oauth_tokens, never call Gemini, and never call the YouTube API directly.
// The Gemini API key, the YouTube OAuth client secret, and the Supabase
// service_role key all live ONLY inside Supabase Edge Function secrets and
// are never bundled into this app.
// ---------------------------------------------------------------------------

const SUPABASE_URL = "https://waxmerlwcvdurhpiggrz.supabase.co";
const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6IndheG1lcmx3Y3ZkdXJocGlnZ3J6Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODg5ODQyNTYsImV4cCI6MjEwNDU2MDI1Nn0.KUMb7EdJEgQFkKN_In4K8RUbql4OKA73oSZQzsEbTBY";

const supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: { persistSession: false }
});
