let workerPromise = null;

function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(label + " timed out after " + ms / 1000 + "s")), ms)
    )
  ]);
}

function getWorker() {
  if (!workerPromise) {
    workerPromise = (async () => {
      const base = chrome.runtime.getURL('ocr'); // NO trailing slash

      if (typeof Tesseract === 'undefined') {
        throw new Error('Tesseract is not loaded. Check ocr/tesseract.min.js in offscreen.html');
      }

      console.log('[Tecto] creating Tesseract worker...');
      const worker = await withTimeout(
        Tesseract.createWorker('eng', 1, {
          workerPath: base + '/worker.min.js',
          corePath: base + '/tesseract-core.wasm.js',
          langPath: base,
          workerBlobURL: false,
          gzip: true,
          cacheMethod: 'none',
          logger: m => console.log('[Tecto] OCR:', m.status, m.progress),
          errorHandler: e => console.error('[Tecto] Worker error:', e)
        }),
        40000,
        'Tesseract worker start'
      );

      console.log('[Tecto] worker ready');
      return worker;
    })().catch(err => {
      console.error('[Tecto] getWorker failed:', err);
      workerPromise = null;
      throw err;
    });
  }
  return workerPromise;
}

// ---------- Sensitive text patterns ----------
// Any 12 digits in 4-4-4 groups (accepts sample numbers like 0000 1111 2222 too)
const AADHAAR_RE = /\b\d{4}\s?\d{4}\s?\d{4}\b/;

const PATTERNS = [
  /\b[A-Z]{5}[0-9]{4}[A-Z]\b/i,                                   // PAN
  /\b\d{4}[\s-]?\d{4}[\s-]?\d{4}\b/,                              // Aadhaar (any 12 digits)
  /(?:\+91[\s-]?)?\b[6-9]\d{9}\b/,                                // phone
  /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i,                   // email / UPI
  /\b(?:\d[\s-]?){13,19}\b/,                                      // card number / VID
  /\b\d{9,18}\b/,                                                 // account number
  /\b[A-Z]{4}0[A-Z0-9]{6}\b/i,                                    // IFSC
  /\b(?:CVV2?|CVC2?|CID)\b\s*[:=\-]?\s*\d{3,4}\b/i,               // CVV with label
  /\b\d{1,2}\s?[\/\-.]\s?\d{1,2}\s?[\/\-.]\s?\d{4}\b/,            // DOB dd/mm/yyyy
  /\b(?:DOB|D\.O\.B|Date\s*of\s*Birth|Year\s*of\s*Birth|YOB)\b\s*[:\-]?\s*[\d\/\-. ]{4,10}/i, // DOB with label
  /\b(?:0[1-9]|1[0-2])\s?\/\s?(?:\d{2}|\d{4})\b/,                 // card expiry MM/YY
  /\b(?:OTP|code|pin)\s*[:=-]?\s*\d{4,8}\b/i                      // OTP / PIN
];

// Extra patterns used only when the image is an ID card
const ID_ONLY_PATTERNS = [
  /\b[1-9]\d{5}\b/                                                // PIN code
];

// Extra patterns used only when the image is a bank card
const BANK_ONLY_PATTERNS = [
  /^\d{3,4}$/                                                     // CVV without label
];

const ID_KEYWORDS =
  /(income\s*tax|permanent\s*account|aadhaar|aadhar|unique\s*identification|uidai|government\s*of\s*india|govt\.?\s*of\s*india|driving\s*licen|election\s*commission|elector|passport|republic\s*of\s*india)/i;

const BANK_KEYWORDS =
  /(valid\s*thru|valid\s*upto|good\s*thru|debit|credit|visa|mastercard|rupay|platinum|signature|authorized|authorised|customer\s*care)/i;

const AADHAAR_KEYWORDS = /(aadhaar|aadhar|unique\s*identification|uidai|mera\s*aadhaar)/i;
const AADHAAR_HINTS = /(\bmale\b|\bfemale\b|gender|\bdob\b|year\s*of\s*birth|date\s*of\s*birth)/i;
const PAN_KEYWORDS = /(income\s*tax|permanent\s*account)/i;
const GOV_LINE_RE = /(government\s*of\s*india|govt\.?\s*of\s*india)/i;

function getLines(data) {
  if (data.lines) return data.lines;
  return (data.blocks || []).flatMap(b => b.paragraphs.flatMap(p => p.lines));
}

function lineText(line) {
  return (line.words || []).map(w => w.text).join(' ');
}

function boxOf(words) {
  return {
    x0: Math.min(...words.map(w => w.bbox.x0)),
    y0: Math.min(...words.map(w => w.bbox.y0)),
    x1: Math.max(...words.map(w => w.bbox.x1)),
    y1: Math.max(...words.map(w => w.bbox.y1))
  };
}

// Words of a line that match a regex (maps text matches back to OCR words)
function wordsMatching(line, re, extraWholeWord = false) {
  let text = '';
  const spans = [];
  (line.words || []).forEach((w, i) => {
    if (i) text += ' ';
    spans.push({ start: text.length, end: text.length + w.text.length, w });
    text += w.text;
  });

  const hits = new Set();

  if (extraWholeWord) {
    spans.forEach(sp => { if (re.test(sp.w.text.trim())) hits.add(sp.w); });
    return [...hits];
  }

  const g = new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g');
  let m;
  while ((m = g.exec(text))) {
    const s = m.index, e = s + m[0].length;
    spans.forEach(sp => { if (sp.start < e && sp.end > s) hits.add(sp.w); });
    if (m[0].length === 0) g.lastIndex++;
  }
  return [...hits];
}

function findSensitiveWords(line, isIdCard, isBankCard) {
  const hits = new Set();
  PATTERNS.forEach(re => wordsMatching(line, re).forEach(w => hits.add(w)));
  if (isIdCard) ID_ONLY_PATTERNS.forEach(re => wordsMatching(line, re).forEach(w => hits.add(w)));
  if (isBankCard) BANK_ONLY_PATTERNS.forEach(re => wordsMatching(line, re, true).forEach(w => hits.add(w)));
  return [...hits];
}

// ---------- QR code detection (jsQR) ----------
function findQrCodes(sourceCanvas) {
  const boxes = [];
  if (typeof jsQR === 'undefined') {
    console.warn('[Tecto] jsQR not loaded, QR detection skipped');
    return boxes;
  }

  const scratch = document.createElement('canvas');
  scratch.width = sourceCanvas.width;
  scratch.height = sourceCanvas.height;
  const sctx = scratch.getContext('2d', { willReadFrequently: true });
  sctx.drawImage(sourceCanvas, 0, 0);

  for (let i = 0; i < 3; i++) {
    const d = sctx.getImageData(0, 0, scratch.width, scratch.height);
    const code = jsQR(d.data, d.width, d.height, { inversionAttempts: 'attemptBoth' });
    if (!code) break;

    const l = code.location;
    const xs = [l.topLeftCorner.x, l.topRightCorner.x, l.bottomLeftCorner.x, l.bottomRightCorner.x];
    const ys = [l.topLeftCorner.y, l.topRightCorner.y, l.bottomLeftCorner.y, l.bottomRightCorner.y];
    const box = {
      x0: Math.min(...xs), y0: Math.min(...ys),
      x1: Math.max(...xs), y1: Math.max(...ys)
    };
    boxes.push(box);

    sctx.fillStyle = '#fff';
    sctx.fillRect(box.x0 - 5, box.y0 - 5, box.x1 - box.x0 + 10, box.y1 - box.y0 + 10);
  }
  return boxes;
}

// ---------- Photo (face) detection, only if the browser supports it ----------
async function findFaces(sourceCanvas) {
  if (!('FaceDetector' in window)) return null;
  try {
    const detector = new FaceDetector({ fastMode: false, maxDetectedFaces: 5 });
    const faces = await detector.detect(sourceCanvas);
    return faces.map(f => {
      const b = f.boundingBox;
      const px = b.width * 0.35;
      return {
        x0: b.x - px,
        y0: b.y - b.height * 0.45,
        x1: b.x + b.width + px,
        y1: b.y + b.height + b.height * 0.3
      };
    });
  } catch (e) {
    console.warn('[Tecto] FaceDetector failed:', e);
    return null;
  }
}

// ---------- PAN card layout ----------
function findPanAnchor(lines, scale) {
  for (const line of lines) {
    if (/permanent\s*account|account\s*number\s*card/i.test(lineText(line)) && (line.words || []).length) {
      const b = boxOf(line.words);
      return { x0: b.x0 / scale, y0: b.y0 / scale, x1: b.x1 / scale, y1: b.y1 / scale };
    }
  }
  return null;
}

// ---------- Aadhaar card layout ----------
// Anchor = the big 12-digit number at the bottom. The number is about 40% of the card width.
function findAadhaarLayout(lines, scale) {
  let numBox = null;

  for (const line of lines) {
    const words = wordsMatching(line, AADHAAR_RE);
    if (words.length) {
      const b = boxOf(words);
      const box = {
        x0: b.x0 / scale, y0: b.y0 / scale, x1: b.x1 / scale, y1: b.y1 / scale
      };
      box.h = box.y1 - box.y0;
      // the biggest text is the main Aadhaar number (VID is smaller)
      if (!numBox || box.h > numBox.h) numBox = box;
    }
  }
  if (!numBox) return null;

  const cw = (numBox.x1 - numBox.x0) / 0.40; // estimated card width
  const cx = (numBox.x0 + numBox.x1) / 2;
  return { left: cx - cw / 2, cw, numBox };
}

async function processImage(dataUrl) {
  console.log('[Tecto] processImage started');

  const img = new Image();
  img.src = dataUrl;
  await new Promise((res, rej) => {
    img.onload = res;
    img.onerror = () => rej(new Error('Failed to load image data.'));
  });

  const W = img.naturalWidth;
  const H = img.naturalHeight;

  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(img, 0, 0);

  // Upscale small images for better OCR accuracy
  const scale = W < 1400 ? Math.min(3, 1400 / W) : 1;
  const ocrCanvas = document.createElement('canvas');
  ocrCanvas.width = Math.round(W * scale);
  ocrCanvas.height = Math.round(H * scale);
  ocrCanvas.getContext('2d').drawImage(img, 0, 0, ocrCanvas.width, ocrCanvas.height);

  const worker = await getWorker();

  console.log('[Tecto] running recognize...');
  const { data } = await withTimeout(
    worker.recognize(ocrCanvas, {}, { blocks: true }),
    60000,
    'OCR recognize'
  );

  const lines = getLines(data);
  const fullText = lines.map(lineText).join('\n');
  console.log('[Tecto] OCR text:', fullText);

  const isPan = PAN_KEYWORDS.test(fullText);
  const isAadhaar = !isPan && (
    AADHAAR_KEYWORDS.test(fullText) ||
    AADHAAR_RE.test(fullText.replace(/\n/g, ' ')) ||
    (GOV_LINE_RE.test(fullText) && AADHAAR_HINTS.test(fullText))
  );
  const isIdCard = ID_KEYWORDS.test(fullText) || isAadhaar;
  const isBankCard = !isIdCard && BANK_KEYWORDS.test(fullText);

  // Clean copy, used for QR / face detection before we paint on the output
  const cleanCanvas = document.createElement('canvas');
  cleanCanvas.width = W;
  cleanCanvas.height = H;
  cleanCanvas.getContext('2d').drawImage(img, 0, 0);

  ctx.fillStyle = '#000';
  let count = 0;

  function blackout(x0, y0, x1, y1, pad = 4) {
    const x = Math.max(0, x0 - pad);
    const y = Math.max(0, y0 - pad);
    const w = Math.min(W - x, x1 - x0 + pad * 2);
    const h = Math.min(H - y, y1 - y0 + pad * 2);
    if (w > 0 && h > 0) {
      ctx.fillRect(x, y, w, h);
      count++;
    }
  }

  // 1) Sensitive text
  for (const line of lines) {
    for (const word of findSensitiveWords(line, isIdCard, isBankCard)) {
      const b = word.bbox;
      blackout(b.x0 / scale, b.y0 / scale, b.x1 / scale, b.y1 / scale);
    }
  }
  console.log('[Tecto] text items covered:', count);

  // 2) QR codes (any image)
  let qrBoxes = findQrCodes(cleanCanvas);
  if (!qrBoxes.length && scale !== 1) {
    qrBoxes = findQrCodes(ocrCanvas).map(b => ({
      x0: b.x0 / scale, y0: b.y0 / scale, x1: b.x1 / scale, y1: b.y1 / scale
    }));
  }
  qrBoxes.forEach(b => blackout(b.x0, b.y0, b.x1, b.y1, 8));
  console.log('[Tecto] QR codes found by jsQR:', qrBoxes.length);

  // 3) Photo + QR fallback for ID cards
  if (isIdCard) {
    console.log('[Tecto] ID card detected. PAN:', isPan, 'Aadhaar:', isAadhaar);

    const faces = await findFaces(cleanCanvas);
    let photoDone = false;

    if (faces && faces.length) {
      faces.forEach(b => blackout(b.x0, b.y0, b.x1, b.y1, 0));
      photoDone = true;
      console.log('[Tecto] faces covered:', faces.length);
    }

    if (isPan) {
      const a = findPanAnchor(lines, scale);
      if (a) {
        const L = a.x1 - a.x0;
        if (!photoDone) {
          blackout(a.x0 - 0.80 * L, a.y0 - 0.14 * L, a.x0 - 0.06 * L, a.y0 + 0.66 * L, 0);
          console.log('[Tecto] PAN photo area covered (layout fallback)');
        }
        if (!qrBoxes.length) {
          blackout(a.x1 - 0.08 * L, a.y0 + 0.16 * L, a.x1 + 0.74 * L, a.y0 + 0.86 * L, 0);
          console.log('[Tecto] PAN QR area covered (layout fallback)');
        }
      } else {
        console.warn('[Tecto] PAN anchor line not found');
      }
    } else if (isAadhaar) {
      const L = findAadhaarLayout(lines, scale);
      if (L) {
        const { left, cw, numBox } = L;
        const nTop = numBox.y0;
        console.log('[Tecto] Aadhaar layout: card width ~' + Math.round(cw) + 'px');

        if (!photoDone) {
          // photo: left side, just above the number
          blackout(left + 0.03 * cw, nTop - 0.37 * cw, left + 0.305 * cw, nTop - 0.005 * cw, 0);
          console.log('[Tecto] Aadhaar photo area covered (layout fallback)');
        }
        if (!qrBoxes.length) {
          // QR: right side, ending a little below the number's top
          blackout(left + 0.70 * cw, nTop - 0.24 * cw, left + 0.97 * cw, nTop + 0.04 * cw, 0);
          console.log('[Tecto] Aadhaar QR area covered (layout fallback)');
        }
      } else if (!photoDone) {
        // Aadhaar number not read by OCR: rough fractions of the whole image
        blackout(W * 0.02, H * 0.25, W * 0.30, H * 0.90, 0);
        if (!qrBoxes.length) blackout(W * 0.70, H * 0.20, W * 0.98, H * 0.85, 0);
        console.log('[Tecto] Aadhaar number not found, rough fallback areas covered');
      }
    } else if (!photoDone) {
      console.warn('[Tecto] ID card found but no photo area detected');
    }
  }

  if (isBankCard) {
    console.log('[Tecto] bank card detected (numbers, expiry, CVV covered)');
  }

  return { dataUrl: canvas.toDataURL('image/png'), count };
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.target !== 'offscreen' || message.type !== 'TECTO_REDACT_IMAGE') return;

  processImage(message.dataUrl)
    .then(r => sendResponse({ success: true, ...r }))
    .catch(e => {
      console.error('[Tecto] Offscreen error:', e);
      sendResponse({ success: false, error: e.message });
    });
  return true;
});

console.log('[Tecto] offscreen.js ready');