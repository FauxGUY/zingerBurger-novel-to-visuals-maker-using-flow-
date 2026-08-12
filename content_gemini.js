(() => {
  if (window.__LOTM_INJECTED__) return;
  window.__LOTM_INJECTED__ = true;

  const overlay = document.createElement("div");
  overlay.id = "__lotm_overlay__";
  overlay.style.cssText = `
    position:fixed;z-index:2147483647;right:12px;bottom:12px;
    background:#1a0b14;color:#ffd6c2;font:12px/1.4 system-ui,sans-serif;
    border:1px solid #c0392b;border-radius:8px;padding:8px 10px;max-width:320px;
    box-shadow:0 6px 20px rgba(0,0,0,.5);pointer-events:none;`;
  overlay.textContent = "LOTM Manhwa (Gemini): ready";
  document.documentElement.appendChild(overlay);
  const setOverlay = (s) => { overlay.textContent = "LOTM Manhwa: " + s; };

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  const COMPOSER_SELECTORS = [
    'rich-textarea .ql-editor',
    'div[contenteditable="true"][role="textbox"]',
    'textarea[aria-label*="prompt" i]'
  ];
  const SEND_SELECTORS = [
    'button[aria-label*="Send" i]',
    '.send-button'
  ];

  const findFirst = (sels) => {
    for (const s of sels) {
      const el = document.querySelector(s);
      if (el) return el;
    }
    return null;
  };

  const waitFor = async (fn, { timeout = 60000, interval = 400 } = {}) => {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      try {
        const v = await fn();
        if (v) return v;
      } catch {}
      await sleep(interval);
    }
    throw new Error("Timeout waiting for Gemini UI element.");
  };

  async function setComposerText(text) {
    const el = await waitFor(() => findFirst(COMPOSER_SELECTORS), { timeout: 30000 });
    el.focus();
    
    if (el.tagName === "TEXTAREA") {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value").set;
      setter.call(el, text);
      el.dispatchEvent(new Event("input", { bubbles: true }));
    } else {
      el.innerHTML = "";
      const p = document.createElement("p");
      p.innerText = text;
      el.appendChild(p);
      el.dispatchEvent(new Event("input", { bubbles: true }));
    }
    await sleep(500);
    return el;
  }

  async function clickSend() {
    const btn = await waitFor(() => {
      const b = findFirst(SEND_SELECTORS);
      if (!b || b.disabled || b.getAttribute("aria-disabled") === "true") return null;
      return b;
    }, { timeout: 20000 });
    btn.click();
    await sleep(300);
  }

  function getMessageBlocks() {
    // Gemini typical message block wrapper
    return document.querySelectorAll('message-content, model-response, .model-response-text');
  }

  function getLastAssistantText() {
    const blocks = getMessageBlocks();
    if (!blocks.length) return "";
    const last = blocks[blocks.length - 1];
    
    // Look for <pre> blocks first (the actual JSON wrapper)
    const pres = [...last.querySelectorAll("pre")];
    if (pres.length) return pres.map((c) => c.innerText).join("\n").trim();
    
    return last.innerText.trim();
  }

  function getAllContentImages() {
    // Collect all large, real content images from ONLY the last AI response block
    const blocks = getMessageBlocks();
    if (!blocks.length) return [];
    const lastBlock = blocks[blocks.length - 1];
    
    const imgs = [...lastBlock.querySelectorAll("img")];
    const urls = [];
    for (const img of imgs) {
      const u = img.currentSrc || img.src;
      if (!u) continue;
      if (u.startsWith("data:")) continue;
      // Skip tiny UI icons/avatars (less than 100px)
      if (img.naturalWidth > 0 && img.naturalWidth < 100) continue;
      if (img.naturalHeight > 0 && img.naturalHeight < 100) continue;
      // Skip known UI elements
      if (/avatar|favicon|logo|sparkle|icon|emoji|profile/i.test(u)) continue;
      if (/avatar|favicon|logo|sparkle|icon|emoji|profile/i.test(img.className || "")) continue;
      // Only accept googleusercontent (generated images) or blob URLs
      if (u.includes("googleusercontent.com") || u.startsWith("blob:")) {
        urls.push(u);
      }
    }
    // Force highest quality and force JPEG format instead of highly compressed WebP
    return [...new Set(urls)].map(u => {
      if (u.includes("googleusercontent.com") && u.includes("=")) {
        return u.split("=")[0] + "=s0-rj";
      }
      return u;
    });
  }

  function isGeminiGenerating() {
    // Check multiple indicators that Gemini is still working
    const indicators = [
      'message-loading',
      '.generating-indicator',
      '[aria-label="Generating"]',
      '.loading-spinner',
      'mat-progress-bar',
      '.progress-bar'
    ];
    for (const sel of indicators) {
      if (document.querySelector(sel)) return true;
    }
    // Also check if the stop button is visible (means generation is in progress)
    const stopBtn = document.querySelector('button[aria-label*="Stop" i]');
    if (stopBtn && stopBtn.offsetParent !== null) return true;
    return false;
  }

  function looksLikeCompleteJson(text) {
    const value = String(text || "").trim().replace(/```\s*$/i, "").trim();
    if (!value.endsWith("}")) return false;
    const start = value.indexOf("{");
    if (start < 0) return false;
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let index = start; index < value.length; index++) {
      const char = value[index];
      if (escaped) {
        escaped = false;
        continue;
      }
      if (char === "\\" && inString) {
        escaped = true;
        continue;
      }
      if (char === '"') {
        inString = !inString;
        continue;
      }
      if (inString) continue;
      if (char === "{") depth++;
      if (char === "}") depth--;
      if (depth < 0) return false;
    }
    return depth === 0 && !inString;
  }

  async function waitForResponseDone(timeoutMs) {
    const start = Date.now();
    let lastText = "";
    let unchangedCount = 0;
    while (Date.now() - start < timeoutMs) {
      const currentText = getLastAssistantText();
      const isGenerating = isGeminiGenerating();
      
      if (currentText && currentText === lastText) {
        unchangedCount++;
        // If Gemini is no longer generating, 2 seconds of unchanged text is enough to confirm it's done.
        // If it is still generating but the JSON looks perfectly complete, we'll wait a bit longer to be safe.
        if (!isGenerating && unchangedCount >= 2) return;
        if (isGenerating && looksLikeCompleteJson(currentText) && unchangedCount >= 8) return;
      } else {
        lastText = currentText;
        unchangedCount = 0;
      }
      await sleep(1000);
    }
    throw new Error(`Gemini storyboard did not finish within ${Math.round(timeoutMs / 60000)} minutes.`);
  }

  async function waitForImageInLastTurn(imageCountBefore, timeoutMs) {
    const start = Date.now();
    
    // Phase 1: Wait for Gemini to START generating (loading indicator appears)
    setOverlay("waiting for generation to start...");
    let generationStarted = false;
    while (Date.now() - start < 30000) {
      if (isGeminiGenerating()) { generationStarted = true; break; }
      // Also check if new images already appeared
      if (getAllContentImages().length > imageCountBefore) { generationStarted = true; break; }
      await sleep(500);
    }
    
    // Phase 2: Wait for Gemini to FINISH generating  
    if (generationStarted) {
      setOverlay("generating image... please wait...");
      let stableCount = 0;
      while (Date.now() - start < timeoutMs) {
        if (isGeminiGenerating()) {
          stableCount = 0;
          await sleep(1000);
          continue;
        }
        stableCount++;
        // Wait 5 seconds after generation stops to let image fully render
        if (stableCount >= 5) break;
        await sleep(1000);
      }
    }
    
    // Phase 3: Now look for new images
    setOverlay("looking for generated image...");
    const allNow = getAllContentImages();
    const newImages = allNow.slice(imageCountBefore);
    
    if (newImages.length > 0) {
      // Give images a moment to fully load
      await sleep(3000);
      const finalImages = getAllContentImages().slice(imageCountBefore);
      return finalImages;
    }
    
    // Phase 4: Final fallback — check for any new content images after a wait
    await sleep(5000);
    const lastTry = getAllContentImages().slice(imageCountBefore);
    if (lastTry.length > 0) return lastTry;
    
    // Check for policy violation text
    const text = getLastAssistantText();
    if (text && /cannot generate|policy|sorry|unable|violat/i.test(text)) {
      throw new Error("POLICY_VIOLATION");
    }
    
    return [];
  }

  async function askText(prompt, timeoutMs) {
    setOverlay("typing prompt…");
    const beforeCount = getMessageBlocks().length;
    await setComposerText(prompt);
    setOverlay("clicking send…");
    await clickSend();
    setOverlay("waiting for response…");
    
    await waitFor(() => getMessageBlocks().length > beforeCount, { timeout: 45000 });
    await waitForResponseDone(timeoutMs);
    
    setOverlay("response received");
    return getLastAssistantText();
  }

  async function askImage(prompt, images, timeoutMs) {
    setOverlay("typing image prompt…");
    const beforeCount = getMessageBlocks().length;
    // Snapshot how many content images exist BEFORE we send prompt
    const imageCountBefore = getAllContentImages().length;
    const composer = await setComposerText(prompt);
    
    if (images && images.length > 0) {
      setOverlay("attaching images…");
      await attachFiles(images, composer);
    }
    setOverlay("clicking send…");
    await clickSend();
    setOverlay("waiting for image generation…");
    
    await waitFor(() => getMessageBlocks().length > beforeCount, { timeout: 45000 });
    const urls = await waitForImageInLastTurn(imageCountBefore, Math.min(timeoutMs, 300000));
    
    setOverlay(urls.length ? `got image (${urls.length})` : "no image found");
    return urls;
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    (async () => {
      try {
        if (msg.type === "PING") return sendResponse({ result: "pong" });
        if (msg.type === "FETCH_BLOB") {
          const r = await fetch(msg.url);
          const blob = await r.blob();
          const reader = new FileReader();
          reader.onload = () => sendResponse({ result: reader.result });
          reader.readAsDataURL(blob);
          return;
        }
        if (msg.type === "ASK_TEXT") {
          const result = await askText(msg.prompt, msg.timeoutMs || 1200000);
          return sendResponse({ result });
        }
        if (msg.type === "ASK_IMAGE") {
          const result = await askImage(msg.prompt, msg.images, msg.timeoutMs || 300000);
          return sendResponse({ result });
        }
        sendResponse({ error: "Unknown message type" });
      } catch (e) {
        setOverlay("ERROR: " + (e?.message || e));
        sendResponse({ error: e?.message || String(e) });
      }
    })();
    return true;
  });

  function base64ToFile(b64, filename) {
    const arr = b64.split(',');
    const mime = arr[0].match(/:(.*?);/)[1];
    const bstr = atob(arr[1]);
    let n = bstr.length;
    const u8arr = new Uint8Array(n);
    while(n--){ u8arr[n] = bstr.charCodeAt(n); }
    return new File([u8arr], filename, {type: mime});
  }

  async function attachFiles(base64Images, composerElement) {
    if (!base64Images || !base64Images.length) return;
    const files = base64Images.map((b64, i) => base64ToFile(b64, `ref_${i}.jpg`));
    const dt = new DataTransfer();
    files.forEach(f => dt.items.add(f));

    const fileInput = document.querySelector('input[type="file"]');
    if (fileInput) {
      fileInput.files = dt.files;
      fileInput.dispatchEvent(new Event('change', { bubbles: true }));
    } else {
      composerElement.focus();
      composerElement.dispatchEvent(new ClipboardEvent("paste", {
        clipboardData: dt, bubbles: true, cancelable: true
      }));
    }
    
    // Wait for uploads to complete in UI
    await sleep(Math.min(base64Images.length * 1000, 4000) + 2000);
  }

  console.log("[AutoManhwa] Gemini content script ready on", location.href);
})();
