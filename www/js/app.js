// ---------------------------------------------------------------------------
// Ajet YouTube Uploader — app.js
//
// This file only ever talks to Supabase (via the public anon key + RLS) and
// to Capacitor plugins on the device. It never talks to Gemini or the
// YouTube API — that all happens server-side in Supabase Edge Functions,
// triggered automatically once a video row is inserted.
// ---------------------------------------------------------------------------

const Plugins = window.Capacitor ? window.Capacitor.Plugins : {};
const { Browser, App, Preferences, FolderWatcher } = Plugins;

const STAGE_KEYS = ["pending", "analyzing", "analyzed", "uploading", "uploaded"];

// ---------- View routing ----------
document.querySelectorAll(".tab").forEach((tab) => {
  tab.addEventListener("click", () => setView(tab.dataset.view));
});

function setView(name) {
  document.querySelectorAll(".view").forEach((v) => v.classList.add("hidden"));
  document.getElementById(`view-${name}`).classList.remove("hidden");
  document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("is-active", t.dataset.view === name));
  if (name === "history") loadHistory();
}

// ---------- Queue ----------
async function loadQueue() {
  const { data, error } = await supabaseClient
    .from("videos")
    .select("id, filename, thumbnail_public_url, generated_title, status, created_at")
    .order("created_at", { ascending: false })
    .limit(100);

  if (error) {
    console.error("loadQueue failed", error);
    return;
  }
  renderQueue(data || []);
}

function renderQueue(rows) {
  const list = document.getElementById("queue-list");
  const emptyHint = document.getElementById("queue-empty-hint");
  list.innerHTML = "";

  const counts = Object.fromEntries(STAGE_KEYS.map((k) => [k, 0]));
  rows.forEach((r) => { if (counts[r.status] !== undefined) counts[r.status]++; });
  STAGE_KEYS.forEach((k) => {
    const el = document.getElementById(`count-${k}`);
    if (el) el.textContent = counts[k];
  });

  emptyHint.classList.toggle("hidden", rows.length > 0);

  rows.forEach((row) => {
    const li = document.createElement("li");
    li.className = "queue-item";
    li.innerHTML = `
      <img class="queue-item-thumb" src="${row.thumbnail_public_url || ""}" onerror="this.style.visibility='hidden'" />
      <div class="queue-item-body">
        <div class="queue-item-title">${escapeHtml(row.generated_title || row.filename)}</div>
        <div class="queue-item-file">${escapeHtml(row.filename)}</div>
      </div>
      <span class="status-chip" data-status="${row.status}">${statusLabel(row.status)}</span>
    `;
    list.appendChild(li);
  });
}

function statusLabel(status) {
  return {
    pending: "detected",
    analyzing: "analyzing",
    analyzed: "ready",
    uploading: "uploading",
    uploaded: "live",
    quota_exceeded: "quota — retrying",
    failed: "failed"
  }[status] || status;
}

function escapeHtml(str) {
  return String(str || "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// Live updates: any insert/update on videos re-renders the queue.
supabaseClient
  .channel("videos-changes")
  .on("postgres_changes", { event: "*", schema: "public", table: "videos" }, loadQueue)
  .subscribe();

// ---------- History ----------
async function loadHistory() {
  const { data, error } = await supabaseClient
    .from("upload_history")
    .select("id, event, message, created_at, videos(filename, generated_title)")
    .order("created_at", { ascending: false })
    .limit(100);

  if (error) {
    console.error("loadHistory failed", error);
    return;
  }

  const list = document.getElementById("history-list");
  list.innerHTML = "";
  (data || []).forEach((row) => {
    const li = document.createElement("li");
    li.className = "history-item";
    li.dataset.event = row.event;
    const when = new Date(row.created_at).toLocaleString();
    li.innerHTML = `
      <span class="history-title">${escapeHtml(row.videos?.generated_title || row.videos?.filename || "Unknown video")}</span>
      ${escapeHtml(row.message)} · ${when}
    `;
    list.appendChild(li);
  });
}

// ---------- Settings ----------
async function loadSettings() {
  const { data, error } = await supabaseClient
    .from("settings")
    .select("upload_folder, default_visibility, youtube_connected, youtube_channel_title")
    .eq("id", 1)
    .single();

  if (error) {
    console.error("loadSettings failed", error);
    return;
  }

  document.getElementById("input-folder").value = data.upload_folder || "Ajet YouTube";
  setVisibilitySegment(data.default_visibility || "private");
  applyChannelState(data.youtube_connected, data.youtube_channel_title);
}

function setVisibilitySegment(value) {
  document.querySelectorAll("#visibility-segmented .segmented-btn").forEach((btn) => {
    btn.classList.toggle("is-active", btn.dataset.value === value);
  });
}

function applyChannelState(connected, channelTitle) {
  const chip = document.getElementById("channel-chip");
  const chipLabel = document.getElementById("channel-chip-label");
  const connectRowName = document.getElementById("youtube-channel-name");
  const connectRowSub = document.getElementById("youtube-channel-sub");
  const connectBtn = document.getElementById("btn-connect-youtube");

  if (connected) {
    chip.dataset.state = "connected";
    chipLabel.textContent = channelTitle || "Connected";
    connectRowName.textContent = channelTitle || "Connected";
    connectRowSub.textContent = "Uploads will publish to this channel";
    connectBtn.textContent = "Reconnect";
  } else {
    chip.dataset.state = "disconnected";
    chipLabel.textContent = "Not connected";
    connectRowName.textContent = "Not connected";
    connectRowSub.textContent = "No channel linked yet";
    connectBtn.textContent = "Connect";
  }
}

document.querySelectorAll("#visibility-segmented .segmented-btn").forEach((btn) => {
  btn.addEventListener("click", () => setVisibilitySegment(btn.dataset.value));
});

document.getElementById("btn-save-settings").addEventListener("click", async () => {
  const folder = document.getElementById("input-folder").value.trim() || "Ajet YouTube";
  const visibility = document.querySelector("#visibility-segmented .segmented-btn.is-active").dataset.value;

  const { error } = await supabaseClient
    .from("settings")
    .update({ upload_folder: folder, default_visibility: visibility })
    .eq("id", 1);

  const note = document.getElementById("settings-saved-note");
  note.textContent = error ? "Could not save settings." : "Saved.";
  note.classList.remove("hidden");
  setTimeout(() => note.classList.add("hidden"), 2000);

  if (!error && FolderWatcher) {
    // Re-point the native watcher at the (possibly new) folder name.
    FolderWatcher.startWatching({ folderName: folder }).catch(console.error);
  }
});

// ---------- Connect YouTube ----------
document.getElementById("btn-connect-youtube").addEventListener("click", async () => {
  const url = `${SUPABASE_URL}/functions/v1/youtube-oauth-start`;
  if (Browser) {
    await Browser.open({ url });
  } else {
    window.open(url, "_blank");
  }
});

// When the in-app browser closes (user finished, or cancelled, the Google
// consent flow), re-check settings so the chip/connect card reflect reality.
if (Browser) {
  Browser.addListener("browserFinished", loadSettings);
}
if (App) {
  App.addListener("appStateChange", async ({ isActive }) => {
    if (isActive) {
      await loadSettings();
      await initFolderWatcher(); // re-check permission + (re)start the watcher on every resume
    }
  });
}

// ---------- Native folder watcher bootstrap ----------
async function initFolderWatcher() {
  if (!FolderWatcher) {
    document.getElementById("folder-permission-note").textContent =
      "Native folder watcher plugin not found (check the Android build).";
    return;
  }
  try {
    const { granted } = await FolderWatcher.hasAllFilesAccess();
    const note = document.getElementById("folder-permission-note");
    if (!granted) {
      note.textContent = "Storage access needed — tap to grant.";
      note.onclick = () => FolderWatcher.requestAllFilesAccess();
      note.style.cursor = "pointer";
      note.style.textDecoration = "underline";
    } else {
      const { value: folder } = await Preferences.get({ key: "upload_folder" });
      const result = await FolderWatcher.startWatching({ folderName: folder || "Ajet YouTube" });
      note.textContent = `Watching: ${result.resolvedPath} (${result.exists ? "folder exists" : "folder does not exist yet"}) — tap to rescan`;
      note.onclick = () => FolderWatcher.startWatching({ folderName: folder || "Ajet YouTube" }).then((r) => {
        note.textContent = `Watching: ${r.resolvedPath} (${r.exists ? "folder exists" : "folder does not exist yet"}) — tap to rescan`;
      });
      note.style.cursor = "pointer";
    }
  } catch (e) {
    console.error("initFolderWatcher failed", e);
  }
}

// ---------- Boot ----------
(async function boot() {
  await loadSettings();
  await loadQueue();
  await initFolderWatcher();
})();
