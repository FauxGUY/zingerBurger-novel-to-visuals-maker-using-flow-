/* ==========================================
 * ZINGERBURGER AI WEBTOON STUDIO
 * Created by FauxGUY (https://github.com/FauxGUY)
 * 
 * WARNING: PROTECTED FILE. 
 * DO NOT EDIT WITHOUT AUTHORIZATION.
 * ========================================== */

const REQUIRED_PASSWORD = "fauxisgreatguy";
const STYLE_PRESET_VERSION = "zingerburger-v3-no-text";
const DEFAULT_STYLE = `LOTM manhwa art style, sharp clean 2D digital anime linework, cel-shaded coloring, high contrast dramatic lighting. ABSOLUTELY NO watercolor, NO oil painting, NO painterly texture, NO bloom, NO glow, NO soft lighting. World: Lord of Mysteries donghua, dark Victorian-Gothic steampunk, foggy gaslit cobblestone streets, ornate 19th century occult architecture, B.CMAY Pictures LOTM visual world. Characters in Victorian formal wear, long coats, top hats. Moody oppressive blue-black atmosphere, cosmic horror undertones, deep shadows. Full bleed image, no white borders, no panel frames. Vertical webtoon composition. ABSOLUTELY NO TEXT, NO SPEECH BUBBLES, NO CAPTIONS, NO NARRATION BOXES, NO SOUND EFFECTS, NO LETTERING OF ANY KIND. MUST BE DRAWN AS A 2D COMIC/MANHWA INK AND COLOR, NOT A PAINTING.`;

const $ = (id) => document.getElementById(id);
const styleEl = $("style");
const logEl = $("log");
const statusEl = $("status");
let flowConnected = false;
let generationRunning = false;
let lastQueueSignature = "";

(async function init() {
  const stored = await chrome.storage.local.get(["style", "stylePresetVersion", "lastTitle", "lastText", "progress", "styleImageBase64", "geminiGemUrl", "generationMode", "imageModel", "aspectRatio"]);
  const shouldInstallPreset = stored.stylePresetVersion !== STYLE_PRESET_VERSION;
  styleEl.value = shouldInstallPreset ? DEFAULT_STYLE : (stored.style || DEFAULT_STYLE);
  if (shouldInstallPreset) {
    await chrome.storage.local.set({ style: DEFAULT_STYLE, stylePresetVersion: STYLE_PRESET_VERSION });
  }
  if (stored.lastTitle) $("title").value = stored.lastTitle;
  if (stored.lastText) $("text").value = stored.lastText;
  if (stored.styleImageBase64) window.styleImageBase64 = stored.styleImageBase64;
  if (stored.geminiGemUrl) $("gemUrl").value = stored.geminiGemUrl;
  if (stored.imageModel) $("imageModel").value = stored.imageModel;
  if (stored.aspectRatio) $("aspectRatio").value = stored.aspectRatio;
  const savedMode = stored.generationMode === "parallel" ? "parallel" : "sequential";
  const savedModeInput = document.querySelector(`input[name="generationMode"][value="${savedMode}"]`);
  if (savedModeInput) savedModeInput.checked = true;
  
  renderProgress(stored.progress);
  refreshFlowStatus();
})();

function getGenerationMode() {
  return document.querySelector('input[name="generationMode"]:checked')?.value === "parallel" ? "parallel" : "sequential";
}

document.querySelectorAll('input[name="generationMode"]').forEach((input) => {
  input.addEventListener("change", () => {
    chrome.storage.local.set({ generationMode: getGenerationMode() });
  });
});

styleEl.addEventListener("change", () =>
  chrome.storage.local.set({ style: styleEl.value })
);

$("styleFile").addEventListener("change", (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    window.styleImageBase64 = reader.result;
    chrome.storage.local.set({ styleImageBase64: reader.result });
  };
  reader.readAsDataURL(file);
});

$("gemUrl").addEventListener("change", () => {
  chrome.storage.local.set({ geminiGemUrl: $("gemUrl").value.trim() });
});

$("imageModel").addEventListener("change", () => {
  chrome.storage.local.set({ imageModel: $("imageModel").value });
});

$("aspectRatio").addEventListener("change", () => {
  chrome.storage.local.set({ aspectRatio: $("aspectRatio").value });
});

async function refreshFlowStatus() {
  const dot = $("flowDot");
  const label = $("flowStatus");
  dot.className = "dot";
  label.textContent = "Checking Flow...";
  try {
    const result = await chrome.runtime.sendMessage({ type: "CHECK_FLOW" });
    if (result?.ok && result.connected) {
      flowConnected = true;
      dot.classList.add("connected");
      label.textContent = `Connected — ${result.projectId.slice(0, 8)}…`;
      syncControls();
      return true;
    }
    flowConnected = false;
    dot.classList.add("error");
    label.textContent = result?.error || "Open a Flow project";
  } catch (error) {
    flowConnected = false;
    dot.classList.add("error");
    label.textContent = error.message || "Flow unavailable";
  }
  syncControls();
  return false;
}

function syncControls() {
  $("go").disabled = generationRunning || !flowConnected;
  $("resume").disabled = generationRunning || !flowConnected;
  $("stop").disabled = !generationRunning;
  document.querySelectorAll('input[name="generationMode"]').forEach((input) => {
    input.disabled = generationRunning;
  });
}

function isSafePreviewUrl(url) {
  return typeof url === "string" && (url.startsWith("https://") || url.startsWith("data:image/"));
}

function openImagePreview(item) {
  const url = isSafePreviewUrl(item.previewUrl) ? item.previewUrl : item.thumbnailUrl;
  if (!isSafePreviewUrl(url)) return;
  $("previewImage").src = url;
  $("previewCaption").textContent = `Panel ${item.index} · ${item.description || "Generated panel"}`;
  $("imagePreview").hidden = false;
}

function closeImagePreview() {
  $("imagePreview").hidden = true;
  $("previewImage").removeAttribute("src");
}

$("closePreview").addEventListener("click", closeImagePreview);
$("imagePreview").addEventListener("click", (event) => {
  if (event.target === $("imagePreview")) closeImagePreview();
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") closeImagePreview();
});

function makePreviewImage(item) {
  const url = isSafePreviewUrl(item.thumbnailUrl) ? item.thumbnailUrl : item.previewUrl;
  if (!isSafePreviewUrl(url)) return null;
  const image = document.createElement("img");
  image.src = url;
  image.alt = `Panel ${item.index}`;
  image.loading = "lazy";
  image.addEventListener("click", () => openImagePreview(item));
  image.addEventListener("error", () => image.remove());
  return image;
}

function downloadPanelImage(item) {
  const url = isSafePreviewUrl(item.previewUrl) ? item.previewUrl : item.thumbnailUrl;
  if (!url) return;
  chrome.downloads.download({
    url: url,
    filename: `ZingerBurger/panel_${String(item.index).padStart(2, "0")}.png`,
    saveAs: false
  }).catch((err) => console.error("Download failed:", err));
}

function renderLiveQueue(queue = []) {
  const signature = JSON.stringify(queue.map((item) => [
    item.index, item.status, item.attempt, item.previewUrl, item.thumbnailUrl, item.quality, item.dimensions, item.error, item.attachedCharacters
  ]));
  if (signature === lastQueueSignature) return;
  lastQueueSignature = signature;

  const total = queue.length;
  const generated = queue.filter((item) => item.status === "done").length;
  const skipped = queue.filter((item) => item.status === "skipped").length;
  const failed = queue.filter((item) => item.status === "failed").length;
  const activeStatuses = new Set(["preparing", "generating", "retrying", "waiting_quota", "upscaling", "downloading"]);
  const active = queue.filter((item) => activeStatuses.has(item.status));
  const queued = queue.filter((item) => item.status === "queued").length;

  $("queueSummary").textContent = total ? `${generated}/${total} done` : "Waiting";
  $("queueCounts").textContent = total
    ? `${queued} queued · ${active.length} active · ${generated} done${skipped ? ` · ${skipped} skip` : ""}${failed ? ` · ${failed} fail` : ""}`
    : "0 queued · 0 done";

  const currentHost = $("currentGeneration");
  currentHost.replaceChildren();
  const current = active[0] || [...queue].reverse().find((item) => item.status === "done");
  if (!current) {
    currentHost.className = "current-gen empty";
    const placeholder = document.createElement("div");
    placeholder.className = "current-placeholder";
    placeholder.textContent = total ? "Waiting for next panel..." : "Panels will appear here once generation starts.";
    currentHost.appendChild(placeholder);
  } else {
    currentHost.className = "current-gen";
    const card = document.createElement("div");
    card.className = "current-card";
    const visual = document.createElement("div");
    visual.className = "current-visual";
    const image = makePreviewImage(current);
    if (image) visual.appendChild(image);
    if (activeStatuses.has(current.status) && !image) {
      const pulse = document.createElement("div");
      pulse.className = "generation-pulse";
      visual.appendChild(pulse);
    }
    const number = document.createElement("span");
    number.className = "panel-number";
    number.textContent = `#${current.index}`;
    visual.appendChild(number);

    const copy = document.createElement("div");
    copy.className = "current-copy";
    const pill = document.createElement("span");
    pill.className = `status-pill ${current.status}`;
    pill.textContent = current.status;
    const title = document.createElement("strong");
    title.textContent = current.status === "done" ? "Latest panel" : `${current.status}…`;
    const description = document.createElement("p");
    description.textContent = current.description || `Panel ${current.index}`;
    const references = document.createElement("span");
    references.className = "reference-line";
    const names = current.attachedCharacters?.length ? current.attachedCharacters.join(", ") : "No character ref";
    references.textContent = `${names}${current.attempt ? ` · ×${current.attempt}` : ""}${current.quality ? ` · ${current.quality}` : ""}${current.dimensions ? ` · ${current.dimensions}` : ""}`;
    copy.append(pill, title, description, references);
    card.append(visual, copy);
    currentHost.appendChild(card);
  }

  const queueHost = $("queueList");
  queueHost.replaceChildren();
  if (!queue.length) {
    const empty = document.createElement("div");
    empty.className = "queue-empty";
    empty.textContent = "Queue appears after storyboard is ready.";
    queueHost.appendChild(empty);
    return;
  }

  for (const item of queue) {
    const card = document.createElement("article");
    card.className = `queue-card ${item.status}`;
    const thumb = document.createElement("div");
    thumb.className = "queue-thumb";
    const image = makePreviewImage(item);
    if (image) thumb.appendChild(image);
    else {
      const placeholder = document.createElement("span");
      placeholder.className = "queue-thumb-placeholder";
      placeholder.textContent = String(item.index).padStart(2, "0");
      thumb.appendChild(placeholder);
    }
    if (activeStatuses.has(item.status) && !image) {
      const pulse = document.createElement("div");
      pulse.className = "generation-pulse";
      thumb.appendChild(pulse);
    }
    const number = document.createElement("span");
    number.className = "panel-number";
    number.textContent = `#${item.index}`;
    thumb.appendChild(number);

    // Download button (visible on hover, only for done panels)
    if (item.status === "done" && (isSafePreviewUrl(item.previewUrl) || isSafePreviewUrl(item.thumbnailUrl))) {
      const dl = document.createElement("button");
      dl.className = "queue-download";
      dl.textContent = "⤓";
      dl.title = "Download this panel";
      dl.addEventListener("click", (e) => { e.stopPropagation(); downloadPanelImage(item); });
      thumb.appendChild(dl);
    }

    const info = document.createElement("div");
    info.className = "queue-info";
    const pill = document.createElement("span");
    pill.className = `status-pill ${item.status}`;
    pill.textContent = item.status;
    const description = document.createElement("p");
    description.textContent = item.description || `Panel ${item.index}`;
    if (item.error) description.title = item.error;
    info.append(pill, description);
    if (item.quality || item.dimensions) {
      const quality = document.createElement("span");
      quality.className = "reference-line";
      quality.textContent = [item.quality, item.dimensions ? `${item.dimensions}` : null].filter(Boolean).join(" · ");
      info.appendChild(quality);
    }
    card.append(thumb, info);
    queueHost.appendChild(card);
  }
}

$("openFlow").addEventListener("click", async () => {
  await chrome.runtime.sendMessage({ type: "OPEN_FLOW" });
  setTimeout(refreshFlowStatus, 2500);
});

$("file").addEventListener("change", async (e) => {
  const files = [...e.target.files];
  if (!files.length) return;
  if (files.length === 1) {
    $("text").value = await files[0].text();
    if (!$("title").value) $("title").value = files[0].name.replace(/\.txt$/i, "");
  } else {
    if (!await refreshFlowStatus()) return setStatus("Open a signed-in Google Flow project first.");
    const batch = await Promise.all(
      files.map(async (f) => ({
        title: f.name.replace(/\.txt$/i, ""),
        text: await f.text(),
      }))
    );
    await chrome.runtime.sendMessage({
      type: "START_BATCH",
      batch,
      style: styleEl.value,
      styleImageBase64: window.styleImageBase64,
      geminiGemUrl: $("gemUrl").value.trim(),
      generationMode: getGenerationMode(),
      imageModel: $("imageModel").value,
      aspectRatio: $("aspectRatio").value,
    });
    log(`Queued batch of ${batch.length} chapters.`);
  }
});

$("go").addEventListener("click", async () => {
  const title = $("title").value.trim() || "chapter";
  const text = $("text").value.trim();
  if (!text) return setStatus("Paste a chapter first.");
  if (!await refreshFlowStatus()) return setStatus("Open a signed-in Google Flow project first.");
  await chrome.storage.local.set({ lastTitle: title, lastText: text });
  await chrome.runtime.sendMessage({
    type: "START",
    title,
    text,
    style: styleEl.value,
    styleImageBase64: window.styleImageBase64,
    geminiGemUrl: $("gemUrl").value.trim(),
    generationMode: getGenerationMode(),
    imageModel: $("imageModel").value,
    aspectRatio: $("aspectRatio").value,
  });
  setStatus("Started! Gemini planning → Flow generating...");
});

$("stop").addEventListener("click", () => {
  chrome.runtime.sendMessage({ type: "STOP" });
  setStatus("Stop requested.");
});

$("resume").addEventListener("click", async () => {
  await chrome.runtime.sendMessage({
    type: "RESUME",
    style: styleEl.value,
    styleImageBase64: window.styleImageBase64,
    geminiGemUrl: $("gemUrl").value.trim(),
    generationMode: getGenerationMode(),
    imageModel: $("imageModel").value,
    aspectRatio: $("aspectRatio").value,
  });
});

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === "PROGRESS") renderProgress(msg.progress);
  if (msg.type === "DOWNLOAD") {
    const a = document.createElement("a");
    a.href = msg.dataUrl;
    a.download = msg.filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => document.body.removeChild(a), 100);
  }
});

function renderProgress(p) {
  if (!p) return;
  generationRunning = Boolean(p.running);
  setStatus(p.status || "");
  if (p.lines) logEl.textContent = p.lines.join("\n");
  logEl.scrollTop = logEl.scrollHeight;
  const match = String(p.status || "").match(/Panel\s+(\d+)\/(\d+)/i);
  let percent = 0;
  if (match) percent = Math.min(100, Math.round((Number(match[1]) - 1) / Number(match[2]) * 100));
  else if (p.queue?.length) percent = Math.round(p.queue.filter((item) => item.status === "done").length / p.queue.length * 100);
  else if (/done/i.test(p.status || "")) percent = 100;
  $("progressBar").style.width = `${percent}%`;
  renderLiveQueue(p.queue || []);
  syncControls();
}
function setStatus(s) {
  statusEl.textContent = s;
}
function log(s) {
  logEl.textContent += (logEl.textContent ? "\n" : "") + s;
}
