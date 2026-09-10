// Google redirects here with ?code=... after the user approves consent.
// We exchange the code for tokens using the client_secret (a server-only
// secret) and store only the refresh_token / access_token server-side in
// oauth_tokens — a table the app's anon key can never read.

import { supabaseAdmin } from "../_shared/supabaseAdmin.ts";
import { fetchOwnChannel } from "../_shared/youtube.ts";

const TOKEN_URL = "https://oauth2.googleapis.com/token";

function htmlPage(message: string, ok: boolean) {
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Ajet YouTube Uploader</title>
<style>
  body { font-family: -apple-system, sans-serif; background:#14161A; color:#EDEEF0;
         display:flex; align-items:center; justify-content:center; height:100vh; margin:0; }
  .card { text-align:center; padding:32px; }
  h1 { font-size: 18px; color: ${ok ? "#4FD1A5" : "#FF4B3E"}; }
  p { color:#8B9099; font-size: 14px; }
</style></head>
<body><div class="card"><h1>${ok ? "Connected" : "Something went wrong"}</h1><p>${message}</p>
<p>You can close this window and return to the app.</p></div></body></html>`;
}

Deno.serve(async (req) => {
  const url = new URL(req.url);
  const code = url.searchParams.get("code");
  const errorParam = url.searchParams.get("error");

  if (errorParam) {
    return new Response(htmlPage(`Google reported: ${errorParam}`, false), {
      headers: { "Content-Type": "text/html" }
    });
  }
  if (!code) {
    return new Response(htmlPage("No authorization code was received.", false), {
      headers: { "Content-Type": "text/html" }
    });
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const redirectUri = `${supabaseUrl}/functions/v1/youtube-oauth-callback`;

    const tokenRes = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: Deno.env.get("GOOGLE_CLIENT_ID")!,
        client_secret: Deno.env.get("GOOGLE_CLIENT_SECRET")!,
        code,
        grant_type: "authorization_code",
        redirect_uri: redirectUri
      })
    });

    if (!tokenRes.ok) throw new Error(`Token exchange failed: ${tokenRes.status} ${await tokenRes.text()}`);
    const tokens = await tokenRes.json();

    if (!tokens.refresh_token) {
      throw new Error("Google did not return a refresh token. Revoke prior access at " +
        "https://myaccount.google.com/permissions and try connecting again.");
    }

    const admin = supabaseAdmin();
    const expiry = new Date(Date.now() + tokens.expires_in * 1000).toISOString();

    await admin.from("oauth_tokens").upsert({
      id: 1,
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token,
      token_expiry: expiry,
      scope: tokens.scope
    });

    const channel = await fetchOwnChannel(tokens.access_token);

    await admin.from("settings").update({
      youtube_connected: true,
      youtube_channel_id: channel.id ?? null,
      youtube_channel_title: channel.title ?? "Connected"
    }).eq("id", 1);

    return new Response(htmlPage(`Linked to ${channel.title || "your channel"}.`, true), {
      headers: { "Content-Type": "text/html" }
    });
  } catch (err) {
    console.error("youtube-oauth-callback failed", err);
    return new Response(htmlPage(String(err.message || err), false), {
      headers: { "Content-Type": "text/html" }
    });
  }
});
