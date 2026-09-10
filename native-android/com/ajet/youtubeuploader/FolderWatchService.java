package com.ajet.youtubeuploader;

// Copy this file to: android/app/src/main/java/com/ajet/youtubeuploader/FolderWatchService.java
//
// A foreground Service keeps running (with a persistent notification, as
// Android requires) even after the app's web view is closed. It uses
// FileObserver to catch new video files the moment a write finishes, then
// hands each one to VideoUploadWorker (WorkManager) so the actual upload
// survives process death and retries with backoff automatically.

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.Service;
import android.content.Intent;
import android.os.Build;
import android.os.Environment;
import android.os.FileObserver;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;

import androidx.annotation.Nullable;
import androidx.core.app.NotificationCompat;
import androidx.work.Data;
import androidx.work.OneTimeWorkRequest;
import androidx.work.WorkManager;

import java.io.File;
import java.util.HashMap;
import java.util.HashSet;
import java.util.Map;
import java.util.Set;

public class FolderWatchService extends Service {

    public static final String EXTRA_FOLDER_NAME = "folderName";
    private static final String CHANNEL_ID = "ajet_folder_watch";
    private static final int NOTIFICATION_ID = 1001;
    private static final long SETTLE_DELAY_MS = 2500; // wait for the file write to finish

    private static final Set<String> VIDEO_EXTENSIONS = new HashSet<>();
    static {
        VIDEO_EXTENSIONS.add("mp4");
        VIDEO_EXTENSIONS.add("mov");
        VIDEO_EXTENSIONS.add("mkv");
        VIDEO_EXTENSIONS.add("webm");
    }

    private FileObserver observer;
    private File watchedDir;
    private final Handler handler = new Handler(Looper.getMainLooper());
    private final Map<String, Runnable> pendingSettleChecks = new HashMap<>();
    private final Set<String> alreadyQueued = new HashSet<>();

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        String folderName = intent != null ? intent.getStringExtra(EXTRA_FOLDER_NAME) : "Ajet YouTube";
        if (folderName == null) folderName = "Ajet YouTube";

        startForeground(NOTIFICATION_ID, buildNotification("Watching \"" + folderName + "\" for new videos"));
        startWatching(folderName);
        return START_STICKY;
    }

    private void startWatching(String folderName) {
        File root = Environment.getExternalStorageDirectory();
        watchedDir = new File(root, folderName);
        if (!watchedDir.exists()) {
            watchedDir.mkdirs();
        }
        File uploadedDir = new File(watchedDir, "Uploaded");
        if (!uploadedDir.exists()) uploadedDir.mkdirs();
        File failedDir = new File(watchedDir, "Failed");
        if (!failedDir.exists()) failedDir.mkdirs();

        if (observer != null) observer.stopWatching();

        observer = new FileObserver(watchedDir.getAbsolutePath(), FileObserver.CLOSE_WRITE | FileObserver.MOVED_TO) {
            @Override
            public void onEvent(int event, @Nullable String path) {
                if (path == null) return;
                if (!isVideoFile(path)) return;
                scheduleSettleCheck(path);
            }
        };
        observer.startWatching();

        // Also do one pass immediately in case videos were already sitting
        // in the folder before the watcher started (e.g. after a reboot).
        File[] existing = watchedDir.listFiles();
        if (existing != null) {
            for (File f : existing) {
                if (f.isFile() && isVideoFile(f.getName())) {
                    scheduleSettleCheck(f.getName());
                }
            }
        }
    }

    /** Debounce: a copy/download can trigger multiple CLOSE_WRITE events; wait
     *  until the file size is stable for SETTLE_DELAY_MS before queuing it. */
    private void scheduleSettleCheck(String filename) {
        Runnable existing = pendingSettleChecks.get(filename);
        if (existing != null) handler.removeCallbacks(existing);

        Runnable check = new Runnable() {
            long lastSize = -1;

            @Override
            public void run() {
                File file = new File(watchedDir, filename);
                if (!file.exists()) return;
                long size = file.length();
                if (size == lastSize && size > 0) {
                    pendingSettleChecks.remove(filename);
                    enqueueUpload(file);
                } else {
                    lastSize = size;
                    handler.postDelayed(this, SETTLE_DELAY_MS);
                }
            }
        };
        pendingSettleChecks.put(filename, check);
        handler.postDelayed(check, SETTLE_DELAY_MS);
    }

    private void enqueueUpload(File videoFile) {
        String key = videoFile.getAbsolutePath();
        if (alreadyQueued.contains(key)) return;
        alreadyQueued.add(key);

        // A matching thumbnail sits alongside the video as
        // "<name-without-ext>_thumbnail.jpg" per the app's folder convention.
        String base = stripExtension(videoFile.getName());
        File thumb = new File(watchedDir, base + "_thumbnail.jpg");

        Data.Builder data = new Data.Builder()
            .putString(VideoUploadWorker.KEY_VIDEO_PATH, videoFile.getAbsolutePath())
            .putString(VideoUploadWorker.KEY_WATCH_DIR, watchedDir.getAbsolutePath());
        if (thumb.exists()) {
            data.putString(VideoUploadWorker.KEY_THUMB_PATH, thumb.getAbsolutePath());
        }

        OneTimeWorkRequest work = new OneTimeWorkRequest.Builder(VideoUploadWorker.class)
            .setInputData(data.build())
            .build();

        WorkManager.getInstance(getApplicationContext()).enqueue(work);
    }

    private boolean isVideoFile(String name) {
        int dot = name.lastIndexOf('.');
        if (dot < 0) return false;
        String ext = name.substring(dot + 1).toLowerCase();
        return VIDEO_EXTENSIONS.contains(ext);
    }

    private String stripExtension(String name) {
        int dot = name.lastIndexOf('.');
        return dot > 0 ? name.substring(0, dot) : name;
    }

    private Notification buildNotification(String text) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            NotificationManager manager = getSystemService(NotificationManager.class);
            NotificationChannel channel = new NotificationChannel(
                CHANNEL_ID, "Ajet folder watcher", NotificationManager.IMPORTANCE_LOW);
            manager.createNotificationChannel(channel);
        }
        return new NotificationCompat.Builder(this, CHANNEL_ID)
            .setContentTitle("Ajet YouTube Uploader")
            .setContentText(text)
            .setSmallIcon(android.R.drawable.ic_menu_upload)
            .setOngoing(true)
            .build();
    }

    @Override
    public void onDestroy() {
        if (observer != null) observer.stopWatching();
        super.onDestroy();
    }

    @Nullable
    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }
}
