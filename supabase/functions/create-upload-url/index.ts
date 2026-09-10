// POST { filename: string, kind?: "video" | "thumbnail" }
// Returns { path, token, signedUrl } for a one-time signed upload into the
// private "incoming-videos" bucket. Called with the ANON key (no secrets
// needed for this one), but only ever hands back a URL scoped to a single
// fresh path — it can't be used to browse or overwrite other files.

import { supabaseAdmin, corsHeaders } from "../_shared/supabaseAdmin.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders() });

  try {
    const { filename, kind } = await req.json();
    if (!filename) throw new Error("filename is required");

    const admin = supabaseAdmin();
    const safeName = String(filename).replace(/[^a-zA-Z0-9_.-]/g, "_");
    const folder = kind === "thumbnail" ? "thumbnails" : "videos";
    const path = `${folder}/${crypto.randomUUID()}-${safeName}`;

    const { data, error } = await admin.storage.from("incoming-videos").createSignedUploadUrl(path);
    if (error) throw error;

    // data.signedUrl is a path like "/object/upload/sign/incoming-videos/videos/xyz?token=...".
    // We return the full absolute URL so native code can PUT to it directly
    // with no Supabase SDK required on the Android side.
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const absoluteUploadUrl = data.signedUrl.startsWith("http")
      ? data.signedUrl
      : `${supabaseUrl}/storage/v1${data.signedUrl}`;

    return new Response(JSON.stringify({ path, token: data.token, uploadUrl: absoluteUploadUrl }), {
      headers: { ...corsHeaders(), "Content-Type": "application/json" }
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: String(err.message || err) }), {
      status: 400,
      headers: { ...corsHeaders(), "Content-Type": "application/json" }
    });
  }
});
