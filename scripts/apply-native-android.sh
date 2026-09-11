#!/usr/bin/env bash
# Merges native-android/ into the Capacitor-generated android/ project.
# Safe to run more than once (idempotent).
#
# Usage: bash scripts/apply-native-android.sh
# Requires: android/ to already exist (run `npx cap add android` first)
#           python3 (used for the manifest/gradle text patches)

set -euo pipefail
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

if [ ! -d "android" ]; then
  echo "android/ not found — run 'npx cap add android' first." >&2
  exit 1
fi

echo "==> Copying native plugin/service/worker java files"
JAVA_DEST="android/app/src/main/java/com/ajet/youtubeuploader"
mkdir -p "$JAVA_DEST"
cp native-android/com/ajet/youtubeuploader/*.java "$JAVA_DEST/"

echo "==> Patching AndroidManifest.xml"
python3 - "$ROOT_DIR" <<'PY'
import re, sys, pathlib

root = pathlib.Path(sys.argv[1])
manifest_path = root / "android/app/src/main/AndroidManifest.xml"
text = manifest_path.read_text()

if "xmlns:tools=" not in text:
    text = text.replace(
        "<manifest ", '<manifest xmlns:tools="http://schemas.android.com/tools" ', 1
    )

permissions = """
    <uses-permission android:name="android.permission.MANAGE_EXTERNAL_STORAGE" tools:ignore="ScopedStorage" />
    <uses-permission android:name="android.permission.READ_EXTERNAL_STORAGE" />
    <uses-permission android:name="android.permission.WRITE_EXTERNAL_STORAGE" android:maxSdkVersion="29" />
    <uses-permission android:name="android.permission.FOREGROUND_SERVICE" />
    <uses-permission android:name="android.permission.FOREGROUND_SERVICE_DATA_SYNC" />
    <uses-permission android:name="android.permission.POST_NOTIFICATIONS" />
    <uses-permission android:name="android.permission.RECEIVE_BOOT_COMPLETED" />
"""
if "MANAGE_EXTERNAL_STORAGE" not in text:
    text = re.sub(r"(<manifest[^>]*>)", r"\1" + permissions, text, count=1)

service_block = """
        <service
            android:name="com.ajet.youtubeuploader.FolderWatchService"
            android:foregroundServiceType="dataSync"
            android:exported="false" />
"""
if "FolderWatchService" not in text:
    text = text.replace("</application>", service_block + "    </application>")

manifest_path.write_text(text)
print("   manifest patched")
PY

echo "==> Patching android/app/build.gradle (WorkManager + core deps)"
python3 - "$ROOT_DIR" <<'PY'
import re, sys, pathlib

root = pathlib.Path(sys.argv[1])
gradle_path = root / "android/app/build.gradle"
text = gradle_path.read_text()

extra = '    implementation "androidx.work:work-runtime:2.9.1"\n    implementation "androidx.core:core:1.13.1"\n'
if "androidx.work:work-runtime" not in text:
    text = re.sub(r"(dependencies\s*\{)", r"\1\n" + extra, text, count=1)
    gradle_path.write_text(text)
    print("   build.gradle patched")
else:
    print("   build.gradle already patched")
PY

echo "==> Bumping minSdkVersion in android/variables.gradle"
python3 - "$ROOT_DIR" <<'PY'
import re, sys, pathlib

root = pathlib.Path(sys.argv[1])
vars_path = root / "android/variables.gradle"
text = vars_path.read_text()
text = re.sub(r"minSdkVersion\s*=\s*\d+", "minSdkVersion = 26", text)
vars_path.write_text(text)
print("   variables.gradle patched")
PY

echo "==> Registering FolderWatcherPlugin with the Capacitor bridge in MainActivity.java"
python3 - "$ROOT_DIR" <<'PY'
import re, sys, pathlib

root = pathlib.Path(sys.argv[1])
main_activity = root / "android/app/src/main/java/com/ajet/youtubeuploader/MainActivity.java"
text = main_activity.read_text()

if "FolderWatcherPlugin" in text:
    print("   MainActivity.java already registers the plugin")
else:
    if "import android.os.Bundle;" not in text:
        text = re.sub(r"(package [^;]+;\n)", r"\1\nimport android.os.Bundle;\n", text, count=1)

    if re.search(r"public\s+void\s+onCreate\s*\(\s*Bundle", text):
        text = re.sub(
            r"(public\s+void\s+onCreate\s*\(\s*Bundle[^)]*\)\s*\{\s*)",
            r"\1\n    registerPlugin(FolderWatcherPlugin.class);\n",
            text, count=1
        )
    else:
        onCreate = (
            "\n  @Override\n"
            "  public void onCreate(Bundle savedInstanceState) {\n"
            "    registerPlugin(FolderWatcherPlugin.class);\n"
            "    super.onCreate(savedInstanceState);\n"
            "  }\n"
        )
        text = re.sub(
            r"(public class MainActivity extends BridgeActivity\s*\{)",
            r"\1" + onCreate,
            text, count=1
        )

    main_activity.write_text(text)
    print("   MainActivity.java patched")
PY

echo "==> Done. android/ now includes the folder-watcher plugin, service, and worker."
