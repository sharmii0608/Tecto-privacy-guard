const original = document.getElementById("original");
const sanitized = document.getElementById("sanitized");
const scanBtn = document.getElementById("scanBtn");
const copyBtn = document.getElementById("copyBtn");
const clearBtn = document.getElementById("clearBtn");
const resultSection = document.getElementById("resultSection");
const summary = document.getElementById("summary");

function redactText(input) {
  let text = input;
  const found = new Set();

  function replace(pattern, replacement, category) {
    text = text.replace(pattern, (...args) => {
      found.add(category);
      return typeof replacement === "function"
        ? replacement(...args)
        : replacement;
    });
  }

  // PAN card number
  replace(
    /\b[A-Z]{5}[0-9]{4}[A-Z]\b/gi,
    "[PAN REDACTED]",
    "PAN"
  );

  // Aadhaar-like or other 12-digit numbers
  replace(
    /\b\d{4}[ -]?\d{4}[ -]?\d{4}\b/g,
    "[12-DIGIT NUMBER REDACTED]",
    "12-digit number"
  );

  // Passwords and passcodes
  replace(
    /\b(password|passwd|passcode)\s*[:=]\s*\S+/gi,
    (match, label) => `${label}: [PASSWORD REDACTED]`,
    "Password"
  );

  // OTP and verification codes
  replace(
    /\b(OTP|verification code)\s*[:=]?\s*\d{4,8}\b/gi,
    (match, label) => `${label}: [OTP REDACTED]`,
    "OTP"
  );

  // UPI IDs when labelled
  replace(
    /\b(UPI(?:\s+ID)?|VPA)\s*[:=]\s*[\w.-]+@[\w.-]+\b/gi,
    (match, label) => `${label}: [UPI ID REDACTED]`,
    "UPI ID"
  );

  // Indian phone numbers, including labelled numbers
  replace(
    /\b(?:(phone|mobile|contact number|phone number)\s*[:=]?\s*)?(?:\+91[\s-]?)?[6-9]\d{9}\b/gi,
    (match, label) => {
      if (label) {
        return `${label}: [PHONE REDACTED]`;
      }
      return "[PHONE REDACTED]";
    },
    "Phone"
  );

  // Email addresses
  replace(
    /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi,
    "[EMAIL REDACTED]",
    "Email"
  );

  return {
    text,
    categories: [...found]
  };
}

scanBtn.addEventListener("click", () => {
  const input = original.value;

  if (!input.trim()) {
    summary.textContent = "Please enter text to scan.";
    sanitized.value = "";
    resultSection.hidden = false;
    return;
  }

  const result = redactText(input);

  sanitized.value = result.text;
  resultSection.hidden = false;

  if (result.categories.length > 0) {
    summary.textContent =
      "Detected and redacted: " + result.categories.join(", ") +
      ". Review the protected text before sharing.";
  } else {
    summary.textContent =
      "No supported sensitive patterns detected. " +
      "This does not guarantee the text is safe.";
  }
});

copyBtn.addEventListener("click", async () => {
  if (!sanitized.value) {
    summary.textContent = "Scan some text first.";
    return;
  }

  try {
    await navigator.clipboard.writeText(sanitized.value);
    summary.textContent =
      "Protected text copied. Review it before sharing.";
  } catch (error) {
    sanitized.focus();
    sanitized.select();

    summary.textContent =
      "Automatic copying failed. Press Ctrl+C to copy the selected text.";
  }
});

clearBtn.addEventListener("click", () => {
  original.value = "";
  sanitized.value = "";
  resultSection.hidden = true;
  summary.textContent = "";
  original.focus();
});