const imageInput = document.getElementById("imageInput");
const canvas = document.getElementById("imageCanvas");
const ctx = canvas.getContext("2d", { willReadFrequently: false });

const markBtn = document.getElementById("markBtn");
const undoBtn = document.getElementById("undoBtn");
const downloadBtn = document.getElementById("downloadBtn");
const status = document.getElementById("status");

let sourceImage = null;
let redactions = [];
let marking = false;
let startPoint = null;
let previewRect = null;

imageInput.addEventListener("change", () => {
  const file = imageInput.files?.[0];

  if (!file) return;

  if (!file.type.startsWith("image/")) {
    status.textContent = "Please select an image file.";
    return;
  }

  if (file.size > 15 * 1024 * 1024) {
    status.textContent = "Image is too large. Choose an image under 15 MB.";
    imageInput.value = "";
    return;
  }

  const reader = new FileReader();

  reader.onload = () => {
    const image = new Image();

    image.onload = () => {
      sourceImage = image;
      canvas.width = image.naturalWidth;
      canvas.height = image.naturalHeight;

      redactions = [];
      previewRect = null;
      marking = false;

      markBtn.disabled = false;
      undoBtn.disabled = true;
      downloadBtn.disabled = false;

      markBtn.textContent = "Mark area to redact";
      drawImage();

      status.textContent =
        "Image loaded. Inspect it and mark each sensitive area.";
    };

    image.onerror = () => {
      status.textContent = "Could not read this image.";
    };

    image.src = reader.result;
  };

  reader.onerror = () => {
    status.textContent = "Could not open the selected file.";
  };

  reader.readAsDataURL(file);
});

function drawImage() {
  if (!sourceImage) return;

  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(sourceImage, 0, 0);

  ctx.fillStyle = "#000000";

  for (const rect of redactions) {
    ctx.fillRect(rect.x, rect.y, rect.width, rect.height);
  }

  if (previewRect) {
    ctx.save();
    ctx.strokeStyle = "#22c55e";
    ctx.lineWidth = Math.max(2, canvas.width / 400);
    ctx.setLineDash([8, 5]);
    ctx.strokeRect(
      previewRect.x,
      previewRect.y,
      previewRect.width,
      previewRect.height
    );
    ctx.restore();
  }
}

markBtn.addEventListener("click", () => {
  if (!sourceImage) return;

  marking = !marking;
  previewRect = null;

  markBtn.textContent = marking
    ? "Cancel marking"
    : "Mark area to redact";

  status.textContent = marking
    ? "Drag over the sensitive area you want to cover."
    : "Marking cancelled.";

  drawImage();
});

function getCanvasPoint(event) {
  const bounds = canvas.getBoundingClientRect();

  return {
    x: Math.max(
      0,
      Math.min(
        canvas.width,
        (event.clientX - bounds.left) * canvas.width / bounds.width
      )
    ),
    y: Math.max(
      0,
      Math.min(
        canvas.height,
        (event.clientY - bounds.top) * canvas.height / bounds.height
      )
    )
  };
}

canvas.addEventListener("pointerdown", (event) => {
  if (!marking || !sourceImage) return;

  event.preventDefault();
  startPoint = getCanvasPoint(event);
  previewRect = {
    x: startPoint.x,
    y: startPoint.y,
    width: 0,
    height: 0
  };

  canvas.setPointerCapture(event.pointerId);
});

canvas.addEventListener("pointermove", (event) => {
  if (!startPoint || !marking) return;

  const point = getCanvasPoint(event);

  previewRect = {
    x: Math.min(startPoint.x, point.x),
    y: Math.min(startPoint.y, point.y),
    width: Math.abs(point.x - startPoint.x),
    height: Math.abs(point.y - startPoint.y)
  };

  drawImage();
});

function finishMarking() {
  if (!startPoint || !previewRect) return;

  if (previewRect.width >= 2 && previewRect.height >= 2) {
    redactions.push({ ...previewRect });

    status.textContent =
      `Marked ${redactions.length} area(s). Inspect the image for missed details.`;

    undoBtn.disabled = false;
  }

  startPoint = null;
  previewRect = null;
  drawImage();
}

canvas.addEventListener("pointerup", finishMarking);

canvas.addEventListener("pointercancel", () => {
  startPoint = null;
  previewRect = null;
  drawImage();
});

undoBtn.addEventListener("click", () => {
  redactions.pop();
  undoBtn.disabled = redactions.length === 0;
  drawImage();

  status.textContent =
    `Undo complete. ${redactions.length} area(s) remain marked.`;
});

downloadBtn.addEventListener("click", () => {
  if (!sourceImage) return;

  if (redactions.length === 0) {
    status.textContent =
      "No areas marked. Mark sensitive areas before downloading.";
    return;
  }

  // Re-render without selection outlines before exporting.
  previewRect = null;
  drawImage();

  canvas.toBlob((blob) => {
    if (!blob) {
      status.textContent = "Could not export the redacted image.";
      return;
    }

    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");

    link.href = url;
    link.download = "tecto-redacted.png";
    link.click();

    setTimeout(() => URL.revokeObjectURL(url), 1000);

    status.textContent =
      "Redacted copy downloaded. Review it before sharing.";
  }, "image/png");
});