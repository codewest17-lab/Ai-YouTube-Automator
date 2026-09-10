# Building with GitHub Actions + Termux

Two ways to go, both supported by this repo:

- **A. Recommended** — Termux is just your git client. The actual Gradle
  build (which is memory/CPU heavy) runs on GitHub's servers via
  `.github/workflows/build-android.yml`. You get a finished APK back in a
  few minutes without taxing your phone.
- **B. Fully on-device** — no GitHub Actions at all, Gradle runs inside
  Termux itself. Slower and heavier, but works with no internet dependency
  on GitHub once set up.

---

## A. Termux → GitHub Actions → APK back to your phone

### One-time setup

```bash
pkg update && pkg upgrade -y
pkg install git gh nodejs-lts -y

# authenticate the GitHub CLI (opens a browser login code flow)
gh auth login
```

### Push the project

```bash
# from inside the ajet-youtube-uploader/ folder (unzip it here first,
# e.g. with `pkg install unzip` then `unzip ajet-youtube-uploader.zip`)
cd ajet-youtube-uploader
git init
git add .
git commit -m "Initial Ajet YouTube Uploader"
gh repo create ajet-youtube-uploader --private --source=. --push
```

That last command creates the GitHub repo, sets it as `origin`, and pushes
— which immediately triggers `build-android.yml` (it runs on every push to
`main`).

### Watch it build and pull the APK down

```bash
# tail the running workflow
gh run watch

# once it finishes, download the artifact it produced
gh run download --name ajet-youtube-uploader-debug
```

That downloads `app-debug.apk` into your current directory. Install it
directly:

```bash
termux-open app-debug.apk
```

(`termux-open` needs the `termux-api` add-on app installed — `pkg install
termux-api` — or just move the file into `~/storage/downloads/` with
`termux-setup-storage` first and open it from your Files app instead.)

### After that first push

Any time you change something (e.g. paste in real Gemini/Google secrets
you've set separately, or tweak the UI), just:

```bash
git add -A && git commit -m "update" && git push
gh run watch
gh run download --name ajet-youtube-uploader-debug --clobber
termux-open app-debug.apk
```

### Getting a signed release build instead of debug

Add the four `RELEASE_*` secrets described at the top of
`build-android.yml` in your repo's **Settings → Secrets and variables →
Actions**, then trigger it manually:

```bash
gh workflow run build-android.yml
gh run watch
gh run download --name ajet-youtube-uploader-release
```

---

## B. Fully on-device build (no GitHub Actions)

Heavier, but keeps everything on the phone. Needs ~4-6 GB free storage and
a reasonably capable device — a full Gradle build the first time can take
10-20+ minutes.

```bash
pkg update && pkg upgrade -y
pkg install git nodejs-lts openjdk-17 wget unzip python -y

# --- Android SDK command-line tools ---
mkdir -p ~/android-sdk/cmdline-tools
cd ~/android-sdk/cmdline-tools
wget https://dl.google.com/android/repository/commandlinetools-linux-11076708_latest.zip
unzip commandlinetools-linux-*.zip
mv cmdline-tools latest
rm commandlinetools-linux-*.zip

export ANDROID_HOME=$HOME/android-sdk
export PATH=$PATH:$ANDROID_HOME/cmdline-tools/latest/bin:$ANDROID_HOME/platform-tools
# add those two export lines to ~/.bashrc so they persist across sessions

yes | sdkmanager --licenses
sdkmanager "platform-tools" "platforms;android-34" "build-tools;34.0.0"
```

> If `commandlinetools-linux-11076708_latest.zip` 404s, grab the current
> filename from https://developer.android.com/studio#command-line-tools-only
> and substitute it in the `wget` line above — Google rotates the version
> number periodically.

Then build:

```bash
cd ajet-youtube-uploader   # wherever you unzipped/cloned it
npm install
npx cap add android
npx cap sync android
bash scripts/apply-native-android.sh

cd android
chmod +x gradlew
./gradlew assembleDebug --no-daemon
```

The APK lands at `android/app/build/outputs/apk/debug/app-debug.apk`.
Install the same way as above:

```bash
termux-open app/build/outputs/apk/debug/app-debug.apk
```

If Gradle runs out of memory on-device, add this to
`android/gradle.properties` before building:

```
org.gradle.jvmargs=-Xmx1536m
org.gradle.daemon=false
```
