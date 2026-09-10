package com.ajet.youtubeuploader;

// Copy this file to: android/app/src/main/java/com/ajet/youtubeuploader/VideoUploadWorker.java
//
// This is the ONLY native code that talks to the network. It only ever
// calls two things, both with the public anon key:
//   1. create-upload-url  (Edge Function) -> a short-lived signed PUT URL
//   2. register_video     (Postgres RPC, via PostgREST)
// It never sees a Gemini key, a YouTube secret, or the Supabase
// service_role key — those exist only inside Edge Function secrets.

import android.app.NotificationManager;
import android.content.Context;
import android.os.Build;

import androidx.annotation.NonNull;
import androidx.core.app.NotificationCompat;
import androidx.work.Data;
import androidx.work.Worker;
import androidx.work.WorkerParameters;

import org.json.JSONObject;

import java.io.File;
import java.io.FileInputStream;
import java.io.IOException;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;

public class VideoUploadWorker extends Worker {

    public static final String KEY_VIDEO_PATH = "videoPath";
    public static final String KEY_THUMB_PATH = "thumbPath";
    public static final String KEY_WATCH_DIR = "watchDir";

    // Fill these in (or better, read them from BuildConfig / a gitignored
    // secrets.properties — see README "Native config" section). The anon
    // key is public-safe: every table/bucket it touches is locked down by
    // RLS + the create-upload-url function, per schema.sql.
    private static final String SUPABASE_URL = "https://waxmerlwcvdurhpiggrz.supabase.co";
    private static final String SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6IndheG1lcmx3Y3ZkdXJocGlnZ3J6Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODg5ODQyNTYsImV4cCI6MjEwNDU2MDI1Nn0.KUMb7EdJEgQFkKN_In4K8RUbql4OKA73oSZQzsEbTBY";

    public VideoUploadWorker(@NonNull Context context, @NonNull WorkerParameters params) {
        super(context, params);
    }

    @NonNull
    @Override
    public Result doWork() {
        Data input = getInputData();
        String videoPath = input.getString(KEY_VIDEO_PATH);
        String thumbPath = input.getString(KEY_THUMB_PATH);
        String watchDirPath = input.getString(KEY_WATCH_DIR);

        File videoFile = new File(videoPath);
        if (!videoFile.exists()) return Result.failure();

        try {
            String videoStoragePath = uploadOne(videoFile, "video");
            String thumbStoragePath = null;
            if (thumbPath != null) {
                File thumbFile = new File(thumbPath);
                if (thumbFile.exists()) {
                    thumbStoragePath = uploadOne(thumbFile, "thumbnail");
                }
            }

            registerVideo(videoFile.getName(), videoStoragePath, thumbStoragePath);

            moveToSubfolder(videoFile, watchDirPath, "Uploaded");
            if (thumbPath != null) moveToSubfolder(new File(thumbPath), watchDirPath, "Uploaded");

            notify("Queued: " + videoFile.getName(), "Sent for AI analysis and YouTube upload.");
            return Result.success();

        } catch (Exception e) {
            notify("Upload failed: " + videoFile.getName(), String.valueOf(e.getMessage()));
            if (getRunAttemptCount() < 5) {
                return Result.retry();
            }
            moveToSubfolder(videoFile, watchDirPath, "Failed");
            return Result.failure();
        }
    }

    /** Requests a signed URL from create-upload-url, then PUTs the raw file bytes to it. */
    private String uploadOne(File file, String kind) throws IOException, org.json.JSONException {
        JSONObject body = new JSONObject();
        body.put("filename", file.getName());
        body.put("kind", kind);

        JSONObject urlResponse = postJson(SUPABASE_URL + "/functions/v1/create-upload-url", body);
        String uploadUrl = urlResponse.getString("uploadUrl");
        String storagePath = urlResponse.getString("path");

        HttpURLConnection conn = (HttpURLConnection) new URL(uploadUrl).openConnection();
        conn.setRequestMethod("PUT");
        conn.setDoOutput(true);
        conn.setRequestProperty("Content-Type", kind.equals("thumbnail") ? "image/jpeg" : guessMime(file.getName()));
        conn.setRequestProperty("apikey", SUPABASE_ANON_KEY);
        conn.setRequestProperty("Authorization", "Bearer " + SUPABASE_ANON_KEY);
        conn.setFixedLengthStreamingMode(file.length());

        try (OutputStream out = conn.getOutputStream(); FileInputStream in = new FileInputStream(file)) {
            byte[] buffer = new byte[64 * 1024];
            int read;
            while ((read = in.read(buffer)) != -1) out.write(buffer, 0, read);
        }

        int code = conn.getResponseCode();
        if (code < 200 || code >= 300) {
            throw new IOException("Signed upload PUT failed with HTTP " + code);
        }
        conn.disconnect();
        return storagePath;
    }

    /** Calls the register_video Postgres function via PostgREST RPC. */
    private void registerVideo(String filename, String storagePath, String thumbStoragePath) throws IOException, org.json.JSONException {
        JSONObject body = new JSONObject();
        body.put("p_filename", filename);
        body.put("p_storage_path", storagePath);
        if (thumbStoragePath != null) body.put("p_thumbnail_path", thumbStoragePath);

        postJson(SUPABASE_URL + "/rest/v1/rpc/register_video", body);
    }

    private JSONObject postJson(String urlStr, JSONObject body) throws IOException, org.json.JSONException {
        HttpURLConnection conn = (HttpURLConnection) new URL(urlStr).openConnection();
        conn.setRequestMethod("POST");
        conn.setDoOutput(true);
        conn.setRequestProperty("Content-Type", "application/json");
        conn.setRequestProperty("apikey", SUPABASE_ANON_KEY);
        conn.setRequestProperty("Authorization", "Bearer " + SUPABASE_ANON_KEY);

        byte[] payload = body.toString().getBytes(StandardCharsets.UTF_8);
        conn.setFixedLengthStreamingMode(payload.length);
        try (OutputStream out = conn.getOutputStream()) {
            out.write(payload);
        }

        int code = conn.getResponseCode();
        java.io.InputStream stream = (code >= 200 && code < 300) ? conn.getInputStream() : conn.getErrorStream();
        String responseText = new String(stream.readAllBytes(), StandardCharsets.UTF_8);
        conn.disconnect();

        if (code < 200 || code >= 300) {
            throw new IOException("Request to " + urlStr + " failed with HTTP " + code + ": " + responseText);
        }
        if (responseText.isEmpty()) return new JSONObject();
        return responseText.trim().startsWith("[")
            ? new JSONObject().put("result", responseText)
            : new JSONObject(responseText);
    }

    private void moveToSubfolder(File file, String watchDirPath, String subfolder) {
        try {
            File target = new File(new File(watchDirPath, subfolder), file.getName());
            Files.move(file.toPath(), target.toPath(), java.nio.file.StandardCopyOption.REPLACE_EXISTING);
        } catch (IOException e) {
            // Non-fatal — the upload itself already succeeded or failed independently.
        }
    }

    private String guessMime(String filename) {
        String lower = filename.toLowerCase();
        if (lower.endsWith(".mov")) return "video/quicktime";
        if (lower.endsWith(".webm")) return "video/webm";
        if (lower.endsWith(".mkv")) return "video/x-matroska";
        return "video/mp4";
    }

    private void notify(String title, String text) {
        Context ctx = getApplicationContext();
        String channelId = "ajet_upload_events";
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            NotificationManager manager = ctx.getSystemService(NotificationManager.class);
            android.app.NotificationChannel channel = new android.app.NotificationChannel(
                channelId, "Ajet upload events", NotificationManager.IMPORTANCE_DEFAULT);
            manager.createNotificationChannel(channel);
        }
        NotificationCompat.Builder builder = new NotificationCompat.Builder(ctx, channelId)
            .setContentTitle(title)
            .setContentText(text)
            .setSmallIcon(android.R.drawable.ic_menu_upload)
            .setAutoCancel(true);
        NotificationManager manager = (NotificationManager) ctx.getSystemService(Context.NOTIFICATION_SERVICE);
        manager.notify((int) System.currentTimeMillis(), builder.build());
    }
}
