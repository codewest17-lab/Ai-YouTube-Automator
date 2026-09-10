// GET this URL from the app (opened in the system browser via the
// Capacitor Browser plugin). Redirects straight into Google's consent
// screen. GOOGLE_CLIENT_ID is a server secret; the app never sees it.

const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const SCOPES = [
  "https://www.googleapis.com/auth/youtube.upload",
  "https://www.googleapis.com/auth/youtube.readonly"
].join(" ");

Deno.serve((req) => {
  const clientId = Deno.env.get("GOOGLE_CLIENT_ID")!;
  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const redirectUri = `${supabaseUrl}/functions/v1/youtube-oauth-callback`;

  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: SCOPES,
    access_type: "offline",   // required to receive a refresh_token
    prompt: "consent"         // forces a refresh_token even on repeat connects
  });

  return Response.redirect(`${GOOGLE_AUTH_URL}?${params.toString()}`, 302);
});
