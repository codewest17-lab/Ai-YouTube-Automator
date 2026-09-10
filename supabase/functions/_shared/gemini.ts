// Shared Gemini helper. GEMINI_API_KEY only ever exists as an Edge Function
// secret (`supabase secrets set GEMINI_API_KEY=...`) — it is never sent to
// the client and never appears in any frontend file.

const GEMINI_MODEL = "gemini-2.5-flash";
const GEMINI_BASE = "https://generativelanguage.googleapis.com";

interface GeneratedMetadata {
  title: string;
  description: string;
  hashtags: string[];
  tags: string[];
  category: string;
}

const PROMPT = `You are helping prepare a personal video for upload to YouTube.
Watch the attached video and respond with ONLY a JSON object (no markdown
fences, no commentary) with exactly these fields:

{
  "title": "a catchy YouTube title, under 90 characters",
  "description": "a 2-4 paragraph YouTube description of what happens in the video, written for viewers, ending with a short call to action",
  "hashtags": ["#Example", "#Example2"],
  "tags": ["comma-style keyword tags for YouTube's tags field, lowercase, no hashes"],
  "category": "one plausible YouTube category name, e.g. Comedy, Pets & Animals, Travel & Events, Gaming, Education, Sports"
}`;

export async function analyzeVideoWithGemini(videoBytes: Uint8Array, mimeType: string): Promise<GeneratedMetadata> {
  const apiKey = Deno.env.get("GEMINI_API_KEY")!;

  // Step 1: upload the video to the Gemini File API so we don't have to
  // inline potentially large base64 payloads into the generateContent call.
  const uploadRes = await fetch(`${GEMINI_BASE}/upload/v1beta/files?key=${apiKey}`, {
    method: "POST",
    headers: {
      "X-Goog-Upload-Protocol": "raw",
      "Content-Type": mimeType
    },
    body: videoBytes
  });

  if (!uploadRes.ok) {
    throw new Error(`Gemini file upload failed: ${uploadRes.status} ${await uploadRes.text()}`);
  }
  const uploaded = await uploadRes.json();
  const fileUri = uploaded.file?.uri;
  const fileName = uploaded.file?.name;
  if (!fileUri) throw new Error("Gemini file upload did not return a file uri");

  // Step 2: poll until the file finishes processing (short clips are
  // usually instant, but we guard against the ACTIVE state taking a moment).
  let state = uploaded.file?.state;
  for (let i = 0; i < 10 && state !== "ACTIVE"; i++) {
    await new Promise((r) => setTimeout(r, 1500));
    const check = await fetch(`${GEMINI_BASE}/v1beta/${fileName}?key=${apiKey}`);
    const checked = await check.json();
    state = checked.state;
  }

  // Step 3: ask Gemini to analyze the video and return structured metadata.
  const genRes = await fetch(`${GEMINI_BASE}/v1beta/models/${GEMINI_MODEL}:generateContent?key=${apiKey}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{
        role: "user",
        parts: [
          { file_data: { file_uri: fileUri, mime_type: mimeType } },
          { text: PROMPT }
        ]
      }],
      generationConfig: {
        temperature: 0.6,
        response_mime_type: "application/json"
      }
    })
  });

  if (!genRes.ok) {
    throw new Error(`Gemini generateContent failed: ${genRes.status} ${await genRes.text()}`);
  }

  const genJson = await genRes.json();
  const text = genJson.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new Error("Gemini returned no analysis text");

  const parsed = JSON.parse(text) as GeneratedMetadata;

  return {
    title: (parsed.title || "Untitled upload").slice(0, 95),
    description: parsed.description || "",
    hashtags: Array.isArray(parsed.hashtags) ? parsed.hashtags.slice(0, 15) : [],
    tags: Array.isArray(parsed.tags) ? parsed.tags.slice(0, 30) : [],
    category: parsed.category || "People & Blogs"
  };
}
