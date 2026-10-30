(() => {
  if (window.__tectoProtectionInstalled) return;
  window.__tectoProtectionInstalled = true;

  // Events that Tecto re-dispatches itself (so we don't process them twice)
  const tectoEvents = new WeakSet();

  // true while Tecto itself is rewriting text (stops the input-event loop)
  let tectoWriting = false;

  // GREEN TECTO NOTIFICATION
  function showTectoNotification(message) {
    let toast = document.getElementById("tecto-toast");

    if (!toast) {
      toast = document.createElement("div");
      toast.id = "tecto-toast";

      Object.assign(toast.style, {
        position: "fixed",
        bottom: "24px",
        left: "50%",
        transform: "translateX(-50%)",
        background: "#16a34a",
        color: "#ffffff",
        padding: "14px 22px",
        borderRadius: "12px",
        fontSize: "14px",
        fontWeight: "600",
        fontFamily: "Arial, sans-serif",
        boxShadow: "0 4px 18px rgba(0,0,0,0.25)",
        zIndex: "2147483647",
        maxWidth: "90%",
        textAlign: "center"
      });

      document.body.appendChild(toast);
    }

    toast.textContent = message;
    toast.style.display = "block";

    clearTimeout(window.__tectoToastTimer);

    window.__tectoToastTimer = setTimeout(() => {
      toast.remove();
    }, 3000);
  }

  // TEXT REDACTION
  function redactSensitiveText(input) {
    let text = input;

    // Passwords
    text = text.replace(
      /\b(password|passwd|passcode|pwd)\b\s*(?:(?:is|equals)\s+|[:=]\s*|\s+)(?:"([^"]*)"|'([^']*)'|([^\s,;]+))/gi,
      (match, label, doubleQuoted, singleQuoted, unquoted) => {
        const value = doubleQuoted ?? singleQuoted ?? unquoted ?? "";

        if (/^\[PASSWORD REDACTED\]$/i.test(value)) {
          return match;
        }

        return label + ": [PASSWORD REDACTED]";
      }
    );

    // PAN
    text = text.replace(
      /\b[A-Z]{5}[0-9]{4}[A-Z]\b/gi,
      "[PAN REDACTED]"
    );

    // 12-digit numbers
    text = text.replace(
      /\b\d{4}[\s-]?\d{4}[\s-]?\d{4}\b/g,
      "[12-DIGIT NUMBER REDACTED]"
    );

    // OTP and verification codes
    text = text.replace(
      /\b(OTP|one[- ]time password|verification code|security code)\s*(?:is\s*)?[:=#-]?\s*\d(?:[\s-]*\d){3,7}\b/gi,
      "$1: [OTP REDACTED]"
    );

    // Email
    text = text.replace(
      /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi,
      "[EMAIL REDACTED]"
    );

    // Indian phone numbers
    text = text.replace(
      /\b(?:\+91[\s-]?)?[6-9]\d{9}\b/g,
      "[PHONE REDACTED]"
    );

    // UPI IDs
    text = text.replace(
      /\b(UPI(?:\s+ID)?|VPA)\s*[:=]\s*[\w.-]+@[\w.-]+\b/gi,
      "$1: [UPI ID REDACTED]"
    );

    return text;
  }

  // SUPPORTED EDITORS
  function isEditable(element) {
    if (!(element instanceof HTMLElement)) return false;

    if (element instanceof HTMLTextAreaElement) return true;

    if (element instanceof HTMLInputElement) {
      return ["text", "search", "email", "url"].includes(element.type);
    }

    return element.isContentEditable ||
      element.getAttribute("role") === "textbox";
  }

  // Finds the real editable box, even inside rich editors (Gemini, ChatGPT)
  function getEditableTarget(event) {
    const path = event.composedPath ? event.composedPath() : [event.target];

    let found = null;
    for (const node of path) {
      if (node instanceof HTMLElement && isEditable(node)) {
        found = node;
        break;
      }
    }
    if (!found) return null;

    // climb to the outermost contenteditable (the whole text box)
    while (found.parentElement && found.parentElement.isContentEditable) {
      found = found.parentElement;
    }
    return found;
  }

  function readText(element) {
    if (
      element instanceof HTMLInputElement ||
      element instanceof HTMLTextAreaElement
    ) {
      return element.value;
    }

    return element.innerText || element.textContent || "";
  }

  function writeText(element, value) {
    if (tectoWriting) return;
    tectoWriting = true;

    try {
      if (
        element instanceof HTMLInputElement ||
        element instanceof HTMLTextAreaElement
      ) {
        const prototype = element instanceof HTMLTextAreaElement
          ? HTMLTextAreaElement.prototype
          : HTMLInputElement.prototype;

        const setter = Object.getOwnPropertyDescriptor(
          prototype,
          "value"
        )?.set;

        if (setter) setter.call(element, value);
        else element.value = value;
      } else {
        element.textContent = value;

        // keep the caret at the end after we rewrite the text
        try {
          const selection = window.getSelection();
          const range = document.createRange();
          range.selectNodeContents(element);
          range.collapse(false);
          selection.removeAllRanges();
          selection.addRange(range);
        } catch (e) { /* ignore */ }
      }

      element.dispatchEvent(new InputEvent("input", {
        bubbles: true,
        inputType: "insertText",
        data: null
      }));
    } finally {
      tectoWriting = false;
    }
  }

  // AI SECOND-PASS CHECK (only already-redacted text is sent)
  const aiChecked = new Set();
  const aiTimers = new WeakMap();

  function scheduleAiCheck(element) {
    clearTimeout(aiTimers.get(element));
    aiTimers.set(element, setTimeout(() => runAiCheck(element), 2000));
  }

  async function runAiCheck(element) {
    const text = readText(element).trim();

    if (!text || text.length < 15) return;
    if (aiChecked.has(text)) return;
    aiChecked.add(text);

    console.log("[Tecto] sending text to AI check, length:", text.length);

    try {
      const res = await chrome.runtime.sendMessage({
        type: "TECTO_AI_CHECK",
        text
      });

      console.log("[Tecto] AI check response:", res);

      if (!res?.success) {
        console.warn("Tecto AI check skipped:", res?.error || "no response from background");
        return;
      }

      if (!res.leaks?.length) return;

      // user kept typing while we waited, so skip
      if (readText(element).trim() !== text) {
        console.warn("Tecto AI check skipped: text changed while checking");
        return;
      }

      let safe = readText(element);
      let changed = 0;

      for (const leak of res.leaks) {
        if (typeof leak !== "string") continue;
        if (leak.length < 3 || /REDACTED/i.test(leak)) continue;

        if (safe.includes(leak)) {
          safe = safe.split(leak).join("[PERSONAL INFO REDACTED]");
          changed++;
        }
      }

      if (changed) {
        aiChecked.add(safe.trim());
        writeText(element, safe);
        showTectoNotification("Tecto AI: Personal info redacted!");
      } else {
        console.warn("Tecto AI check skipped: leaks not found in the text", res.leaks);
      }
    } catch (error) {
      console.warn("Tecto AI check skipped:", error.message || error);
    }
  }

  function protectEditor(element) {
    if (!isEditable(element)) return;

    const original = readText(element);
    if (!original) return;

    const safe = redactSensitiveText(original);

    if (safe !== original) {
      writeText(element, safe);

      showTectoNotification(
        "Tecto: Sensitive information redacted!"
      );
    }

    scheduleAiCheck(element);
  }

  document.addEventListener("input", event => {
    if (tectoWriting) return;

    const editable = getEditableTarget(event);

    console.log(
      "[Tecto] input event. target:",
      event.target?.tagName,
      "editable:",
      editable ? editable.tagName : "none"
    );

    if (editable) protectEditor(editable);
  }, true);

  // Backup: some rich editors do not fire "input" reliably, so also watch key presses
  document.addEventListener("keyup", event => {
    if (tectoWriting) return;

    const editable = getEditableTarget(event);
    if (editable) scheduleAiCheck(editable);
  }, true);

  // TEXT PASTE PROTECTION
  document.addEventListener("paste", event => {
    if (tectoEvents.has(event)) return;

    const target = event.target;

    if (!isEditable(target) || !event.clipboardData) return;

    const original = event.clipboardData.getData("text/plain");
    if (!original) return;

    const safe = redactSensitiveText(original);

    if (safe === original) return;

    event.preventDefault();

    if (
      target instanceof HTMLInputElement ||
      target instanceof HTMLTextAreaElement
    ) {
      const start = target.selectionStart ?? target.value.length;
      const end = target.selectionEnd ?? start;

      target.setRangeText(safe, start, end, "end");

      target.dispatchEvent(new InputEvent("input", {
        bubbles: true,
        inputType: "insertFromPaste",
        data: safe
      }));
    } else {
      const selection = window.getSelection();

      if (selection && selection.rangeCount > 0) {
        const range = selection.getRangeAt(0);
        range.deleteContents();

        const node = document.createTextNode(safe);
        range.insertNode(node);
        range.setStartAfter(node);
        range.collapse(true);

        selection.removeAllRanges();
        selection.addRange(range);

        target.dispatchEvent(new InputEvent("input", {
          bubbles: true,
          inputType: "insertFromPaste",
          data: safe
        }));
      }
    }

    showTectoNotification(
      "Tecto: Sensitive information redacted!"
    );
  }, true);

  // IMAGE REDACTION THROUGH OFFSCREEN OCR
  function fileToDataUrl(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();

      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(
        new Error("Could not read the selected image.")
      );

      reader.readAsDataURL(file);
    });
  }

  async function redactUploadedImage(file) {
    const dataUrl = await fileToDataUrl(file);

    // 90 second timeout so the scan can never hang forever
    const result = await Promise.race([
      chrome.runtime.sendMessage({
        type: "TECTO_REDACT_IMAGE",
        dataUrl,
        fileName: file.name
      }),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("OCR timed out after 90s")), 90000)
      )
    ]);

    if (!result?.success || !result.dataUrl) {
      throw new Error(result?.error || "Image scan failed.");
    }

    const response = await fetch(result.dataUrl);
    const blob = await response.blob();

    return {
      file: new File(
        [blob],
        file.name.replace(/\.[^.]+$/, "") + "-redacted.png",
        { type: "image/png" }
      ),
      count: result.count || 0
    };
  }

  async function redactFileList(fileList) {
    const transfer = new DataTransfer();
    let count = 0;

    for (const file of fileList) {
      if (!file.type.startsWith("image/")) {
        transfer.items.add(file);
        continue;
      }

      const result = await redactUploadedImage(file);
      transfer.items.add(result.file);
      count += result.count;
    }

    return { transfer, count };
  }

  // FILE INPUT (PAPERCLIP / UPLOAD BUTTON)
  async function handleFileInputChange(event) {
    if (tectoEvents.has(event)) return;

    const input = event.target;

    if (
      !(input instanceof HTMLInputElement) ||
      input.type !== "file" ||
      !input.files?.length
    ) {
      return;
    }

    const originalFiles = Array.from(input.files);

    if (!originalFiles.some(file => file.type.startsWith("image/"))) {
      return;
    }

    console.info("Tecto: image file selected, scanning...");

    // Block the site from seeing the unredacted file
    event.stopImmediatePropagation();

    try {
      showTectoNotification("Tecto: Scanning image...");

      const { transfer, count } = await redactFileList(originalFiles);

      input.files = transfer.files;

      const newEvent = new Event("change", { bubbles: true });
      tectoEvents.add(newEvent);
      input.dispatchEvent(newEvent);

      showTectoNotification(
        "Tecto: Image scan complete. Sensitive items covered: " + count
      );
    } catch (error) {
      console.error("Tecto image scan failed:", error);

      input.value = ""; // cancel the upload

      showTectoNotification(
        "Tecto: Image scan failed. Upload cancelled."
      );
    }
  }

  document.addEventListener("change", handleFileInputChange, true);

  // Also attach directly to every file input, in case the site blocks
  // the event before it reaches document
  function watchFileInput(input) {
    if (input.dataset.tectoWatched === "true") return;
    input.dataset.tectoWatched = "true";
    input.addEventListener("change", handleFileInputChange, true);
  }

  function scanForFileInputs(root) {
    if (!(root instanceof Element)) return;

    if (root.matches?.("input[type=file]")) watchFileInput(root);

    root.querySelectorAll?.("input[type=file]").forEach(watchFileInput);
  }

  scanForFileInputs(document.documentElement);

  new MutationObserver(mutations => {
    for (const mutation of mutations) {
      mutation.addedNodes.forEach(scanForFileInputs);
    }
  }).observe(document.documentElement, { childList: true, subtree: true });

  // IMAGE PASTE (Ctrl+V screenshot)
  document.addEventListener("paste", async event => {
    if (tectoEvents.has(event)) return;

    const files = Array.from(event.clipboardData?.files || []);
    if (!files.some(f => f.type.startsWith("image/"))) return;

    event.preventDefault();
    event.stopImmediatePropagation();

    const target = event.target;

    try {
      showTectoNotification("Tecto: Scanning image...");

      const { transfer, count } = await redactFileList(files);

      const newEvent = new ClipboardEvent("paste", {
        clipboardData: transfer,
        bubbles: true,
        cancelable: true
      });
      tectoEvents.add(newEvent);
      target.dispatchEvent(newEvent);

      showTectoNotification(
        "Tecto: Image scan complete. Sensitive items covered: " + count
      );
    } catch (error) {
      console.error("Tecto paste scan failed:", error);

      showTectoNotification("Tecto: Image scan failed. Paste cancelled.");
    }
  }, true);

  // IMAGE DRAG AND DROP
  document.addEventListener("drop", async event => {
    if (tectoEvents.has(event)) return;

    const files = Array.from(event.dataTransfer?.files || []);
    if (!files.some(f => f.type.startsWith("image/"))) return;

    event.preventDefault();
    event.stopImmediatePropagation();

    const target = event.target;

    try {
      showTectoNotification("Tecto: Scanning image...");

      const { transfer, count } = await redactFileList(files);

      const newEvent = new DragEvent("drop", {
        dataTransfer: transfer,
        bubbles: true,
        cancelable: true
      });
      tectoEvents.add(newEvent);
      target.dispatchEvent(newEvent);

      showTectoNotification(
        "Tecto: Image scan complete. Sensitive items covered: " + count
      );
    } catch (error) {
      console.error("Tecto drop scan failed:", error);

      showTectoNotification("Tecto: Image scan failed. Drop cancelled.");
    }
  }, true);

  console.info(
    "Tecto Privacy Guard loaded on " + location.hostname
  );
})();