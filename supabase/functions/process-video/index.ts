// Triggered by a Supabase Database Webhook on INSERT into public.videos,
// or by the daily quota-retry cron job (see schema.sql /
// retry_quota_exceeded_videos).
// Payload shape: { type: "INSERT"|"RETRY", table: "videos", record: {...} }

import { supabaseAdmin, corsHeaders } from "../_shared/supabaseAdmin.ts";
import { analyzeVideoWithGemini } from "../_shared/gemini.ts";
import { uploadVideoToYouTube, setThumbnail, categoryNameToId, QuotaExceededError } from "../_shared/youtube.ts";

const WEBHOOK_SHARED_SECRET = Deno.env.get("WEBHOOK_SHARED_SECRET");

function guessMimeType(filename: string) {
  const ext = filename.split(".").pop()?.toLowerCase();
  return ({ mp4: "video/mp4", mov: "video/quicktime", webm: "video/webm", mkv: "video/x-matroska" } as Record<string, string>)[ext || ""]
    || "video/mp4";
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders() });

  if (WEBHOOK_SHARED_SECRET) {
    const provided = req.headers.get("x-webhook-secret");
    if (provided !== WEBHOOK_SHARED_SECRET) {
      return new Response("Unauthorized", { status: 401 });
    }
  }

  const admin = supabaseAdmin();
  let videoId: string | undefined;

  try {
    const payload = await req.json();
    const record = payload.record ?? payload;
    videoId = record.id;
    const { filename, storage_path, thumbnail_path, visibility } = record;

    if (!videoId || !storage_path) throw new Error("Webhook payload missing id/storage_path");

    // Skip re-analyzing with Gemini on a quota retry if we already have
    // metadata from a previous attempt — only the YouTube upload step
    // needs to run again, which also avoids burning Gemini calls on a
    // problem that was never Gemini's fault.
    const alreadyAnalyzed = payload.type === "RETRY" && record.generated_title;

    let metadata: { title: string; description: string; hashtags: string[]; tags: string[]; category: string };
    const mimeType = guessMimeType(filename);
    let videoBytes: Uint8Array;

    if (alreadyAnalyzed) {
      metadata = {
        title: record.generated_title,
        description: record.generated_description,
        hashtags: record.hashtags || [],
        tags: record.tags || [],
        category: record.category
      };
      const { data: videoBlob, error: dlErr } = await admin.storage.from("incoming-videos").download(storage_path);
      if (dlErr) throw new Error(`Could not download video from storage: ${dlErr.message}`);
      videoBytes = new Uint8Array(await videoBlob.arrayBuffer());
    } else {
      await admin.from("videos").update({ status: "analyzing" }).eq("id", videoId);

      const { data: videoBlob, error: dlErr } = await admin.storage.from("incoming-videos").download(storage_path);
      if (dlErr) throw new Error(`Could not download video from storage: ${dlErr.message}`);
      videoBytes = new Uint8Array(await videoBlob.arrayBuffer());

      metadata = await analyzeVideoWithGemini(videoBytes, mimeType);

      await admin.from("videos").update({
        status: "analyzed",
        generated_title: metadata.title,
        generated_description: metadata.description,
        hashtags: metadata.hashtags,
        tags: metadata.tags,
        category: metadata.category
      }).eq("id", videoId);

      if (thumbnail_path) {
        const { data: thumbBlob } = await admin.storage.from("incoming-videos").download(thumbnail_path);
        if (thumbBlob) {
          const thumbBytes = new Uint8Array(await thumbBlob.arrayBuffer());
          const publicPath = `${videoId}.jpg`;
          await admin.storage.from("thumbnails-public").upload(publicPath, thumbBytes, {
            contentType: "image/jpeg",
            upsert: true
          });
          const { data: pub } = admin.storage.from("thumbnails-public").getPublicUrl(publicPath);
          await admin.from("videos").update({ thumbnail_public_url: pub.publicUrl }).eq("id", videoId);
        }
      }
    }

    // ---- Upload to YouTube (the only quota-sensitive step) ----
    await admin.from("videos").update({ status: "uploading" }).eq("id", videoId);

    const fullDescription = [metadata.description, "", metadata.hashtags.join(" ")].join("\n").trim();

    const { videoId: youtubeVideoId, url: youtubeUrl, actualPrivacyStatus } = await uploadVideoToYouTube({
      videoBytes,
      mimeType,
      title: metadata.title,
      description: fullDescription,
      tags: metadata.tags,
      categoryId: categoryNameToId(metadata.category),
      visibility: (visibility || "private") as "public" | "private" | "unlisted"
    });

    if (thumbnail_path) {
      const { data: thumbBlob } = await admin.storage.from("incoming-videos").download(thumbnail_path);
      if (thumbBlob) {
        await setThumbnail(youtubeVideoId, new Uint8Array(await thumbBlob.arrayBuffer()), "image/jpeg");
      }
    }

    await admin.from("videos").update({
      status: "uploaded",
      youtube_video_id: youtubeVideoId,
      youtube_url: youtubeUrl,
      visibility: actualPrivacyStatus // reflect what YouTube actually set, not just what we requested
    }).eq("id", videoId);

    await admin.from("upload_history").insert({
      video_id: videoId,
      event: "success",
      message: `Uploaded to YouTube as ${youtubeUrl} (${actualPrivacyStatus})`
    });

    await admin.storage.from("incoming-videos").remove([storage_path]);

    return new Response(JSON.stringify({ ok: true, youtubeUrl }), {
      headers: { ...corsHeaders(), "Content-Type": "application/json" }
    });
  } catch (err) {
    console.error("process-video failed", err);

    if (videoId) {
      if (err instanceof QuotaExceededError) {
        // Not a hard failure: leave the source file in storage and the
        // analyzed metadata in place, mark it for the daily auto-retry
        // (see retry_quota_exceeded_videos), and record exactly which of
        // the three quota types it was.
        await admin.from("videos").update({
          status: "quota_exceeded",
          error_message: `[${err.kind}] ${err.message}`
        }).eq("id", videoId);

        await admin.from("upload_history").insert({
          video_id: videoId,
          event: "failure",
          message: `Quota hit (${err.kind}): ${err.message} — will retry automatically.`
        });
      } else {
        await admin.from("videos").update({
          status: "failed",
          error_message: String(err.message || err)
        }).eq("id", videoId);

        await admin.from("upload_history").insert({
          video_id: videoId,
          event: "failure",
          message: String(err.message || err)
        });
      }
    }

    return new Response(JSON.stringify({ ok: false, error: String(err.message || err) }), {
      status: err instanceof QuotaExceededError ? 200 : 500,
      headers: { ...corsHeaders(), "Content-Type": "application/json" }
    });
  }
});
