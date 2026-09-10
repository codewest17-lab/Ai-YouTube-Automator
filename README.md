# Ajet YouTube Uploader

A personal Android app: drop a video into a folder on your phone, and it is
automatically analyzed by Gemini and uploaded to your YouTube channel with
an AI-written title, description, hashtags, and tags.

```
Ajet YouTube/ (on your phone)
  ↓ new video appears
Native FolderWatchService detects it (FileObserver, runs even app-closed)
  ↓
VideoUploadWorker uploads raw bytes to Supabase Storage (signed URL)
  ↓
register_video() inserts a row in Postgres  →  Database Webhook fires
  ↓
process-video Edge Function:
  - downloads the video (service_role, server-side only)
  - sends it to Gemini → title / description / hashtags / tags / category
  - uploads it to YouTube (OAuth refresh token, server-side only)
  - sets the thumbnail, writes youtube_url back to the row
  ↓
App UI updates live (Supabase Realtime) — file moved to "Uploaded/"
```

The app itself never talks to Gemini or the YouTube API and never contains
the Gemini key, the Google OAuth client secret, or the Supabase
`service_role` key. Those three secrets live only as **Supabase Edge
Function secrets**. The app only ever uses the public Supabase **anon**
key, which is safe to ship because every table/bucket it can reach is
locked down by Row Level Security (`supabase/schema.sql`).

---

## Current status

Project **Ajet YouTube Automator** (`waxmerlwcvdurhpiggrz`) is connected
and wired up:

- ✅ Schema applied — tables, RLS, `register_video()`, both storage buckets
- ✅ All 4 Edge Functions deployed — `create-upload-url`, `process-video`,
  `youtube-oauth-start`, `youtube-oauth-callback`
- ✅ Project URL + anon key already filled into `supabase-client.js` and
  `VideoUploadWorker.java` in this copy of the project
- ✅ Database Webhook — wired directly via SQL (`pg_net`), no Dashboard
  click needed; smoke-tested end to end (insert → trigger → `process-video`
  → status flips to `failed` with a clear error, since no video existed
  yet at the storage path — exactly the behavior expected)
- ✅ GitHub Actions workflow + Termux build path — see **TERMUX.md**
- ✅ YouTube quota handling — verified against current official docs, see
  **QUOTA.md**: dedicated 100/day upload bucket, general 10k pool, 3 error
  types classified and handled, daily auto-retry via `pg_cron`
- ⬜ `GEMINI_API_KEY` secret — needs your key, see Stage 3
- ⬜ Google Cloud OAuth client (`GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`
  secrets) — needs your Google Cloud project, see Stage 4

The remaining items all require either a credential only you can generate
(API keys, OAuth client) or your own Android Studio/device — nothing I
can complete on your behalf from here.

---

## File structure

```
ajet-youtube-uploader/
├── package.json
├── capacitor.config.json
├── www/                              ← the Capacitor web app
│   ├── index.html
│   ├── css/style.css
│   └── js/
│       ├── supabase-client.js        ← put your Supabase URL/anon key here
│       └── app.js
├── supabase/
│   ├── schema.sql                    ← run once in the SQL editor
│   └── functions/
│       ├── _shared/
│       │   ├── supabaseAdmin.ts
│       │   ├── gemini.ts
│       │   └── youtube.ts
│       ├── create-upload-url/index.ts
│       ├── process-video/index.ts    ← the main pipeline, fired by webhook
│       ├── youtube-oauth-start/index.ts
│       └── youtube-oauth-callback/index.ts
└── native-android/                   ← copy into android/ after `cap add android`
    ├── com/ajet/youtubeuploader/
    │   ├── FolderWatcherPlugin.java
    │   ├── FolderWatchService.java
    │   └── VideoUploadWorker.java
    ├── manifest-additions.xml
    └── build-gradle-additions.txt
```

---

## Stage 1 — App shell + Android project

> Building via GitHub Actions from Termux instead of Android Studio? Skip
> straight to **[TERMUX.md](TERMUX.md)** — it covers pushing this repo
> from Termux, letting `.github/workflows/build-android.yml` do the actual
> Gradle build, and pulling the finished APK back down to your phone (plus
> a fully-on-device option if you'd rather not use GitHub Actions at all).
> The steps below are the Android Studio / manual equivalent of what that
> workflow and `scripts/apply-native-android.sh` do automatically.

```bash
cd ajet-youtube-uploader
npm install
npx cap add android
```

Then wire in the native pieces (these can't be generated until `android/`
exists):

1. Copy the three files under `native-android/com/ajet/youtubeuploader/`
   to `android/app/src/main/java/com/ajet/youtubeuploader/` (create the
   folders).
2. Open `android/app/src/main/AndroidManifest.xml` and merge in the
   permissions/service block from `native-android/manifest-additions.xml`.
   Add `xmlns:tools="http://schemas.android.com/tools"` to the `<manifest>`
   tag if it isn't already there (needed for the `tools:ignore` attribute).
3. Open `android/app/build.gradle` and add the two dependency lines from
   `native-android/build-gradle-additions.txt`, and confirm `minSdkVersion
   26` / `targetSdkVersion 34`.
4. `npx cap sync android`

At this point `npx cap open android` gets you a buildable app: it'll show
the UI and (once you grant "All files access" in Settings, which the
Settings tab links to) start the foreground watcher on
`Internal storage/Ajet YouTube/`. It won't upload anything yet — that needs
Stages 2–4.

---

## Stage 2 — Supabase project + database ✅ done

Project **Ajet YouTube Automator** (`waxmerlwcvdurhpiggrz`, `eu-central-1`)
is live and already wired up:

- `supabase/schema.sql` has been applied — `videos`, `settings`,
  `oauth_tokens`, `upload_history`, RLS policies, `register_video()`, and
  both storage buckets all exist.
- All four Edge Functions are deployed: `create-upload-url`,
  `process-video`, `youtube-oauth-start`, `youtube-oauth-callback`.
- The anon key and project URL are already filled in, in both
  `www/js/supabase-client.js` and
  `native-android/com/ajet/youtubeuploader/VideoUploadWorker.java`, in
  this copy of the project — nothing to paste in yourself.

You can sanity-check any of this any time in the Dashboard at
`https://supabase.com/dashboard/project/waxmerlwcvdurhpiggrz`.

---

## Stage 3 — Gemini (AI analysis)

The function code is already deployed (previous step) — what's left is
the one secret only you can provide, since it's a credential I have no
way to fetch or generate on your behalf:

1. Get an API key at https://aistudio.google.com/app/apikey.
2. Set it as an Edge Function secret — either in the Dashboard
   (**Project Settings → Edge Functions → Secrets**) or via CLI:

   ```bash
   npm install -g supabase
   supabase login
   supabase link --project-ref waxmerlwcvdurhpiggrz
   supabase secrets set GEMINI_API_KEY=your-gemini-key
   ```

3. ✅ Already done — the `videos` insert trigger is wired directly in
   Postgres via `pg_net` (no Dashboard webhook needed), calling
   `process-video` on every insert with `status = 'pending'`. It's been
   smoke-tested end to end already.

   If you'd rather lock it down further later (right now anyone who
   discovers the function URL could invoke it, though they'd still need a
   real `storage_path` to do anything with it), set a
   `WEBHOOK_SHARED_SECRET` Edge Function secret and add a matching
   `x-webhook-secret` header to the `net.http_post(...)` call in the
   `trigger_process_video()` Postgres function.

   Either way, the pipeline is fully automatic: the moment a row is
   inserted (from the phone, or from anywhere), `process-video` runs on its
   own, with no polling and no app involvement.

---

## Stage 4 — Google OAuth + YouTube Data API v3

1. In [Google Cloud Console](https://console.cloud.google.com/), create a
   project (or reuse one) and enable **YouTube Data API v3**
   (APIs & Services → Library).
2. APIs & Services → OAuth consent screen:
   - User type: **External**, publishing status can stay **Testing** for
     personal use — add your own Google account under **Test users** so
     you can authorize without Google's app-verification review.
   - Scopes: `youtube.upload`, `youtube.readonly`.
3. APIs & Services → Credentials → **Create credentials → OAuth client
   ID** → Application type **Web application**.
   - Authorized redirect URI:
     `https://waxmerlwcvdurhpiggrz.supabase.co/functions/v1/youtube-oauth-callback`
4. Set the two secrets:

   ```bash
   supabase secrets set GOOGLE_CLIENT_ID=your-client-id
   supabase secrets set GOOGLE_CLIENT_SECRET=your-client-secret
   ```

5. Build and install the app, open **Settings → Connect**. It opens the
   system browser to Google's consent screen and back; on success the
   Settings tab shows your channel name and the top-bar chip turns green.
   This is the "approve once" step — after this, `process-video` refreshes
   the access token itself for every future upload.

> YouTube's quota for `videos.insert` currently sits in its own dedicated
> bucket — 100 calls/day, 1 unit/call, separate from the general
> 10,000-unit pool — per the current official docs. See **QUOTA.md** for
> the full breakdown (upload bucket vs. general pool vs. the separate
> channel-level daily cap, how errors are handled, and how to request an
> increase if you ever need one).
>
> **Read this part of QUOTA.md before you're surprised by it:** until your
> Google Cloud project passes YouTube's compliance audit, every upload
> comes out `private` regardless of what visibility you pick — that's a
> restriction YouTube applies to all unverified API projects, not a bug in
> this app.

---

## Stage 5 — Automation, end to end

With Stages 1–4 done:

```bash
npx cap sync android
npx cap open android
```

Build & install onto your phone from Android Studio. Grant "All files
access" when the Settings tab prompts you (this is required to watch an
arbitrary folder like `Internal storage/Ajet YouTube/` under Android's
scoped storage rules). Drop a video (optionally with a
`<name>_thumbnail.jpg` alongside it) into that folder — within a couple of
seconds the Queue tab shows it move through **Detected → Analyzing →
Ready → Uploading → Live**, and the file gets moved into `Ajet
YouTube/Uploaded/` once it's safely on YouTube (or `Failed/` after 5 retry
attempts, with the reason visible in the History tab).

### Testing without waiting on the native build

You can exercise the whole server-side pipeline before the Android build
is ready by inserting a test row directly:

```sql
select register_video('test.mp4', 'videos/some-existing-file-in-bucket.mp4');
```

as long as `videos/some-existing-file-in-bucket.mp4` really exists in the
`incoming-videos` bucket (upload one by hand from the Storage tab first).
The webhook fires the same way it would from the phone.

---

## Security recap

| Secret | Lives in | Never appears in |
|---|---|---|
| Supabase anon key | `www/js/supabase-client.js`, `VideoUploadWorker.java` | — (this one is meant to be public; RLS does the real protecting) |
| Supabase `service_role` key | Edge Function secrets | the app, the frontend, git history (keep `.env`/secrets out of commits) |
| `GEMINI_API_KEY` | Edge Function secrets | the app |
| `GOOGLE_CLIENT_SECRET` | Edge Function secrets | the app |
| YouTube refresh/access tokens | `oauth_tokens` table (RLS: no policies at all) | the app — the client can't `select` this table even with the anon key |

---

## Extending later

- **iOS**: `npx cap add ios` works for the web layer, but `FolderWatchService`
  is Android-only (iOS has no equivalent of watching an arbitrary folder on
  the file system) — you'd swap in a Share Extension or Shortcuts-based
  intake instead.
- **Per-video visibility override**: add a picker in the queue item before
  it reaches `uploading`; `process-video` already reads `visibility` off
  the row, so the UI just needs an update call while status is still
  `analyzed`.
- **Multiple destination channels**: `oauth_tokens` is a single row today;
  turn it into a normal table keyed by channel if you ever want more than
  one.
