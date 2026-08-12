(() => {
  if (window.__LOTM_INJECTED__) return;
  window.__LOTM_INJECTED__ = true;

  // ---------- visible status overlay so user can SEE the bot acting ----------
  const overlay = document.createElement("div");
  overlay.id = "__lotm_overlay__";
  overlay.style.cssText = `
    position:fixed;z-index:2147483647;right:12px;bottom:12px;
    background:#1a0b14;color:#ffd6c2;font:12px/1.4 system-ui,sans-serif;
    border:1px solid #c0392b;border-radius:8px;padding:8px 10px;max-width:320px;
    box-shadow:0 6px 20px rgba(0,0,0,.5);pointer-events:none;`;
  overlay.textContent = "LOTM Manhwa: ready";
  document.documentElement.appendChild(overlay);
  const setOverlay = (s) => { overlay.textContent = "LOTM Manhwa: " + s; };

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // ---------- selectors (current chatgpt.com, Nov 2024+) ----------
  const COMPOSER_SELECTORS = [
    "#prompt-textarea",
    'div[contenteditable="true"][id="prompt-textarea"]',
    'div.ProseMirror[contenteditable="true"]',
    'textarea#prompt-textarea',
    'textarea[data-id]',
    'main form textarea',
    'main form div[contenteditable="true"]',
  ];
  const SEND_SELECTORS = [
    'button[data-testid="send-button"]',
    'button[data-testid="composer-send-button"]',
    'button[data-testid="fruitjuice-send-button"]',
    'button[aria-label*="Send" i]:not([disabled])',
    'main form button[type="submit"]:not([disabled])',
  ];
  const STOP_SELECTORS = [
    'button[data-testid="stop-button"]',
    'button[data-testid="composer-stop-button"]',
    'button[aria-label*="Stop" i]',
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
    throw new Error("Timeout waiting for ChatGPT UI element.");
  };

  // ---------- robust composer fill (ProseMirror friendly) ----------
  async function setComposerText(text) {
    const el = await waitFor(() => findFirst(COMPOSER_SELECTORS), { timeout: 30000 });
    el.focus();
    el.scrollIntoView({ block: "center" });

    if (el.tagName === "TEXTAREA") {
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLTextAreaElement.prototype, "value"
      ).set;
      setter.call(el, text);
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
    } else {
      // ProseMirror contenteditable — best approach: clear, then paste event
      // Clear
      el.innerHTML = "<p><br></p>";
      el.dispatchEvent(new InputEvent("input", { bubbles: true }));
      await sleep(80);
      el.focus();

      // Try paste event with DataTransfer
      const dt = new DataTransfer();
      dt.setData("text/plain", text);
      const pasted = el.dispatchEvent(
        new ClipboardEvent("paste", {
          clipboardData: dt, bubbles: true, cancelable: true,
        })
      );
      await sleep(150);

      // Verify; if not present, fall back to manual node injection
      if (!(el.innerText || "").includes(text.slice(0, 30))) {
        el.innerHTML = "";
        // Build paragraphs (ProseMirror expects <p> children)
        const lines = text.split(/\r?\n/);
        for (const line of lines) {
          const p = document.createElement("p");
          p.textContent = line.length ? line : "";
          if (!line.length) p.innerHTML = "<br>";
          el.appendChild(p);
        }
        el.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: text }));
      }
    }
    await sleep(500);
    return el;
  }

  async function clickSend() {
    // Send button may take a moment to enable after text input
    const btn = await waitFor(() => {
      const b = findFirst(SEND_SELECTORS);
      if (!b) return null;
      if (b.disabled || b.getAttribute("aria-disabled") === "true") return null;
      return b;
    }, { timeout: 20000 });
    btn.click();
    await sleep(300);
  }

  async function waitForResponseDone(timeoutMs) {
    const start = Date.now();
    let saw = false;
    let lastText = "";
    let unchangedCount = 0;
    while (Date.now() - start < timeoutMs) {
      const stop = findFirst(STOP_SELECTORS);
      if (stop) { 
        saw = true; 
        unchangedCount = 0;
      }
      else if (saw) { await sleep(2500); return; }
      else {
        const currentText = getLastAssistantText();
        if (currentText && currentText === lastText) {
          unchangedCount++;
          if (unchangedCount > 6) return; // ~4.2s no change
        } else {
          lastText = currentText;
          unchangedCount = 0;
        }
      }
      await sleep(700);
    }
    // never saw streaming — maybe done instantly, return ok
    if (!saw) return;
    throw new Error("Response did not finish in time.");
  }

  function getLastAssistantTurn() {
    const turns = document.querySelectorAll(
      '[data-message-author-role="assistant"]'
    );
    return turns[turns.length - 1] || null;
  }

  function getLastAssistantText() {
    const t = getLastAssistantTurn();
    if (!t) return "";
    // prefer markdown code text
    const codes = [...t.querySelectorAll("pre code")];
    if (codes.length) return codes.map((c) => c.innerText).join("\n").trim();
    return (t.innerText || "").trim();
  }

  function getAllContentImages() {
    // Search the entire document because ChatGPT's new UI might place the image outside the message block
    const imgs = [...document.querySelectorAll("img")];
    const urls = [];
    for (const img of imgs) {
      const u = img.currentSrc || img.src;
      if (!u) continue;
      if (u.startsWith("data:")) continue;
      // Skip tiny UI icons/avatars (less than 100px)
      if (img.naturalWidth > 0 && img.naturalWidth < 100) continue;
      if (img.naturalHeight > 0 && img.naturalHeight < 100) continue;
      if (/avatar|favicon|gizmo|profile|logo/i.test(u)) continue;
      if (/avatar|favicon|gizmo|profile|logo/i.test(img.className || "")) continue;
      
      if (u.startsWith("blob:")) { urls.push(u); continue; }
      
      if (u.startsWith("http")) {
        if (u.includes("oaiusercontent") || 
            u.includes("openai") || 
            u.includes("chatgpt.com") ||
            u.includes("files") || 
            /\.(png|jpe?g|webp)(\?|$)/i.test(u)) {
          urls.push(u);
        }
      }
    }
    return [...new Set(urls)];
  }

  function isChatGPTGenerating() {
    const stop = findFirst(STOP_SELECTORS);
    if (stop && stop.offsetParent !== null) return true;
    return document.querySelector('.result-streaming') !== null;
  }

  async function waitForImageInLastTurn(imageCountBefore, timeoutMs) {
    const start = Date.now();
    
    // Phase 1: Wait for ChatGPT to START generating
    setOverlay("waiting for generation to start...");
    let generationStarted = false;
    while (Date.now() - start < 30000) {
      if (isChatGPTGenerating()) { generationStarted = true; break; }
      if (getAllContentImages().length > imageCountBefore) { generationStarted = true; break; }
      await sleep(500);
    }
    
    // Phase 2: Wait for ChatGPT to FINISH generating  
    if (generationStarted) {
      setOverlay("generating image... please wait...");
      let stableCount = 0;
      while (Date.now() - start < timeoutMs) {
        if (isChatGPTGenerating()) {
          stableCount = 0;
          await sleep(1000);
          continue;
        }
        stableCount++;
        if (stableCount >= 5) break; // 5s stable wait
        await sleep(1000);
      }
    }
    
    // Phase 3: Look for new images
    setOverlay("looking for generated image...");
    const allNow = getAllContentImages();
    const newImages = allNow.slice(imageCountBefore);
    
    if (newImages.length > 0) {
      await sleep(3000); // let them render
      return getAllContentImages().slice(imageCountBefore);
    }
    
    // Phase 4: Final fallback
    await sleep(5000);
    const lastTry = getAllContentImages().slice(imageCountBefore);
    if (lastTry.length > 0) return lastTry;
    
    const text = getLastAssistantText();
    if (text && /violate our guardrails|content policy|We're so sorry/i.test(text)) {
      throw new Error("POLICY_VIOLATION");
    }
    
    return [];
  }

  async function askText(prompt, timeoutMs) {
    setOverlay("typing prompt…");
    const before = document.querySelectorAll('[data-message-author-role="assistant"]').length;
    await setComposerText(prompt);
    setOverlay("clicking send…");
    await clickSend();
    setOverlay("waiting for response…");
    await waitFor(
      () => document.querySelectorAll('[data-message-author-role="assistant"]').length > before,
      { timeout: 45000 }
    );
    await waitForResponseDone(timeoutMs);
    setOverlay("response received");
    return getLastAssistantText();
  }

  async function askImage(prompt, images, timeoutMs) {
    const imageCountBefore = getAllContentImages().length;
    
    setOverlay("typing image prompt…");
    const before = document.querySelectorAll('[data-message-author-role="assistant"]').length;
    const composer = await setComposerText(prompt);
    
    if (images && images.length > 0) {
      setOverlay("attaching images…");
      await attachFiles(images, composer);
    }
    setOverlay("clicking send…");
    await clickSend();
    
    setOverlay("waiting for image…");
    await waitFor(
      () => document.querySelectorAll('[data-message-author-role="assistant"]').length > before,
      { timeout: 45000 }
    );
    
    const urls = await waitForImageInLastTurn(imageCountBefore, Math.min(timeoutMs, 240000));
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
          const result = await askText(msg.prompt, msg.timeoutMs || 180000);
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

    // ChatGPT's new UI is strict about pasting. Best to use the hidden file input if available.
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
    await sleep(Math.min(base64Images.length * 1500, 5000) + 2000);
  }

  console.log("[AutoManhwa] content script ready on", location.href);
})();
