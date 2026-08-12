/* ==========================================
 * ZINGERBURGER AI WEBTOON STUDIO
 * Created by FauxGUY (https://github.com/FauxGUY)
 * 
 * WARNING: PROTECTED FILE. 
 * DO NOT EDIT WITHOUT AUTHORIZATION.
 * ========================================== */

/* global importScripts, JSZip, jspdf, CHARACTER_BIBLE */
importScripts("lib/jszip.min.js", "lib/jspdf.umd.min.js", "character_bible.js");

const FLOW_RECAPTCHA_SITE_KEY = "6LdsFiUsAAAAAIjVDZcuLhaHiDn5nnHVXVRQGeMV";
const FLOW_IMAGE_MODEL = "GEM_PIX_2";
const FLOW_IMAGE_ASPECT_RATIO = "IMAGE_ASPECT_RATIO_PORTRAIT";
const VALID_ASPECT_RATIOS = new Set(["IMAGE_ASPECT_RATIO_PORTRAIT", "IMAGE_ASPECT_RATIO_PORTRAIT_THREE_FOUR", "IMAGE_ASPECT_RATIO_SQUARE", "IMAGE_ASPECT_RATIO_LANDSCAPE_FOUR_THREE", "IMAGE_ASPECT_RATIO_LANDSCAPE"]);
const FLOW_HOME_URL = "https://flow.google/";
const GEMINI_PLANNING_TIMEOUT_MS = 20 * 60 * 1000;
const GEMINI_MESSAGE_ENVELOPE_MS = 21 * 60 * 1000;
const PARALLEL_PANEL_CONCURRENCY = 4;
const FLOW_THROTTLE_COOLDOWN_MS = 90 * 1000;
const FLOW_DAILY_QUOTA_COOLDOWN_MS = 15 * 60 * 1000;

// Open side panel when extension icon is clicked
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});

const STATE = {
  running: false,
  stopRequested: false,
  lines: [],
  status: "Idle.",
  queue: [],
};

function log(s) {
  console.log("[ZingerBurger]", s);
  STATE.lines.push(`[${new Date().toLocaleTimeString()}] ${s}`);
  if (STATE.lines.length > 300) STATE.lines.splice(0, STATE.lines.length - 300);
  push();
}
function setStatus(s) { STATE.status = s; push(); }
function push() {
  const progress = {
    status: STATE.status,
    lines: STATE.lines,
    running: STATE.running,
    queue: STATE.queue,
  };
  chrome.storage.local.set({ progress });
  chrome.runtime.sendMessage({ type: "PROGRESS", progress }).catch(() => {});
}

function initializePanelQueue(panels, completedPanels = []) {
  const completed = new Set(completedPanels.map((panel) => panel.index));
  STATE.queue = (panels || []).map((panel, index) => ({
    index: index + 1,
    sourceIndex: panel.index || index + 1,
    status: completed.has(index + 1) ? "done" : "queued",
    attempt: 0,
    description: panel.description || panel.action || `Panel ${index + 1}`,
    characters: panel.characters_present || [],
    attachedCharacters: [],
    previewUrl: null,
    thumbnailUrl: null,
    mediaId: null,
    quality: null,
    dimensions: null,
    error: null,
  }));
  push();
}

function updateQueueItem(index, changes) {
  const item = STATE.queue.find((entry) => entry.index === index);
  if (!item) return;
  Object.assign(item, changes, { updatedAt: Date.now() });
  push();
}

chrome.runtime.onMessage.addListener((msg, _s, sendResponse) => {
  if (msg.type === "START") {
    runChapter(msg.title, msg.text, msg.style, msg.styleImageBase64, msg.geminiGemUrl, false, msg.generationMode, msg.imageModel, msg.aspectRatio).catch((e) => {
      log("ERROR: " + (e?.message || e));
      STATE.running = false; setStatus("Failed.");
    });
    sendResponse({ ok: true });
  } else if (msg.type === "RESUME") {
    if (!CHAPTER_STATE.isResumable || !CHAPTER_STATE.title) {
      log("Nothing to resume.");
    } else {
      runChapter(CHAPTER_STATE.title, CHAPTER_STATE.text, msg.style, msg.styleImageBase64, msg.geminiGemUrl, true, msg.generationMode, msg.imageModel, msg.aspectRatio).catch((e) => {
        log("ERROR: " + (e?.message || e));
        STATE.running = false; setStatus("Failed.");
      });
    }
    sendResponse({ ok: true });
  } else if (msg.type === "START_BATCH") {
    runBatch(msg.batch, msg.style, msg.styleImageBase64, msg.geminiGemUrl, msg.generationMode, msg.imageModel, msg.aspectRatio).catch((e) => {
      log("ERROR: " + (e?.message || e));
      STATE.running = false; setStatus("Failed.");
    });
    sendResponse({ ok: true });
  } else if (msg.type === "STOP") {
    STATE.stopRequested = true;
    log("Stop requested.");
    sendResponse({ ok: true });
  } else if (msg.type === "CHECK_FLOW") {
    getFlowContext().then((flow) => {
      sendResponse({ ok: true, connected: true, projectId: flow.projectId });
    }).catch((error) => {
      sendResponse({ ok: false, connected: false, error: error.message });
    });
  } else if (msg.type === "OPEN_FLOW") {
    openOrFocusFlow().then(() => sendResponse({ ok: true })).catch((error) => {
      sendResponse({ ok: false, error: error.message });
    });
  }
  return true;
});

async function runBatch(batch, style, styleImg, gemUrl, generationMode = "sequential", imageModel = "GEM_PIX_2", aspectRatio = null) {
  for (const item of batch) {
    if (STATE.stopRequested) break;
    await runChapter(item.title, item.text, style, styleImg, gemUrl, false, generationMode, imageModel, aspectRatio);
  }
}

let CHAPTER_STATE = { title: null, text: null, plan: null, panelBlobs: [], isResumable: false, generationMode: "sequential", imageModel: "GEM_PIX_2", aspectRatio: FLOW_IMAGE_ASPECT_RATIO };

async function runChapter(title, text, style, styleImg = null, gemUrl = null, isResume = false, requestedGenerationMode = "sequential", imageModel = "GEM_PIX_2", aspectRatio = null) {
  if (STATE.running) { log("Already running."); return; }
  STATE.running = true;
  STATE.stopRequested = false;
  const generationMode = requestedGenerationMode === "parallel" ? "parallel" : "sequential";
  const resolvedAspectRatio = VALID_ASPECT_RATIOS.has(aspectRatio) ? aspectRatio : FLOW_IMAGE_ASPECT_RATIO;

  setStatus("Connecting to Google Flow...");
  const flow = await getFlowContext();
  log(`Connected to Flow project ${flow.projectId.slice(0, 8)}...`);
  
  if (!isResume) {
    STATE.lines = [];
    STATE.queue = [];
    setStatus(`Starting "${title}"...`);
    CHAPTER_STATE = { title, text, plan: null, panelBlobs: [], isResumable: true, generationMode, imageModel, aspectRatio: resolvedAspectRatio };

    // ---------- STEP 1: storyboard tab — get bible + panel prompts ----------
    // Gemini is planning-only; Google Flow generates all panel images.
    const storyTabId = await openFreshGeminiTab(gemUrl);
    setStatus("Gemini is building storyboard JSON...");
    log("Asking Gemini for the character bible, environment bible, and panel JSON. Gemini will not generate images.");
    
    let planText;
    try {
      planText = await sendToContent(storyTabId, {
        type: "ASK_TEXT",
        prompt: buildPlanPrompt(text, style),
        timeoutMs: GEMINI_PLANNING_TIMEOUT_MS,
      }, GEMINI_MESSAGE_ENVELOPE_MS);
    } finally {
      safeCloseTab(storyTabId);
    }
    
    try {
      CHAPTER_STATE.plan = parsePlan(planText);
    } catch (parseErr) {
      throw new Error("Could not parse story plan. " + parseErr.message);
    }
    
    if (!CHAPTER_STATE.plan || !CHAPTER_STATE.plan.panels?.length) {
      throw new Error("Story plan was empty or invalid. Raw start: " + (planText||"").slice(0,200));
    }
    initializePanelQueue(CHAPTER_STATE.plan.panels);
    log(`Got ${CHAPTER_STATE.plan.characters?.length||0} characters, ${CHAPTER_STATE.plan.environments?.length||0} environments, ${CHAPTER_STATE.plan.panels.length} panels.`);
  } else {
    CHAPTER_STATE.generationMode = generationMode;
    CHAPTER_STATE.aspectRatio = resolvedAspectRatio;
    if (imageModel) CHAPTER_STATE.imageModel = imageModel;
    else imageModel = CHAPTER_STATE.imageModel;
    if (!STATE.queue.length) initializePanelQueue(CHAPTER_STATE.plan?.panels, CHAPTER_STATE.panelBlobs);
    log(`Resuming chapter "${CHAPTER_STATE.title}" in ${generationMode} mode...`);
  }

  const plan = CHAPTER_STATE.plan;
  const panelBlobs = CHAPTER_STATE.panelBlobs;
  const builtInStyleRef = await getExtensionFileAsBase64("assets/lotm_style_reference.png");
  if (!builtInStyleRef) throw new Error("The bundled LOTM style reference is missing or unreadable.");

  setStatus("Uploading references to Google Flow...");
  log(`Storyboard accepted. Starting Google Flow handoff in ${generationMode} mode.`);
  const styleMediaId = await uploadReferenceUntilSuccess(flow, builtInStyleRef, "lotm_style_reference.png", "LOTM style reference");
  const supplementalStyleMediaId = styleImg
    ? await uploadReferenceUntilSuccess(flow, styleImg, "supplemental_style_reference.png", "supplemental style reference")
    : null;
  if (STATE.stopRequested) {
    log("Stopped during the Flow reference handoff.");
    STATE.running = false;
    setStatus("Stopped.");
    return;
  }
  const characterMediaIds = new Map();
  const flowCapacityGate = { blockedUntil: 0, reason: null };
  log("LOTM style reference uploaded to Flow.");

  const getFlowCapacityIssue = (error) => {
    const message = String(error?.message || error || "");
    if (/PUBLIC_ERROR_PER_MODEL_DAILY_QUOTA_REACHED|daily quota/i.test(message)) {
      return { type: "daily", label: "Flow's daily model quota is exhausted", cooldownMs: FLOW_DAILY_QUOTA_COOLDOWN_MS };
    }
    if (/PUBLIC_ERROR_USER_REQUESTS_THROTTLED|RESOURCE_EXHAUSTED|HTTP 429|too many requests/i.test(message)) {
      return { type: "throttled", label: "Flow is temporarily throttling parallel requests", cooldownMs: FLOW_THROTTLE_COOLDOWN_MS };
    }
    return null;
  };

  const registerFlowCapacityPause = (issue) => {
    const proposedUntil = Date.now() + issue.cooldownMs;
    const previousUntil = flowCapacityGate.blockedUntil;
    const extendsPause = proposedUntil > previousUntil + 1000;
    flowCapacityGate.blockedUntil = Math.max(flowCapacityGate.blockedUntil, proposedUntil);
    if (proposedUntil >= previousUntil || issue.type === "daily") flowCapacityGate.reason = issue.label;
    if (extendsPause) {
      log(`${issue.label}. Pausing the entire Flow queue for ${Math.round(issue.cooldownMs / 60000)} minute(s) instead of repeatedly sending rejected requests.`);
    }
  };

  const waitForFlowCapacity = async (panelNumber) => {
    if (Date.now() >= flowCapacityGate.blockedUntil) return;
    const reason = flowCapacityGate.reason || "Flow capacity is unavailable";
    updateQueueItem(panelNumber, { status: "waiting_quota", error: reason });
    while (!STATE.stopRequested && Date.now() < flowCapacityGate.blockedUntil) {
      const remainingSeconds = Math.max(1, Math.ceil((flowCapacityGate.blockedUntil - Date.now()) / 1000));
      const done = panelBlobs.length;
      setStatus(`${reason} — ${done}/${plan.panels.length} saved. Automatic retry in ${remainingSeconds}s.`);
      await sleep(Math.min(5000, remainingSeconds * 1000));
    }
    if (Date.now() >= flowCapacityGate.blockedUntil) {
      flowCapacityGate.blockedUntil = 0;
      flowCapacityGate.reason = null;
    }
  };

  // ---------- STEP 2: Google Flow API generates every panel image ----------
  // Cache promises, not only finished IDs, so parallel panels that use the same
  // character share one upload rather than racing duplicate uploads.
  const getCharacterMediaId = async (canon) => {
    let uploadPromise = characterMediaIds.get(canon.name);
    if (!uploadPromise) {
      uploadPromise = (async () => {
        const dataUrl = await getExtensionFileAsBase64(canon.image);
        if (!dataUrl) throw new Error(`Character reference is unreadable: ${canon.name}`);
        const mediaId = await uploadDataUrlToFlow(flow, dataUrl, canon.image.split("/").pop());
        log(`Uploaded character reference: ${canon.name}.`);
        return mediaId;
      })();
      characterMediaIds.set(canon.name, uploadPromise);
    }
    try {
      return await uploadPromise;
    } catch (error) {
      if (characterMediaIds.get(canon.name) === uploadPromise) characterMediaIds.delete(canon.name);
      throw error;
    }
  };

  const generatePanelAtIndex = async (i) => {
    if (STATE.stopRequested) return;
    const panel = plan.panels[i];
    const panelNumber = i + 1;
    updateQueueItem(panelNumber, { status: "preparing", attempt: 0, error: null });
    setStatus(generationMode === "parallel"
      ? `Parallel Flow generation — ${panelBlobs.length}/${plan.panels.length} done...`
      : `Panel ${panelNumber}/${plan.panels.length} — generating...`);
    log(`Panel ${panelNumber}: ${panel.description?.slice(0,90) || panel}`);

    let imageInputs = null;
    let attachedCharacters = [];
    let flowReferenceGuide = "";
    let preparationAttempt = 0;
    while (!imageInputs && !STATE.stopRequested) {
      preparationAttempt += 1;
      try {
        const preparedInputs = [{ imageInputType: "IMAGE_INPUT_TYPE_REFERENCE", name: styleMediaId }];
        if (supplementalStyleMediaId) {
          preparedInputs.push({ imageInputType: "IMAGE_INPUT_TYPE_REFERENCE", name: supplementalStyleMediaId });
        }
        const preparedCharacters = [];
        const attachedCanonicalNames = new Set();
        for (const name of panel.characters_present || []) {
          const canon = findCanonicalCharacter(name);
          if (canon?.image && !attachedCanonicalNames.has(canon.name)) {
            attachedCanonicalNames.add(canon.name);
            const mediaId = await getCharacterMediaId(canon);
            preparedInputs.push({ imageInputType: "IMAGE_INPUT_TYPE_REFERENCE", name: mediaId });
            preparedCharacters.push(canon.name);
          }
        }
        imageInputs = preparedInputs;
        attachedCharacters = preparedCharacters;
        flowReferenceGuide = buildFlowReferenceGuide(attachedCharacters, Boolean(supplementalStyleMediaId));
        updateQueueItem(panelNumber, { attachedCharacters, error: null });
        log(`Panel ${panelNumber} references: LOTM style${supplementalStyleMediaId ? " + supplemental style" : ""}${attachedCharacters.length ? " + " + attachedCharacters.join(", ") : " (no listed character portrait needed)"}.`);
      } catch (error) {
        updateQueueItem(panelNumber, { status: "retrying", attempt: preparationAttempt, error: error.message });
        const delay = Math.min(30000, preparationAttempt * 3000);
        log(`Panel ${panelNumber} reference preparation failed: ${error.message}. Retrying in ${Math.round(delay / 1000)}s.`);
        await sleep(delay);
      }
    }
    if (STATE.stopRequested) {
      updateQueueItem(panelNumber, { status: "stopped", attempt: preparationAttempt });
      return;
    }

    let imgPrompt = buildPanelImagePrompt(style, plan, panel, panelNumber, plan.panels.length) + flowReferenceGuide;
    let blob = null;
    let achievedQuality = null;
    let achievedDimensions = null;
    let attempt = 0;
    let safetyFailCount = 0;
    let invalidModelFailCount = 0;
    const MAX_SAFETY_RETRIES = 5;
    while (!blob && !STATE.stopRequested) {
      await waitForFlowCapacity(panelNumber);
      if (STATE.stopRequested) break;
      attempt += 1;
      let capacityIssue = null;
      try {
        updateQueueItem(panelNumber, {
          status: attempt === 1 ? "generating" : "retrying",
          attempt,
          error: null,
        });
        log(`Panel ${panelNumber} attempt ${attempt}: sending to Google Flow using model ${imageModel}...`);
        const result = await generateFlowImage(flow, imgPrompt, imageInputs, imageModel);
        if (!result.fifeUrl || !result.mediaId) throw new Error("Flow returned no complete image media result.");
        updateQueueItem(panelNumber, {
          status: "upscaling",
          previewUrl: result.fifeUrl,
          mediaId: result.mediaId,
        });
        const qualityResult = await fetchMaximumQualityFlowImage(flow, result.mediaId);
        blob = qualityResult.blob;
        achievedQuality = qualityResult.quality;
        achievedDimensions = { width: qualityResult.width, height: qualityResult.height };
        const thumbnailUrl = await createPreviewThumbnail(blob).catch(() => null);
        updateQueueItem(panelNumber, {
          status: "done",
          thumbnailUrl,
          quality: qualityResult.quality,
          dimensions: `${qualityResult.width}×${qualityResult.height}`,
          error: null,
        });
        log(`Panel ${panelNumber} saved from Flow's ${qualityResult.quality} upscale at ${qualityResult.width}×${qualityResult.height} (${Math.round(blob.size/1024)} KB).`);
      } catch (e) {
        const safetyRejection = isFlowSafetyRejection(e);
        capacityIssue = getFlowCapacityIssue(e);
        updateQueueItem(panelNumber, { status: capacityIssue ? "waiting_quota" : "retrying", attempt, error: e.message });
        log(`Panel ${panelNumber} attempt ${attempt} failed: ${e.message}`);
        if (capacityIssue) {
          registerFlowCapacityPause(capacityIssue);
        } else if (safetyRejection) {
          safetyFailCount += 1;
          const safetyLevel = safetyFailCount >= 5 ? 3 : Math.min(2, safetyFailCount);
          log(`Flow safety filter rejected panel ${panelNumber} (${safetyFailCount} time(s)). Rebuilding prompt at safety level ${safetyLevel}.`);
          imgPrompt = buildPanelImagePrompt(style, plan, panel, panelNumber, plan.panels.length, safetyLevel) + flowReferenceGuide;
        } else if (/INVALID_ARGUMENT/i.test(e.message) && !/UNSAFE_GENERATION/i.test(e.message)) {
          invalidModelFailCount += 1;
          if (invalidModelFailCount >= 3 && imageModel !== FLOW_IMAGE_MODEL) {
            log(`Panel ${panelNumber}: model "${imageModel}" is not recognized by Flow after ${invalidModelFailCount} failures. Falling back to ${FLOW_IMAGE_MODEL} (Nano Banana Pro).`);
            imageModel = FLOW_IMAGE_MODEL;
          } else {
            log(`Panel ${panelNumber} received a Flow request error. Retrying...`);
          }
        }
      }

      if (!blob && !STATE.stopRequested) {
        if (capacityIssue) {
          log(`Panel ${panelNumber} is safely queued behind the shared Flow quota pause.`);
        } else {
          const retryDelayMs = Math.min(30000, 3000 + Math.max(0, attempt - 1) * 3000);
          log(`Panel ${panelNumber} is still required. Retrying in ${Math.round(retryDelayMs / 1000)}s.`);
          await sleep(retryDelayMs);
        }
      }
    }

    if (STATE.stopRequested) {
      updateQueueItem(panelNumber, { status: "stopped", attempt });
      log(`Stopped while retrying panel ${panelNumber}.`);
      return;
    }
    panelBlobs.push({ index: panelNumber, prompt: imgPrompt, panel, blob, quality: achievedQuality, dimensions: achievedDimensions });
    if (generationMode === "parallel") {
      setStatus(`Parallel Flow generation — ${panelBlobs.length}/${plan.panels.length} done...`);
    }
  };

  const completedPanelIndexes = new Set(panelBlobs.map((entry) => entry.index));
  const pendingPanelIndexes = plan.panels
    .map((_panel, index) => index)
    .filter((index) => !completedPanelIndexes.has(index + 1));

  log(generationMode === "parallel"
    ? `Parallel Batch mode: using ${Math.min(PARALLEL_PANEL_CONCURRENCY, pendingPanelIndexes.length)} simultaneous Flow workers for ${pendingPanelIndexes.length} remaining panels. Each panel retries independently until successful.`
    : `Reliable Sequential mode: generating ${pendingPanelIndexes.length} remaining panels one by one.`);

  if (generationMode === "parallel") {
    let nextPendingPosition = 0;
    const worker = async () => {
      while (!STATE.stopRequested) {
        const position = nextPendingPosition;
        nextPendingPosition += 1;
        if (position >= pendingPanelIndexes.length) return;
        await generatePanelAtIndex(pendingPanelIndexes[position]);
      }
    };
    const workerCount = Math.min(PARALLEL_PANEL_CONCURRENCY, pendingPanelIndexes.length);
    await Promise.all(Array.from({ length: workerCount }, () => worker()));
  } else {
    for (const index of pendingPanelIndexes) {
      if (STATE.stopRequested) break;
      await generatePanelAtIndex(index);
      if (!STATE.stopRequested) await sleep(2000);
    }
  }

  if (!panelBlobs.length) throw new Error("No panels generated.");
  panelBlobs.sort((a, b) => a.index - b.index);

  // ---------- STEP 3: stitch + zip ----------
  setStatus("Stitching panels...");
  const { parts: stitchedParts, width, totalHeight } = await stitchVertical(panelBlobs);
  log(`Prepared ${panelBlobs.length} panels as ${stitchedParts.length} ordered webtoon part(s), up to ${width}px wide (${totalHeight}px total height).`);

  setStatus("Packaging zip...");
  const zip = new JSZip();
  const webtoonDir = zip.folder("webtoon_parts");
  for (let index = 0; index < stitchedParts.length; index++) {
    const part = stitchedParts[index];
    const partNumber = String(index + 1).padStart(2, "0");
    const start = String(part.startIndex).padStart(2, "0");
    const end = String(part.endIndex).padStart(2, "0");
    const extension = part.blob.type === "image/png" ? "png" : part.blob.type === "image/webp" ? "webp" : "jpg";
    webtoonDir.file(`part_${partNumber}_panels_${start}-${end}.${extension}`, part.blob);
  }
  const panelsDir = zip.folder("panels");
  for (const p of panelBlobs) {
    const extension = p.blob.type === "image/png" ? "png" : p.blob.type === "image/webp" ? "webp" : "jpg";
    panelsDir.file(`${String(p.index).padStart(2, "0")}.${extension}`, p.blob);
  }
  zip.file("plan.json", JSON.stringify(plan, null, 2));
  zip.file("prompts.json", JSON.stringify({
    title, style,
    panels: panelBlobs.map((p) => ({ index: p.index, quality: p.quality, dimensions: p.dimensions, panel: p.panel, prompt: p.prompt })),
  }, null, 2));
  zip.file("quality_manifest.json", JSON.stringify({
    policy: "Flow 4K upscale first; strict 2K minimum fallback; preview/original generation files are never packaged as final panels.",
    combinedWebtoon: { width, totalHeight, parts: stitchedParts.length, format: "lossless PNG where supported; original full-resolution panel format on canvas fallback" },
    panels: panelBlobs.map((p) => ({
      index: p.index,
      quality: p.quality,
      width: p.dimensions?.width,
      height: p.dimensions?.height,
      bytes: p.blob.size,
      mimeType: p.blob.type,
    })),
  }, null, 2));
  
  const zipBlob = await zip.generateAsync({ type: "blob", compression: "STORE", streamFiles: true });
  const safe = title.replace(/[^a-z0-9_\-]+/gi, "_").slice(0, 60) || "chapter";
  
  // Persist large files through IndexedDB and let an offscreen extension page
  // create Blob URLs. This avoids oversized Base64 runtime messages.
  const zipDownload = await downloadLargeBlob(zipBlob, `ZingerBurger/${safe}.zip`);
  log(`ZIP download started (ID ${zipDownload}).`);

  let pdfSaved = false;
  try {
    setStatus("Building memory-safe PDF...");
    const pdfParts = [];
    for (const part of stitchedParts) pdfParts.push(await makePdfSafePart(part));
    const { jsPDF } = self.jspdf;
    const firstPart = pdfParts[0];
    const pdf = new jsPDF({ orientation: 'portrait', unit: 'px', format: [firstPart.width, firstPart.height] });
    for (let index = 0; index < pdfParts.length; index++) {
      const part = pdfParts[index];
      const dataUrl = await blobToDataUrl(part.blob);
      if (index > 0) pdf.addPage([part.width, part.height], 'portrait');
      pdf.addImage(dataUrl, 'JPEG', 0, 0, part.width, part.height, undefined, 'FAST');
    }
    const pdfBlob = pdf.output("blob");
    const pdfDownload = await downloadLargeBlob(pdfBlob, `ZingerBurger/${safe}.pdf`);
    log(`PDF download started (ID ${pdfDownload}).`);
    pdfSaved = true;
  } catch (pdfError) {
    log(`PDF export failed, but the full-quality ZIP was saved safely: ${pdfError.message}`);
  }
  
  log(pdfSaved ? `Generated ${safe}.zip and .pdf. Downloads started.` : `Generated ${safe}.zip. PDF could not be built, but no panels were lost.`);
  setStatus(pdfSaved ? `Done: ZIP + PDF saved.` : `Done: Full-quality ZIP saved; PDF failed.`);
  STATE.running = false;
}

// ---------- prompt builders ----------
function buildPlanPrompt(chapter, style) {
  return `You are a Lord of Mysteries manhwa storyboard director working in the established LOTM donghua visual world.
Read the chapter and produce a STRICT JSON object (no prose, no code fence) with this exact schema:

{
  "characters": [
    {
      "name": "string",
      "appearance": "hair colour + length + style, eye colour, skin tone, build, age look, distinguishing features",
      "outfit": "every garment from head to toe with EXACT colours, fabrics, accessories, weapons.",
      "palette": ["#hex","#hex","#hex"]
    }
  ],
  "environments": [
    {
      "name": "string",
      "description": "architecture, props, time of day, weather, lighting colour, fog/gas density, palette"
    }
  ],
  "panels": [
    {
      "index": 1,
      "characters_present": ["name", "..."],
      "environment": "name",
      "camera": "shot type + angle (e.g. low-angle medium shot)",
      "action": "what is happening in this single frame, faithful to the chapter",
      "mood": "emotion + lighting cue",
      "description": "ONE self-contained sentence the image model will read",
      "narration": "Full scene description / narrator text as a caption (to replace reading the novel)",
      "dialogue": "Full conversation dialogue from the chapter, word-for-word if possible (or null if none)",
      "dialogue_speaker": "The specific name of the character speaking the dialogue (or null if none)",
      "wardrobe": {"Exact character name": "scene-specific garments, colors, materials, accessories, and weapons; use MASTER BIBLE default only when the chapter gives no override"},
      "text_treatment": "one of: spoken_dialogue, internal_thought, spiky_narration, ink_splatter_narration, mixed, none",
      "sound_effect": "Exact onomatopoeia from the chapter, such as BANG or MURMUR, or null"
    }
  ]
}

RULES:
- TARGET 15-20 PANELS. Focus on the KEY moments: important dialogue exchanges, pivotal actions, emotional beats, scene transitions, and dramatic reveals. Do NOT create a panel for every single sentence or minor thought. Combine minor consecutive thoughts or small actions into a single panel. Skip mundane transitions. Quality over quantity.
- If the chapter is very long or dialogue-heavy, you may go up to 25-30 panels max, but never more. Prioritize impactful scenes.
- Identify every listed LOTM character even when the chapter uses a title, surname, Tarot Club codename, or persona. In characters_present, output the canonical "name" from the MASTER CHARACTER BIBLE so its reference portrait can be attached automatically.
- CRITICAL IDENTITY RULE: Klein has distinct visual identities (Klein Moretti, Gehrman Sparrow, Sherlock Moriarty, Dwayne Dantes, and others). Deduce the active identity from chapter context and output that exact canonical persona in characters_present. Never use a generic Klein label when a disguise is active.
- For character "appearance", YOU MUST USE THE EXACT descriptions from the MASTER CHARACTER BIBLE below. Never redesign a canonical character.
- For character "outfit", carefully extract the outfit details directly from the chapter text. IF the chapter does not mention their clothing, use the default outfit described in the MASTER BIBLE (which matches their reference image). Maintain outfit consistency within the same scene.
- Populate every panel's wardrobe object for every visible character. A chapter-explicit disguise, uniform, damaged garment, removed hat/coat, or changed accessory OVERRIDES the MASTER BIBLE outfit for that scene. Repeat the exact locked wardrobe in every panel of that scene; do not drift colors, layers, accessories, or weapons between shots.
- INCIDENTAL NPC CASTING: Give every recurring unnamed person a stable unique name such as "NPC-01 Elderly Clerk" and include that exact name in characters and characters_present. Design each NPC with a visibly different facial fingerprint: age range, gender presentation, ancestry/skin tone, face shape, nose, eye shape, jaw/chin, hair style/color, body build, height impression, and one distinguishing feature. Never reuse a named character's face or another NPC's face. Preserve an NPC's fingerprint only when that same NPC ID returns.
- Crowd/background extras must show deliberate variety in age, face shape, skin tone, hair, build, height, hats, coat silhouettes, and muted Victorian garment colors. No twins, cloned faces, repeated hairstyles, duplicated outfits, or copy-pasted poses unless the chapter explicitly describes twins or uniforms.
- Environments must match the chapter's described locations.
- Choose text_treatment from the schema based on meaning: private thoughts use internal_thought; short reflective narration uses spiky_narration; cinematic or scene-transition narration uses ink_splatter_narration; panels containing more than one treatment use mixed.
- Preserve dialogue, narration, thoughts, and sound effects word-for-word. Split long conversations across separate panels rather than compressing them.
- Output JSON ONLY. No markdown. No explanation. Properly escape double quotes inside JSON string values with a backslash.

MASTER CHARACTER BIBLE (Use these exact descriptions):
${JSON.stringify(CHARACTER_BIBLE, null, 2)}

ART STYLE (for your reference only — do NOT include in JSON, we will append it later):
${style}

CHAPTER:
"""
${chapter}
"""`;
}

function formatBibleForPanel(plan, panel) {
  const charsPresent = panel.characters_present || [];
  const wardrobe = panel.wardrobe && typeof panel.wardrobe === "object" ? panel.wardrobe : {};
  const wardrobeFor = (name) => {
    const wanted = normalizeCharacterName(name);
    const key = Object.keys(wardrobe).find((candidate) => normalizeCharacterName(candidate) === wanted);
    return key ? wardrobe[key] : null;
  };
  const chars = charsPresent.map(name => {
    const canon = findCanonicalCharacter(name);
    const sceneOutfit = wardrobeFor(name);
    if (canon) return `- ${canon.name}: IDENTITY/FACE LOCK: ${canon.appearance}. SCENE WARDROBE LOCK: ${sceneOutfit || canon.outfit}. DEFAULT BIBLE OUTFIT (ignore when scene wardrobe differs): ${canon.outfit}. PALETTE: ${(canon.palette||[]).join(", ")}`;
    
    const p = (plan.characters||[]).find(c => c.name.toLowerCase() === name.toLowerCase());
    if (p) return `- ${p.name}: UNIQUE IDENTITY/FACE LOCK: ${p.appearance}. SCENE WARDROBE LOCK: ${sceneOutfit || p.outfit}. PALETTE: ${(p.palette||[]).join(", ")}`;
    
    return `- ${name}: (Appearance unknown)`;
  }).join("\n");
    
  const envName = panel.environment;
  const envs = (plan.environments||[])
    .filter(e => e.name === envName)
    .map((e) => `- ${e.name}: ${e.description}`)
    .join("\n");
  return `CHARACTER REFERENCES:\n${chars}\n\nENVIRONMENT:\n${envs}`;
}

function normalizeCharacterName(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function findCanonicalCharacter(value) {
  const target = normalizeCharacterName(value);
  if (!target) return null;
  return CHARACTER_BIBLE.find((character) => {
    const names = [character.name, ...(character.aliases || [])].map(normalizeCharacterName);
    return names.some((name) => name === target || name.includes(target) || target.includes(name));
  }) || null;
}

function buildFlowReferenceGuide(attachedCharacters, hasSupplementalStyle) {
  let imageNumber = 1;
  const lines = [
    `REFERENCE IMAGE ${imageNumber}: LOTM STYLE ONLY. Copy its linework, cel shading, contrast, lighting, palette, and 2D rendering technique. Do NOT copy its depicted person, pose, ravens, costume, or background unless the scene explicitly requires them.`
  ];
  if (hasSupplementalStyle) {
    imageNumber += 1;
    lines.push(`REFERENCE IMAGE ${imageNumber}: SUPPLEMENTAL STYLE ONLY. Use its rendering technique, not its subject matter.`);
  }
  for (const characterName of attachedCharacters) {
    imageNumber += 1;
    lines.push(`REFERENCE IMAGE ${imageNumber}: CANONICAL PORTRAIT OF ${characterName.toUpperCase()}. Copy this exact character's face, hair, eyes, skin tone, and body type. Use its outfit only when the SCENE WARDROBE LOCK matches the portrait default; otherwise the written scene wardrobe completely overrides portrait clothing. Do not blend this identity with any other reference.`);
  }
  return `\n\nEXACT FLOW REFERENCE MAP — follow image positions strictly:\n${lines.map((line) => `- ${line}`).join("\n")}\n- Never invent a replacement design for a character who has a portrait reference. Never copy the style reference's character identity into the scene.`;
}

function isFlowSafetyRejection(error) {
  return /PUBLIC_ERROR_UNSAFE_GENERATION|unsafe[_ ]generation|safety|policy rejected|blocked for safety/i.test(String(error?.message || error || ""));
}

function makeFlowScenePolicySafe(value, level = 1) {
  let text = String(value || "");
  const substitutions = [
    [/\b(distressed|desperate|terrified|terrorized)\b/gi, "weary"],
    [/\b(skulk(?:s|ed|ing)?|stalk(?:s|ed|ing)?)\b/gi, "move quietly"],
    [/\b(blood(?:y|ied|stained)?|gore|gory|viscera)\b/gi, "dark symbolic marks"],
    [/\b(corpse|cadaver|dead body|mutilated remains?)\b/gi, "covered, indistinct silhouette"],
    [/\b(kill(?:s|ed|ing)?|murder(?:s|ed|ing)?|slaughter(?:s|ed|ing)?|execute(?:s|d|ing)?)\b/gi, "overcome"],
    [/\b(stab(?:s|bed|bing)?|shoot(?:s|ing)?|shot|strangle(?:s|d|ing)?|behead(?:s|ed|ing)?)\b/gi, "confront"],
    [/\b(wound(?:s|ed|ing)?|injur(?:y|ies|ed)|bruis(?:e|es|ed|ing))\b/gi, "signs of exhaustion"],
    [/\b(tortur(?:e|es|ed|ing)|suicid(?:e|al)|self[- ]harm)\b/gi, "off-screen danger"],
    [/\b(gunfire|gunshot|explosion|explodes?|detonates?)\b/gi, "a dramatic off-screen disturbance"],
  ];
  for (const [pattern, replacement] of substitutions) text = text.replace(pattern, replacement);
  if (level >= 3) {
    // Nuclear option: strip everything remotely triggering
    text = text
      .replace(/\b(dark|darkness|shadow(?:s|y)?|black|pitch[- ]?black|void|abyss|ominous|sinister|menacing|creepy|eerie|dread|horror|cosmic|occult|demon(?:ic)?|evil|curse(?:d)?|corrupt(?:ed|ion)?|madness|insanity|deform(?:ed|ity)?|tumor(?:s)?|mutant|noseless|scarred?|ugly|grotesque|monstrous|hideous|undead|spectral|ghostly|wraith|phantom|spirit)\b/gi, "mysterious")
      .replace(/\b(weapon(?:s)?|sword|blade|dagger|gun|rifle|pistol|spear|axe|knife|whip|arrow)\b/gi, "ornamental object")
      .replace(/\b(fight(?:ing)?|combat|battle|attack(?:s|ed|ing)?|defend(?:ing)?|clash|strike|punch|kick|hit|slam)\b/gi, "dramatic confrontation")
      .replace(/\b(fear|afraid|panic(?:ked)?|anxiety|anxious|worry|worried|dread(?:ful)?|frighten(?:ed)?)\b/gi, "concern")
      .replace(/\b(anger|angry|rage|fury|furious|wrath|hostile|aggress(?:ive|ion))\b/gi, "determination")
      .replace(/\b(scream(?:s|ed|ing)?|shriek|cry|sob(?:s|bed|bing)?|wail|moan|groan)\b/gi, "call out")
      .replace(/\b(tense|tenses|tensed|tensing)\b/gi, "alert")
      .replace(/\b(defensive|combat|fighting)\s+(posture|stance|position)/gi, "ready stance");
    text = `Completely safe, family-friendly illustration: ${text}. All characters are calm, composed, and in no danger. This is a peaceful scene with gentle lighting.`;
  } else if (level >= 2) {
    text = `Policy-safe symbolic depiction, with no harmful act shown on-screen: ${text}. Communicate any danger only through expressions, posture, lighting, environment, and non-graphic symbolism.`;
  }
  return text;
}

function buildPanelImagePrompt(style, plan, panel, idx, total, safetyLevel = 0) {
  const present = (panel.characters_present||[]).join(", ");
  const bible = formatBibleForPanel(plan, panel);
  const safe = (value) => safetyLevel ? makeFlowScenePolicySafe(value, safetyLevel) : value;
  
  let prompt = `Generate ONE vertical Lord of Mysteries webtoon scene. CRITICAL RULE: DO NOT INCLUDE ANY PANELS OR ARTIFICIAL BORDERS. IT MUST BE A SINGLE EDGE-TO-EDGE IMAGE. Keep faces, hands, characters, and essential story action inside the central composition-safe area.

  SCENE DESCRIPTION:
  ${safe(panel.description)}

  ENVIRONMENT:
  ${safe(formatBibleForPanel(plan, panel))}
  
  ACTION: ${safe(panel.action)}
  MOOD: ${safe(panel.mood)}
  CAMERA: ${panel.camera}

  CRITICAL: ABSOLUTELY NO TEXT IN THE IMAGE. Do NOT draw any speech bubbles, dialogue text, narration boxes, captions, sound effects, lettering, or any written words of any kind. The image must be PURELY VISUAL with ZERO text elements. This is a strict requirement.

  ART STYLE (must apply, verbatim):
  ${style}

  CRITICAL CHARACTER AND WARDROBE INSTRUCTION:
  - Draw canonical LOTM identities from their portrait references with strict 1:1 facial features, hair, eyes, and body build.
  - For clothing, the SCENE WARDROBE LOCK in CHARACTER REFERENCES is authoritative. Do not copy a portrait's default clothing when the scene wardrobe lock specifies a disguise or different outfit. Reproduce every locked garment layer, color, material, accessory, hat, and weapon exactly.
  - Never merge one character's face, clothing, palette, or accessories into another character.
  - Every NPC name/ID represents a separately cast actor. Make NPC faces unmistakably different in age, face silhouette, eye shape, nose, jaw, skin tone, hair, build, and distinguishing feature.

  REFERENCE INPUT RULES: The FIRST reference image is the mandatory LOTM rendering reference; use it for sharp linework, cel shading, contrast, lighting, and color treatment. Any second supplemental-style image is also style-only. All remaining reference images are canonical character portraits; use those for exact face, hair, skin tone, and body identity. Clothing always follows the SCENE WARDROBE LOCK; copy portrait clothing only when it is the locked outfit.

  ABSOLUTE NEGATIVE PROMPT: no text, no speech bubbles, no dialogue bubbles, no narration boxes, no captions, no lettering, no sound effects text, no wrong costume, no wardrobe drift, no swapped accessories, no identity blending, no cloned NPC faces, no panel frames, no white borders, no watercolor, no oil painting, no painterly brush texture, no bloom, no glow, no soft lighting, no photorealism, no 3D render.`;

  if (safetyLevel >= 3) {
    prompt += `\n\nFLOW SAFETY LEVEL 3 — MAXIMUM SAFE MODE: This is a completely harmless, family-friendly fictional comic panel. Show ONLY peaceful character poses, calm expressions, gentle atmospheric lighting. Remove ALL references to danger, conflict, tension, darkness, horror, the supernatural, weapons, or distress. This is a safe illustration of characters simply existing in a scene. Still NO TEXT of any kind.`;
  } else if (safetyLevel) {
    prompt += `\n\nFLOW SAFETY RETRY LEVEL ${safetyLevel}: This is a fictional, non-graphic comic scene. Do not depict injury, violence, blood, gore, distress, or a harmful act on-screen. Preserve the story beat through safe expressions, posture, atmosphere, and symbolic visual storytelling. Still NO TEXT of any kind.`;
  }
  return prompt;
}

function parsePlan(text) {
  if (!text) throw new Error("Empty response received from AI.");
  let t = text.trim();
  // Strip markdown code fences
  t = t.replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/, "").trim();
  const a = t.indexOf("{");
  const b = t.lastIndexOf("}");
  if (a === -1 || b === -1) throw new Error("No JSON object found in response. Raw start: " + t.slice(0, 150));
  let jsonStr = t.slice(a, b + 1);
  
  // Try parsing as-is first
  try { 
    return JSON.parse(jsonStr); 
  } catch (firstErr) {
    // Sanitize common AI JSON mistakes and retry
    let s = jsonStr;
    // Fix smart/curly quotes → straight quotes
    s = s.replace(/[\u201C\u201D\u201E\u201F\u2033\u2036]/g, '"');
    s = s.replace(/[\u2018\u2019\u201A\u201B\u2032\u2035]/g, "'");
    // Fix double-double quotes: "dialogue":""text here""  →  "dialogue":"text here"
    s = s.replace(/:(\s*)""([^]*?)""(\s*[,}\]])/g, ':$1"$2"$3');
    // Fix unescaped inner double quotes inside string values (heuristic)
    // Match ": "...content with "word" inside..." and escape the inner quotes
    s = s.replace(/"([^"]{0,20})":\s*"((?:[^"\\]|\\.)*)"/g, (match, key, val) => {
      // This is a normal key-value pair, skip
      return match;
    });
    // Fix trailing commas before } or ]
    s = s.replace(/,(\s*[}\]])/g, '$1');
    
    try {
      return JSON.parse(s);
    } catch (secondErr) {
      throw new Error(`JSON parse failed: ${firstErr.message}. Last 100 chars: ...${jsonStr.slice(-100)}`);
    }
  }
}

// ---------- Google Flow API ----------
function getProjectIdFromFlowUrl(url) {
  const value = String(url || "");
  const pathMatch = value.match(/\/(?:tools\/flow\/)?projects?\/([^/?#]+)/i);
  if (pathMatch) return decodeURIComponent(pathMatch[1]);
  try {
    const parsed = new URL(value);
    return parsed.searchParams.get("projectId") || parsed.searchParams.get("project") || null;
  } catch {
    return null;
  }
}

function isGoogleFlowUrl(url) {
  try {
    const parsed = new URL(String(url || ""));
    if (parsed.hostname === "flow.google") return true;
    return parsed.hostname === "labs.google" && /\/fx\/tools\/flow(?:\/|$)/i.test(parsed.pathname);
  } catch {
    return false;
  }
}

async function discoverFlowProjectId(tabId, currentUrl) {
  const fromUrl = getProjectIdFromFlowUrl(currentUrl);
  if (fromUrl) return { projectId: fromUrl, source: "address" };

  const result = await chrome.scripting.executeScript({
    target: { tabId },
    world: "MAIN",
    func: () => {
      const ignored = new Set(["new", "create", "tools", "flow", "project", "projects"]);
      const findId = (raw) => {
        if (!raw) return null;
        let value = String(raw);
        try { value = decodeURIComponent(value); } catch {}
        const patterns = [
          /\/(?:tools\/flow\/)?projects?\/([a-z0-9_-]{6,})/i,
          /[?&#](?:projectId|project_id|project)=([a-z0-9_-]{6,})/i,
          /["'](?:projectId|project_id)["']\s*[:=]\s*["']([a-z0-9_-]{6,})["']/i,
        ];
        for (const pattern of patterns) {
          const match = value.match(pattern);
          const candidate = match?.[1];
          if (candidate && !ignored.has(candidate.toLowerCase())) return candidate;
        }
        return null;
      };

      const direct = document.querySelector("[data-project-id], [data-projectid]");
      if (direct) {
        const value = direct.getAttribute("data-project-id") || direct.getAttribute("data-projectid");
        const id = findId(`projectId=${value}`);
        if (id) return { projectId: id, source: "project element" };
      }

      const links = Array.from(document.querySelectorAll("a[href]"), (element) => element.href).slice(-500);
      for (const link of links) {
        const id = findId(link);
        if (id) return { projectId: id, source: "project link" };
      }

      const resources = performance.getEntriesByType("resource").slice(-1000);
      for (let index = resources.length - 1; index >= 0; index -= 1) {
        const id = findId(resources[index]?.name);
        if (id) return { projectId: id, source: "loaded Flow project request" };
      }
      return null;
    }
  });
  return result?.[0]?.result || null;
}

async function findFlowTab() {
  const tabs = await chrome.tabs.query({
    url: ["https://flow.google/*", "https://labs.google/fx/*"]
  });
  return tabs
    .filter((tab) => isGoogleFlowUrl(tab.url))
    .sort((a, b) => {
      const aHasProject = getProjectIdFromFlowUrl(a.url) ? 1 : 0;
      const bHasProject = getProjectIdFromFlowUrl(b.url) ? 1 : 0;
      return bHasProject - aHasProject || (b.lastAccessed || 0) - (a.lastAccessed || 0);
    })[0] || null;
}

async function openOrFocusFlow() {
  const existing = await findFlowTab();
  if (existing) {
    await chrome.tabs.update(existing.id, { active: true });
    if (existing.windowId) await chrome.windows.update(existing.windowId, { focused: true }).catch(() => {});
    return existing.id;
  }
  const tab = await chrome.tabs.create({ url: FLOW_HOME_URL, active: true });
  return tab.id;
}

async function getFlowAccessToken(tabId) {
  const result = await chrome.scripting.executeScript({
    target: { tabId },
    world: "MAIN",
    func: async () => {
      try {
        const candidates = location.hostname === "flow.google"
          ? ["/api/auth/session", "/fx/api/auth/session", "https://labs.google/fx/api/auth/session"]
          : ["/fx/api/auth/session", "/api/auth/session"];
        const errors = [];
        for (const url of candidates) {
          try {
            const response = await fetch(url, { credentials: "include" });
            if (!response.ok) {
              errors.push(`${url}: HTTP ${response.status}`);
              continue;
            }
            const session = await response.json();
            const token = session?.access_token
              || session?.accessToken
              || session?.token
              || session?.user?.access_token
              || session?.user?.accessToken;
            if (token) return { token, sessionEndpoint: url };
            errors.push(`${url}: no access token`);
          } catch (error) {
            errors.push(`${url}: ${error.message}`);
          }
        }
        return { error: `Flow session unavailable (${errors.join("; ")})` };
      } catch (error) {
        return { error: error.message };
      }
    }
  });
  const value = result?.[0]?.result;
  if (!value?.token) throw new Error(value?.error || "Could not read the Google Flow session. Refresh Flow and sign in again.");
  return value.token;
}

async function hasFlowRecaptcha(tabId) {
  const result = await chrome.scripting.executeScript({
    target: { tabId },
    world: "MAIN",
    func: async () => {
      const deadline = Date.now() + 20000;
      while (Date.now() < deadline) {
        if (window.grecaptcha?.enterprise?.execute) return true;
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
      return false;
    }
  });
  return Boolean(result?.[0]?.result);
}

async function getFlowContext() {
  const tab = await findFlowTab();
  if (!tab) throw new Error("Open Google Flow in a signed-in tab and select a project.");
  if (tab.status !== "complete") await waitForTabComplete(tab.id);

  const latestTab = await chrome.tabs.get(tab.id);
  const discovered = await discoverFlowProjectId(tab.id, latestTab.url);
  const projectId = discovered?.projectId;
  if (!projectId) throw new Error("Google Flow is open and signed in. Open or create a project first, then press Check Flow again.");
  log(`Detected active Flow project from ${discovered.source}.`);
  const accessToken = await getFlowAccessToken(tab.id);
  if (!await hasFlowRecaptcha(tab.id)) {
    throw new Error("Flow security is not ready. Refresh the Flow project tab and try again.");
  }
  return { tabId: tab.id, projectId, accessToken };
}

function decodeDataUrl(dataUrl) {
  const match = String(dataUrl || "").match(/^data:([^;,]+);base64,(.+)$/s);
  if (!match) throw new Error("Reference image is not a valid Base64 data URL.");
  return { mimeType: match[1], imageBytes: match[2] };
}

async function uploadDataUrlToFlow(flow, dataUrl, fileName) {
  const { mimeType, imageBytes } = decodeDataUrl(dataUrl);
  const upload = async () => {
    const result = await chrome.scripting.executeScript({
      target: { tabId: flow.tabId },
      world: "MAIN",
      func: async (token, projectId, name, mime, bytes) => {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 45000);
        try {
          const response = await fetch("https://aisandbox-pa.googleapis.com/v1/flow/uploadImage", {
            method: "POST",
            signal: controller.signal,
            headers: {
              "Content-Type": "text/plain;charset=UTF-8",
              Authorization: `Bearer ${token}`
            },
            body: JSON.stringify({
              clientContext: { projectId, tool: "PINHOLE" },
              fileName: name,
              imageBytes: bytes,
              isHidden: false,
              isUserUploaded: true,
              mimeType: mime
            })
          });
          if (!response.ok) return { error: `HTTP ${response.status}: ${(await response.text()).slice(0, 400)}`, status: response.status };
          return { data: await response.json() };
        } catch (error) {
          return { error: error?.name === "AbortError" ? "Flow reference upload timed out after 45 seconds" : error.message };
        } finally {
          clearTimeout(timeoutId);
        }
      },
      args: [flow.accessToken, flow.projectId, fileName, mimeType, imageBytes]
    });
    return result?.[0]?.result;
  };

  let response = await upload();
  if (response?.status === 401) {
    flow.accessToken = await getFlowAccessToken(flow.tabId);
    response = await upload();
  }
  if (!response?.data) throw new Error(`Flow reference upload failed: ${response?.error || "no response"}`);
  const mediaId = response.data?.media?.name;
  if (!mediaId) throw new Error("Flow reference upload returned no media ID.");
  return mediaId;
}

async function uploadReferenceUntilSuccess(flow, dataUrl, fileName, label) {
  let attempt = 0;
  while (!STATE.stopRequested) {
    attempt += 1;
    try {
      setStatus(`Uploading ${label} to Google Flow (attempt ${attempt})...`);
      log(`Uploading ${label} to Flow${attempt > 1 ? ` (attempt ${attempt})` : ""}...`);
      const mediaId = await uploadDataUrlToFlow(flow, dataUrl, fileName);
      log(`${label} uploaded to Flow.`);
      return mediaId;
    } catch (error) {
      log(`${label} upload failed: ${error.message}`);
      try {
        const refreshedFlow = await getFlowContext();
        Object.assign(flow, refreshedFlow);
        log("Flow connection refreshed for the reference retry.");
      } catch (refreshError) {
        log(`Flow reconnection is not ready yet: ${refreshError.message}`);
      }
      if (!STATE.stopRequested) {
        const delayMs = Math.min(30000, 3000 + (attempt - 1) * 3000);
        setStatus(`${label} upload will retry in ${Math.round(delayMs / 1000)}s...`);
        await sleep(delayMs);
      }
    }
  }
  return null;
}

function makeFlowId() {
  if (self.crypto?.randomUUID) return self.crypto.randomUUID();
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (char) => {
    const value = Math.random() * 16 | 0;
    return (char === "x" ? value : (value & 3) | 8).toString(16);
  });
}

async function generateFlowImage(flow, prompt, imageInputs, imageModel = FLOW_IMAGE_MODEL) {
  const batchId = makeFlowId();
  const sessionId = `;${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const seed = Math.floor(Math.random() * 300000);
  const clientContext = {
    recaptchaContext: {
      applicationType: "RECAPTCHA_APPLICATION_TYPE_WEB",
      token: "PLACEHOLDER"
    },
    projectId: flow.projectId,
    tool: "PINHOLE",
    sessionId
  };
  const payload = {
    clientContext: structuredClone(clientContext),
    mediaGenerationContext: { batchId },
    useNewMedia: true,
    requests: [{
      clientContext: structuredClone(clientContext),
      imageAspectRatio: CHAPTER_STATE.aspectRatio || FLOW_IMAGE_ASPECT_RATIO,
      imageInputs,
      imageModelName: imageModel || FLOW_IMAGE_MODEL,
      seed,
      structuredPrompt: { parts: [{ text: prompt }] }
    }]
  };
  const endpoint = `https://aisandbox-pa.googleapis.com/v1/projects/${flow.projectId}/flowMedia:batchGenerateImages`;

  const request = async () => {
    const result = await chrome.scripting.executeScript({
      target: { tabId: flow.tabId },
      world: "MAIN",
      func: async (url, body, token, siteKey) => {
        try {
          const enterprise = window.grecaptcha?.enterprise;
          if (!enterprise?.execute) return { error: "reCAPTCHA Enterprise is unavailable on the Flow page" };
          const recaptchaToken = await enterprise.execute(siteKey, { action: "IMAGE_GENERATION" });
          if (!recaptchaToken) return { error: "Flow returned no reCAPTCHA token" };
          body.clientContext.recaptchaContext.token = recaptchaToken;
          for (const item of body.requests || []) {
            if (item.clientContext?.recaptchaContext) item.clientContext.recaptchaContext.token = recaptchaToken;
          }
          const response = await fetch(url, {
            method: "POST",
            headers: {
              "Content-Type": "text/plain;charset=UTF-8",
              Authorization: `Bearer ${token}`
            },
            body: JSON.stringify(body)
          });
          if (!response.ok) return { error: `HTTP ${response.status}: ${(await response.text()).slice(0, 700)}`, status: response.status };
          return { data: await response.json() };
        } catch (error) {
          return { error: error.message };
        }
      },
      args: [endpoint, payload, flow.accessToken, FLOW_RECAPTCHA_SITE_KEY]
    });
    return result?.[0]?.result;
  };

  let response = await request();
  if (response?.status === 401) {
    flow.accessToken = await getFlowAccessToken(flow.tabId);
    response = await request();
  }
  if (!response?.data) throw new Error(`Flow generation failed: ${response?.error || "no response"}`);

  const media = Array.isArray(response.data.media) ? response.data.media : [];
  const fifeUrl = media
    .map((item) => item?.image?.generatedImage?.fifeUrl || item?.fifeUrl)
    .find(Boolean) || null;
  const mediaId = media.map((item) => item?.name).find(Boolean)
    || response.data?.workflows?.[0]?.metadata?.primaryMediaId
    || null;
  return { fifeUrl, mediaId, raw: response.data };
}

async function requestFlowUpscale(flow, mediaId, quality) {
  const is4k = quality === "4K";
  const targetResolution = is4k
    ? "UPSAMPLE_IMAGE_RESOLUTION_4K"
    : "UPSAMPLE_IMAGE_RESOLUTION_2K";
  const paygateTier = is4k ? "PAYGATE_TIER_TWO" : "PAYGATE_TIER_NOT_PAID";
  const sessionId = `;${Date.now()}-${quality}-${Math.random().toString(16).slice(2)}`;

  const request = async () => {
    const result = await chrome.scripting.executeScript({
      target: { tabId: flow.tabId },
      world: "MAIN",
      func: async (token, projectId, id, resolution, tier, session, siteKey) => {
        try {
          const enterprise = window.grecaptcha?.enterprise;
          if (!enterprise?.execute) return { error: "reCAPTCHA Enterprise is unavailable on the Flow page" };
          const recaptchaToken = await enterprise.execute(siteKey, { action: "IMAGE_GENERATION" });
          if (!recaptchaToken) return { error: "Flow returned no upscaling reCAPTCHA token" };
          const response = await fetch("https://aisandbox-pa.googleapis.com/v1/flow/upsampleImage", {
            method: "POST",
            headers: {
              "Content-Type": "text/plain;charset=UTF-8",
              Authorization: `Bearer ${token}`
            },
            body: JSON.stringify({
              mediaId: id,
              targetResolution: resolution,
              clientContext: {
                projectId,
                tool: "PINHOLE",
                recaptchaContext: {
                  applicationType: "RECAPTCHA_APPLICATION_TYPE_WEB",
                  token: recaptchaToken
                },
                sessionId: session,
                userPaygateTier: tier
              }
            })
          });
          if (!response.ok) return { error: `HTTP ${response.status}: ${(await response.text()).slice(0, 700)}`, status: response.status };
          const data = await response.json();
          return data.encodedImage ? { encodedImage: data.encodedImage } : { error: "Upscale response contained no encoded image" };
        } catch (error) {
          return { error: error.message };
        }
      },
      args: [flow.accessToken, flow.projectId, mediaId, targetResolution, paygateTier, sessionId, FLOW_RECAPTCHA_SITE_KEY]
    });
    return result?.[0]?.result;
  };

  let response = await request();
  if (response?.status === 401) {
    flow.accessToken = await getFlowAccessToken(flow.tabId);
    response = await request();
  }
  if (!response?.encodedImage) throw new Error(response?.error || `${quality} upscale returned no image`);
  const encoded = response.encodedImage;
  const mimeType = encoded.startsWith("iVBOR")
    ? "image/png"
    : encoded.startsWith("UklGR")
      ? "image/webp"
      : "image/jpeg";
  const dataUrl = encoded.startsWith("data:") ? encoded : `data:${mimeType};base64,${encoded}`;
  const imageResponse = await fetch(dataUrl);
  const blob = await imageResponse.blob();
  if (blob.size <= 1000) throw new Error(`${quality} upscale returned an invalid image`);
  const bitmap = await createImageBitmap(blob);
  const width = bitmap.width;
  const height = bitmap.height;
  const longestEdge = Math.max(width, height);
  bitmap.close?.();
  const minimumEdge = is4k ? 3500 : 1800;
  if (longestEdge < minimumEdge) {
    throw new Error(`${quality} upscale returned only ${longestEdge}px on its longest edge`);
  }
  return { blob, width, height };
}

let _4kAccessDenied = false;

async function fetchMaximumQualityFlowImage(flow, mediaId) {
  if (!_4kAccessDenied) {
    try {
      log("Requesting 4K Flow upscale...");
      return { ...(await requestFlowUpscale(flow, mediaId, "4K")), quality: "4K" };
    } catch (error4k) {
      log(`4K unavailable (${error4k.message}). Falling back to 2K...`);
      if (/MODEL_ACCESS_DENIED|PERMISSION_DENIED/i.test(error4k.message)) {
        _4kAccessDenied = true;
        log("4K upscale access is denied for this account. Skipping 4K for all remaining panels.");
      }
    }
  }

  try {
    return { ...(await requestFlowUpscale(flow, mediaId, "2K")), quality: "2K" };
  } catch (error2k) {
    throw new Error(`Flow could not deliver the required minimum 2K image: ${error2k.message}`);
  }
}

async function createPreviewThumbnail(blob) {
  const bitmap = await createImageBitmap(blob);
  const width = 180;
  const height = Math.max(1, Math.round(bitmap.height * width / bitmap.width));
  const canvas = new OffscreenCanvas(width, height);
  const context = canvas.getContext("2d");
  context.drawImage(bitmap, 0, 0, width, height);
  bitmap.close?.();
  const thumbnail = await canvas.convertToBlob({ type: "image/jpeg", quality: 0.68 });
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error || new Error("Thumbnail conversion failed"));
    reader.readAsDataURL(thumbnail);
  });
}

// ---------- Gemini planning tab ----------
async function openFreshGeminiTab(gemUrl) {
  const url = gemUrl && gemUrl.startsWith("https://gemini.google.com/")
    ? gemUrl
    : "https://gemini.google.com/";
  const contentScript = "content_gemini.js";
  
  const tab = await chrome.tabs.create({ url, active: true });
  await waitForTabComplete(tab.id);
  // inject + ping
  let alive = false;
  for (let i = 0; i < 8 && !alive; i++) {
    try {
      const r = await chrome.tabs.sendMessage(tab.id, { type: "PING" });
      alive = !!r;
    } catch {}
    if (!alive) {
      try {
        await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: [contentScript] });
      } catch (e) { log("inject err: " + e.message); }
      await sleep(1500);
    }
  }
  if (!alive) throw new Error("The Gemini planning tab did not become ready.");
  return tab.id;
}

function waitForTabComplete(tabId) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(l);
      resolve(); // resolve anyway after 30s
    }, 30000);
    function l(id, info) {
      if (id === tabId && info.status === "complete") {
        chrome.tabs.onUpdated.removeListener(l);
        clearTimeout(timer);
        setTimeout(resolve, 3000); // extra settle time
      }
    }
    chrome.tabs.onUpdated.addListener(l);
  });
}

function sendToContent(tabId, payload, timeoutMs = 600000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error("sendToContent timed out after " + Math.round(timeoutMs/1000) + "s"));
    }, timeoutMs);
    
    chrome.tabs.sendMessage(tabId, payload, (resp) => {
      clearTimeout(timer);
      if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
      if (!resp) return reject(new Error("No response from content script."));
      if (resp.error) return reject(new Error(resp.error));
      resolve(resp.result);
    });
  });
}

function safeCloseTab(tabId) {
  if (tabId) { try { chrome.tabs.remove(tabId); } catch {} }
}

async function stitchVertical(panelBlobs) {
  let sourceMaxW = 0;

  // First pass: read dimensions without retaining every high-resolution bitmap.
  const dimensions = [];
  for (const p of panelBlobs) {
    const bm = await createImageBitmap(p.blob);
    if (bm.width > sourceMaxW) sourceMaxW = bm.width;
    dimensions.push({ panel: p, width: bm.width, height: bm.height });
    bm.close?.();
  }
  // Preserve the maximum generated width in the lossless stitched parts. Split
  // more often when needed so each canvas remains below a safe pixel budget.
  const targetW = sourceMaxW;
  const maxPartHeight = Math.min(8000, Math.max(1, Math.floor(24000000 / targetW)));
  const scaled = dimensions.map((item) => ({
    ...item,
    imgH: Math.round(item.height * targetW / item.width),
  }));
  const groups = [];
  let group = [];
  let groupHeight = 0;
  for (const item of scaled) {
    if (group.length && groupHeight + item.imgH > maxPartHeight) {
      groups.push({ items: group, height: groupHeight });
      group = [];
      groupHeight = 0;
    }
    group.push(item);
    groupHeight += item.imgH;
  }
  if (group.length) groups.push({ items: group, height: groupHeight });

  const renderGroup = async (items) => {
    const height = Math.max(1, items.reduce((sum, item) => sum + Math.max(1, item.imgH), 0));
    try {
      const canvas = new OffscreenCanvas(Math.max(1, targetW), height);
      const context = canvas.getContext("2d");
      if (!context) throw new Error("2D canvas context is unavailable");
      context.fillStyle = "#000000";
      context.fillRect(0, 0, targetW, height);
      let y = 0;
      for (const item of items) {
        const bitmap = await createImageBitmap(item.panel.blob);
        context.drawImage(bitmap, 0, y, targetW, Math.max(1, item.imgH));
        bitmap.close?.();
        y += Math.max(1, item.imgH);
      }
      
      // ADD WATERMARK
      context.fillStyle = "rgba(255, 255, 255, 0.45)";
      context.font = `bold ${Math.max(16, Math.floor(targetW / 40))}px sans-serif`;
      context.textAlign = "right";
      context.textBaseline = "bottom";
      context.shadowColor = "rgba(0, 0, 0, 0.8)";
      context.shadowBlur = 4;
      context.fillText("Generated by ZingerBurger - github.com/FauxGUY", targetW - 20, height - 20);

      const blob = await canvas.convertToBlob({ type: "image/png" });
      if (!blob?.size) throw new Error("Canvas returned an empty image");
      return [{
        blob,
        width: targetW,
        height,
        startIndex: items[0].panel.index,
        endIndex: items[items.length - 1].panel.index,
      }];
    } catch (error) {
      if (items.length > 1) {
        log(`Large stitch group failed (${error.message}); splitting it into smaller ordered parts.`);
        const middle = Math.ceil(items.length / 2);
        return [
          ...(await renderGroup(items.slice(0, middle))),
          ...(await renderGroup(items.slice(middle))),
        ];
      }
      const item = items[0];
      log(`Canvas export failed for panel ${item.panel.index}; preserving its original full-resolution file as its own ordered part.`);
      return [{
        blob: item.panel.blob,
        width: item.width,
        height: item.height,
        startIndex: item.panel.index,
        endIndex: item.panel.index,
      }];
    }
  };

  const parts = [];
  for (const entry of groups) parts.push(...await renderGroup(entry.items));
  const totalHeight = parts.reduce((sum, part) => sum + part.height, 0);
  return { parts, width: targetW, totalHeight };
}

async function makePdfSafePart(part) {
  const targetWidth = Math.min(part.width, 1152);
  const targetHeight = Math.max(1, Math.round(part.height * targetWidth / part.width));
  const bitmap = await createImageBitmap(part.blob);
  try {
    const canvas = new OffscreenCanvas(targetWidth, targetHeight);
    const context = canvas.getContext("2d");
    if (!context) throw new Error("PDF canvas context is unavailable");
    context.fillStyle = "#000000";
    context.fillRect(0, 0, targetWidth, targetHeight);
    context.drawImage(bitmap, 0, 0, targetWidth, targetHeight);

    // ADD WATERMARK
    context.fillStyle = "rgba(255, 255, 255, 0.45)";
    context.font = `bold ${Math.max(16, Math.floor(targetWidth / 40))}px sans-serif`;
    context.textAlign = "right";
    context.textBaseline = "bottom";
    context.shadowColor = "rgba(0, 0, 0, 0.8)";
    context.shadowBlur = 4;
    context.fillText("Generated by ZingerBurger - github.com/FauxGUY", targetWidth - 15, targetHeight - 15);

    const blob = await canvas.convertToBlob({ type: "image/jpeg", quality: 0.92 });
    if (!blob?.size) throw new Error("PDF page conversion returned an empty image");
    return { blob, width: targetWidth, height: targetHeight };
  } finally {
    bitmap.close?.();
  }
}

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error || new Error("Blob conversion failed"));
    reader.readAsDataURL(blob);
  });
}

const EXPORT_DB_NAME = "zingerburger-exports";
const EXPORT_STORE_NAME = "files";
let offscreenCreationPromise = null;

function openExportDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(EXPORT_DB_NAME, 1);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(EXPORT_STORE_NAME)) {
        database.createObjectStore(EXPORT_STORE_NAME);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("Could not open export storage"));
  });
}

async function storeExportBlob(key, blob) {
  const database = await openExportDatabase();
  await new Promise((resolve, reject) => {
    const transaction = database.transaction(EXPORT_STORE_NAME, "readwrite");
    transaction.objectStore(EXPORT_STORE_NAME).put(blob, key);
    transaction.oncomplete = resolve;
    transaction.onerror = () => reject(transaction.error || new Error("Could not store export file"));
    transaction.onabort = () => reject(transaction.error || new Error("Export storage was aborted"));
  });
  database.close();
}

async function ensureOffscreenDownloader() {
  const hasDocument = chrome.offscreen.hasDocument
    ? await chrome.offscreen.hasDocument()
    : (await chrome.runtime.getContexts({ contextTypes: ["OFFSCREEN_DOCUMENT"] })).length > 0;
  if (hasDocument) return;
  if (!offscreenCreationPromise) {
    offscreenCreationPromise = chrome.offscreen.createDocument({
      url: "offscreen.html",
      reasons: ["BLOBS"],
      justification: "Create temporary Blob URLs for large generated ZIP and PDF downloads.",
    }).finally(() => { offscreenCreationPromise = null; });
  }
  await offscreenCreationPromise;
}

async function downloadLargeBlob(blob, filename) {
  if (!(blob instanceof Blob) || !blob.size) throw new Error(`Export ${filename} is empty.`);
  const key = `${Date.now()}-${makeFlowId()}`;
  await storeExportBlob(key, blob);
  await ensureOffscreenDownloader();
  const response = await chrome.runtime.sendMessage({ type: "LOTM_DOWNLOAD_BLOB", key, filename });
  if (!response?.ok) throw new Error(`Could not save ${filename}: ${response?.error || "download did not start"}`);
  return response.downloadId;
}

async function getExtensionFileAsBase64(path) {
  if (!path) return null;
  try {
    const url = chrome.runtime.getURL(path);
    const r = await fetch(url);
    if (!r.ok) return null;
    const blob = await r.blob();
    const buffer = await blob.arrayBuffer();
    const bytes = new Uint8Array(buffer);
    const CHUNK_SIZE = 0x8000;
    const c = [];
    for (let i = 0; i < bytes.length; i += CHUNK_SIZE) {
      c.push(String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK_SIZE)));
    }
    return `data:${blob.type || 'image/jpeg'};base64,${btoa(c.join(""))}`;
  } catch(e) {
    return null;
  }
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
