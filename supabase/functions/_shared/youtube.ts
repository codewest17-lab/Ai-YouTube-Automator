import { supabaseAdmin } from "./supabaseAdmin.ts";

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const UPLOAD_URL = "https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status";
const THUMB_URL = (videoId: string) => `https://www.googleapis.com/upload/youtube/v3/thumbnails/set?videoId=${videoId}`;
const CHANNEL_URL = "https://www.googleapis.com/youtube/v3/channels?part=snippet&mine=true";

const CATEGORY_MAP: Record<string, string> = {
  "film & animation": "1",
  "autos & vehicles": "2",
  "music": "10",
  "pets & animals": "15",
  "sports": "17",
  "travel & events": "19",
  "gaming": "20",
  "people & blogs": "22",
  "comedy": "23",
  "entertainment": "24",
  "news & politics": "25",
  "howto & style": "26",
  "education": "27",
  "science & technology": "28"
};

export function categoryNameToId(name: string): string {
  return CATEGORY_MAP[name.trim().toLowerCase()] || "22";
}

// ---------------------------------------------------------------------------
// Quota handling.
//
// YouTube Data API v3, current as of the official docs (checked against
// developers.google.com/youtube/v3/determine_quota_cost and
// .../docs/videos/insert, both last updated within days of this being
// written), has THREE independent limits that can stop an upload. They fail
// differently and need different handling — see QUOTA.md for the full
// writeup:
//
// 1. Project's "Video Uploads" quota bucket. videos.insert has its own
//    dedicated bucket: 100 calls/day, 1 unit/call. Does NOT draw from the
//    general 10,000-unit pool. Observed failure mode: HTTP 429, reason
//    "rateLimitExceeded", message mentioning "Video Uploads"/"per day".
//    Some projects may instead see the older-style HTTP 403,
//    domain "youtube.quota", reason "quotaExceeded"/"dailyLimitExceeded".
// 2. General 10,000-unit/day pool. Everything else draws from this —
//    thumbnails.set (50), videos.update (50), videos.list (1), etc.
// 3. YouTube's CHANNEL-level daily upload cap — separate from both of the
//    above, the same limit that applies to uploading from youtube.com or
//    the mobile app. Documented failure mode: HTTP 400, reason
//    "uploadLimitExceeded". A quota increase request does NOT help with
//    this one — verify the channel's phone number instead.
// ---------------------------------------------------------------------------

export type QuotaKind = "upload_bucket" | "project_pool" | "channel_limit";

export class QuotaExceededError extends Error {
  kind: QuotaKind;
  constructor(kind: QuotaKind, message: string) {
    super(message);
    this.kind = kind;
    this.name = "QuotaExceededError";
  }
}

async function classifyYouTubeError(res: Response): Promise<Error> {
  const status = res.status;
  const bodyText = await res.text();
  let reason = "";
  let message = bodyText;
  try {
    const parsed = JSON.parse(bodyText);
    reason = parsed.error?.errors?.[0]?.reason || "";
    message = parsed.error?.message || bodyText;
  } catch {
    // non-JSON body, fall through with raw text
  }

  if (status === 400 && reason === "uploadLimitExceeded") {
    return new QuotaExceededError(
      "channel_limit",
      "YouTube's channel-level daily upload limit was reached (independent of API project quota). " +
        "Try again in about 24 hours, or verify the channel's phone number in YouTube settings to raise this limit."
    );
  }

  if (status === 429 && /video uploads/i.test(message)) {
    return new QuotaExceededError(
      "upload_bucket",
      "The project's dedicated Video Uploads quota bucket (100 calls/day) is exhausted for today. " +
        "Resets at midnight Pacific Time."
    );
  }

  if (status === 403 && (reason === "quotaExceeded" || reason === "dailyLimitExceeded")) {
    return new QuotaExceededError(
      "project_pool",
      "The project's general 10,000-unit/day YouTube API quota is exhausted. Resets at midnight Pacific Time, " +
        "or request an increase (see QUOTA.md)."
    );
  }

  return new Error(`YouTube API call failed: ${status} ${message}`);
}

/** Retries transient 5xx failures a couple of times; never retries 4xx (including quota errors). */
async function fetchWithRetry(url: string, init: RequestInit, attempts = 3): Promise<Response> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(url, init);
      if (res.status >= 500 && i < attempts - 1) {
        await new Promise((r) => setTimeout(r, 500 * Math.pow(3, i)));
        continue;
      }
      return res;
    } catch (err) {
      lastErr = err;
      if (i < attempts - 1) await new Promise((r) => setTimeout(r, 500 * Math.pow(3, i)));
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

async function getStoredTokens() {
  const admin = supabaseAdmin();
  const { data, error } = await admin.from("oauth_tokens").select("*").eq("id", 1).single();
  if (error || !data?.refresh_token) {
    throw new Error("No YouTube account connected yet. Connect it from the app's Settings tab first.");
  }
  return data;
}

async function refreshAccessToken(refreshToken: string) {
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: Deno.env.get("GOOGLE_CLIENT_ID")!,
      client_secret: Deno.env.get("GOOGLE_CLIENT_SECRET")!,
      refresh_token: refreshToken,
      grant_type: "refresh_token"
    })
  });
  if (!res.ok) throw new Error(`Token refresh failed: ${res.status} ${await res.text()}`);
  return res.json() as Promise<{ access_token: string; expires_in: number }>;
}

export async function getValidAccessToken(): Promise<string> {
  const tokens = await getStoredTokens();
  const expiry = tokens.token_expiry ? new Date(tokens.token_expiry).getTime() : 0;
  const isExpired = !tokens.access_token || expiry - Date.now() < 60_000;

  if (!isExpired) return tokens.access_token;

  const refreshed = await refreshAccessToken(tokens.refresh_token);
  const admin = supabaseAdmin();
  const newExpiry = new Date(Date.now() + refreshed.expires_in * 1000).toISOString();
  await admin.from("oauth_tokens").update({
    access_token: refreshed.access_token,
    token_expiry: newExpiry
  }).eq("id", 1);

  return refreshed.access_token;
}

interface UploadInput {
  videoBytes: Uint8Array;
  mimeType: string;
  title: string;
  description: string;
  tags: string[];
  categoryId: string;
  visibility: "public" | "private" | "unlisted";
}

/** Exactly ONE videos.insert call (resumable init + PUT together count as one). */
export async function uploadVideoToYouTube(input: UploadInput): Promise<{ videoId: string; url: string; actualPrivacyStatus: string }> {
  const accessToken = await getValidAccessToken();

  const initRes = await fetchWithRetry(UPLOAD_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json; charset=UTF-8",
      "X-Upload-Content-Type": input.mimeType,
      "X-Upload-Content-Length": String(input.videoBytes.byteLength)
    },
    body: JSON.stringify({
      snippet: {
        title: input.title,
        description: input.description,
        tags: input.tags,
        categoryId: input.categoryId
      },
      status: {
        privacyStatus: input.visibility,
        selfDeclaredMadeForKids: false
      }
    })
  });

  if (!initRes.ok) {
    throw await classifyYouTubeError(initRes);
  }

  const uploadSessionUrl = initRes.headers.get("Location");
  if (!uploadSessionUrl) throw new Error("YouTube did not return a resumable upload URL");

  const putRes = await fetch(uploadSessionUrl, {
    method: "PUT",
    headers: {
      "Content-Type": input.mimeType,
      "Content-Length": String(input.videoBytes.byteLength)
    },
    body: input.videoBytes
  });

  if (!putRes.ok) {
    throw await classifyYouTubeError(putRes);
  }

  const uploaded = await putRes.json();
  const videoId = uploaded.id as string;
  // New/unaudited API projects have uploads force-restricted to private by
  // YouTube regardless of what privacyStatus was requested (see "Videos:
  // insert" docs). We read back what YouTube actually set rather than
  // trusting the value we sent, so the app's UI reflects reality — see
  // QUOTA.md for how to lift that restriction.
  const actualPrivacyStatus = uploaded.status?.privacyStatus || input.visibility;
  return { videoId, url: `https://youtu.be/${videoId}`, actualPrivacyStatus };
}

/** Exactly ONE thumbnails.set call (50 units against the general pool). */
export async function setThumbnail(videoId: string, thumbBytes: Uint8Array, mimeType: string) {
  const accessToken = await getValidAccessToken();
  const res = await fetchWithRetry(THUMB_URL(videoId), {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": mimeType
    },
    body: thumbBytes
  });
  if (!res.ok) {
    // Non-fatal: the video is already live even if the thumbnail fails.
    const err = await classifyYouTubeError(res);
    console.error("setThumbnail failed", err.message);
  }
}

export async function fetchOwnChannel(accessToken: string) {
  const res = await fetch(CHANNEL_URL, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (!res.ok) throw new Error(`Fetching channel info failed: ${res.status} ${await res.text()}`);
  const json = await res.json();
  const channel = json.items?.[0];
  return {
    id: channel?.id as string | undefined,
    title: channel?.snippet?.title as string | undefined
  };
}
