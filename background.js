let creating;

async function ensureOffscreen() {
  const ctx = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
  if (ctx.length) return;
  if (!creating) {
    creating = chrome.offscreen.createDocument({
      url: 'offscreen.html',
      reasons: ['WORKERS'],
      justification: 'Run Tesseract OCR worker and canvas for image redaction'
    }).finally(() => { creating = null; });
  }
  await creating;
}

async function sendToOffscreen(msg, tries = 15) {
  for (let i = 0; i < tries; i++) {
    try {
      const res = await chrome.runtime.sendMessage(msg);
      if (res) return res;
    } catch (e) {
      if (i === tries - 1) throw e;
    }
    await new Promise(r => setTimeout(r, 200));
  }
  throw new Error('Offscreen document did not respond.');
}

// Local AI check server (Nebius Token Factory behind it)
const AI_CHECK_URL = 'http://localhost:3001/check';

async function aiCheck(text) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20000);
  try {
    console.log('[Tecto] AI check request, length:', text.length);

    const res = await fetch(AI_CHECK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
      signal: controller.signal
    });
    if (!res.ok) throw new Error('AI server returned ' + res.status);

    const json = await res.json();
    console.log('[Tecto] AI check result:', json);

    return { success: true, leaks: Array.isArray(json.leaks) ? json.leaks : [] };
  } finally {
    clearTimeout(timer);
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // Image redaction
  if (message.type === 'TECTO_REDACT_IMAGE' && message.target !== 'offscreen') {
    (async () => {
      try {
        await ensureOffscreen();
        const result = await sendToOffscreen({
          target: 'offscreen',
          type: 'TECTO_REDACT_IMAGE',
          dataUrl: message.dataUrl
        });
        sendResponse(result);
      } catch (err) {
        sendResponse({ success: false, error: err.message });
      }
    })();
    return true;
  }

  // AI second-pass check on already redacted text
  if (message.type === 'TECTO_AI_CHECK') {
    aiCheck(String(message.text || ''))
      .then(sendResponse)
      .catch(err => {
        console.warn('[Tecto] AI check failed:', err.message);
        sendResponse({ success: false, error: err.message, leaks: [] });
      });
    return true;
  }
});