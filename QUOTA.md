# YouTube Data API v3 quota — how this app handles it

Everything below is checked against Google's official docs, current as of
this writing (both pages below show a "Last updated 2026-09-04" / "2026-07-08"
stamp, i.e. within days of when this was written):

- https://developers.google.com/youtube/v3/determine_quota_cost
- https://developers.google.com/youtube/v3/docs/videos/insert
- https://developers.google.com/youtube/v3/getting-started#quota

**If you've read an older guide (including earlier advice from me in this
conversation) that says an upload costs 1,600 quota units and you get ~6
uploads/day — that was true before December 4, 2025, but isn't anymore.**
Google cut the cost, then split uploads into their own bucket entirely on
June 1, 2026. The numbers below are what's live today.

---

## 1. Upload quota limits (`videos.insert`)

- `videos.insert` has its **own dedicated daily bucket**, separate from
  every other endpoint: **100 calls per day, 1 unit per call.**
- It does **not** draw from the general 10,000-unit pool at all.
- A resumable upload (the init POST + the PUT of the bytes) counts as
  **one** `videos.insert` call, not two — this app uses the resumable
  protocol for exactly that reason.
- For a personal channel posting occasional videos, 100/day is not a
  realistic ceiling to hit.

## 2. General YouTube API unit quota

- Every project gets **10,000 units/day**, shared by every endpoint
  *except* `videos.insert` and `search.list` (which have their own 100/day
  buckets as of the June 2026 change).
- This app never calls `search.list`. The only general-pool call in the
  pipeline is `thumbnails.set` (50 units) — see below.
- Quota resets at **midnight Pacific Time**.

## 3. Additional API calls this app makes (thumbnail, metadata, etc.)

The pipeline is intentionally minimal — **exactly two YouTube API calls
per video**, both server-side in `process-video`:

| Call | Cost | Bucket | When |
|---|---|---|---|
| `videos.insert` (resumable) | 1 unit | dedicated Video Uploads bucket (100/day) | once per video, sets title/description/tags/category/privacy in the same call |
| `thumbnails.set` | 50 units | general 10,000/day pool | once per video, only if a `*_thumbnail.jpg` file exists |

Plus a one-time, not-per-video call:

| Call | Cost | Bucket | When |
|---|---|---|---|
| `channels.list` (`mine=true`) | 1 unit | general pool | once, during the OAuth "Connect" flow, to show your channel name in Settings |

Nothing else in this app calls the YouTube API — no `videos.list` polling,
no `videos.update`, no `search.list`. At 50 units/video against a
10,000-unit pool, you could set ~200 thumbnails a day before the general
pool became the binding constraint — the 100/day upload bucket will always
run out first if either one does.

---

## Quota-efficient workflow (what this app actually does)

1. Native side uploads raw video bytes to Supabase Storage (no YouTube
   quota cost — that's Supabase's storage API, not Google's).
2. `process-video` calls Gemini once (no YouTube quota cost).
3. `process-video` calls `videos.insert` **once**, with `part=snippet,status`
   so metadata is set in the same call — no separate `videos.update` needed.
4. `process-video` calls `thumbnails.set` **once**, only if a thumbnail
   file was supplied.
5. Done. 2 YouTube API calls total per video, no retries unless something
   actually failed.

## Error handling

YouTube fails uploads in **three different ways**, all documented, and this
app's `_shared/youtube.ts` (`classifyYouTubeError`) distinguishes them so
the right thing happens automatically:

| # | What's exhausted | How YouTube signals it | This app's response |
|---|---|---|---|
| 1 | Project's Video Uploads bucket (100/day) | `HTTP 429`, message mentions "Video Uploads" (some projects may instead see the older `HTTP 403` / `quotaExceeded`) | `status = 'quota_exceeded'`, source file + Gemini metadata kept, auto-retried the next day |
| 2 | Project's general 10,000-unit pool | `HTTP 403`, `reason: "quotaExceeded"` or `"dailyLimitExceeded"` | same as above |
| 3 | **YouTube channel's own daily upload cap** — separate from API quota entirely, the same limit that applies to uploading from youtube.com/the mobile app | `HTTP 400`, `reason: "uploadLimitExceeded"` (documented on the `videos.insert` reference page) | same as above — but note a quota *extension* request won't fix this one; see below |
| — | Transient server error | `HTTP 5xx` | retried in-process up to 3 times with backoff, *not* treated as quota-exhausted |

In every quota case:
- The row moves to `videos.status = 'quota_exceeded'` (not `'failed'`), with
  `error_message` recording exactly which of the three it was.
- The source video is **not** deleted from storage, and if Gemini had
  already analyzed it, that metadata is kept — a retry skips straight to
  re-attempting the YouTube upload instead of re-spending a Gemini call.
- A `pg_cron` job (`retry-quota-exceeded-videos`, scheduled daily at 08:15
  UTC — after midnight Pacific Time regardless of DST) automatically flips
  `quota_exceeded` rows back to `pending` and re-triggers `process-video`.
  No manual retry is needed for the common case.
- The Queue tab shows these as a distinct amber **"quota — retrying"**
  chip, not a red failure.

## Requesting a quota increase (if you ever actually need it)

Given the 100/day dedicated upload bucket, this is unlikely to matter for
a personal channel — but if you do outgrow it:

1. Fill out the official **YouTube API Services – Audit and Quota
   Extension Form**: https://support.google.com/youtube/contact/yt_api_form
2. You'll need your Google Cloud **project ID and project number**
   (Cloud Console → Project Settings) and a description of your use case.
3. Google runs a compliance audit against the
   [YouTube API Services Terms of Service](https://developers.google.com/youtube/terms/api-services-terms-of-service)
   before granting more — typically a few days' turnaround.
4. If already audited within the last 12 months, use the shorter
   **Audited Developer Requests Form** instead (linked from the same
   quota/compliance-audits page:
   https://developers.google.com/youtube/v3/guides/quota_and_compliance_audits).

**Important:** a quota extension only raises limit #1/#2 above (the API
project's own buckets). It does **not** raise limit #3, the YouTube
*channel's* daily upload cap — that's a separate, per-channel restriction
tied to account verification (add/verify a phone number on the channel in
YouTube's own settings to raise it), not something Google's quota team can
extend.

---

## One more thing worth knowing: new API projects upload as Private

Straight from the official `videos.insert` reference page:

> All videos uploaded via the `videos.insert` endpoint from unverified API
> projects created after 28 July 2020 will be restricted to private
> viewing mode. To lift this restriction, each API project must undergo an
> audit to verify compliance with the Terms of Service.

Practically: until you submit your Google Cloud project for that same
audit (same form as the quota extension above), **every video this app
uploads will come out `private` on YouTube regardless of what visibility
you picked in Settings** — `public`/`unlisted` requests are silently
downgraded by YouTube itself. This app reads back whatever
`privacyStatus` YouTube actually assigned and stores *that* in `videos`
(rather than trusting what was requested), so the Queue/History tabs
reflect reality, not just what was asked for. If you want public or
unlisted uploads to actually work, you'll need to run that same audit.
