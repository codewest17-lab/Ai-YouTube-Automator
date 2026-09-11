package com.ajet.youtubeuploader;

import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.provider.Settings;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

@CapacitorPlugin(name = "FolderWatcher")
public class FolderWatcherPlugin extends Plugin {

    @PluginMethod
    public void hasAllFilesAccess(PluginCall call) {
        JSObject ret = new JSObject();
        boolean granted;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            granted = Environment.isExternalStorageManager();
        } else {
            granted = true;
        }
        ret.put("granted", granted);
        call.resolve(ret);
    }

    @PluginMethod
    public void requestAllFilesAccess(PluginCall call) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            Intent intent = new Intent(Settings.ACTION_MANAGE_APP_ALL_FILES_ACCESS_PERMISSION);
            intent.setData(Uri.parse("package:" + getContext().getPackageName()));
            getActivity().startActivity(intent);
        }
        call.resolve();
    }

    @PluginMethod
    public void startWatching(PluginCall call) {
        String folderName = call.getString("folderName", "Ajet YouTube");
        Intent serviceIntent = new Intent(getContext(), FolderWatchService.class);
        serviceIntent.putExtra(FolderWatchService.EXTRA_FOLDER_NAME, folderName);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            getContext().startForegroundService(serviceIntent);
        } else {
            getContext().startService(serviceIntent);
        }

        java.io.File root = android.os.Environment.getExternalStoragePublicDirectory(
            android.os.Environment.DIRECTORY_DOWNLOADS);
        java.io.File watchedDir = new java.io.File(root, folderName);
        JSObject ret = new JSObject();
        ret.put("resolvedPath", watchedDir.getAbsolutePath());
        ret.put("exists", watchedDir.exists());
        call.resolve(ret);
    }

    @PluginMethod
    public void stopWatching(PluginCall call) {
        getContext().stopService(new Intent(getContext(), FolderWatchService.class));
        call.resolve();
    }
}
