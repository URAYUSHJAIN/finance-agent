/**
 * Generic, best-effort UPI transaction parser.
 * No AI/API calls — pure regex + heuristics, so it's app-agnostic
 * (works reasonably across GPay, PhonePe, Paytm, and plain bank exports).
 */

const MONTHS = "jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec";

const DATE_PATTERNS = [
  new RegExp(`\\b(\\d{1,2})\\s+(${MONTHS})[a-z]*\\.?\\s+(\\d{2,4})\\b`, "i"),
  /\b(\d{4})[\/\-.](\d{1,2})[\/\-.](\d{1,2})\b/, // ISO 2026-07-01
  /\b(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2,4})\b/,
  new RegExp(`\\b(${MONTHS})[a-z]*\\.?\\s+(\\d{1,2}),?\\s+(\\d{2,4})\\b`, "i"),
];

// Date substrings we strip out BEFORE any fallback amount hunting, so a
// day-of-month or year never gets mistaken for a rupee value.
const DATE_STRIP_PATTERNS = [
  new RegExp(`\\b\\d{1,2}\\s+(?:${MONTHS})[a-z]*\\.?(?:\\s+\\d{2,4})?\\b`, "ig"),
  new RegExp(`\\b(?:${MONTHS})[a-z]*\\.?\\s+\\d{1,2},?(?:\\s+\\d{2,4})?\\b`, "ig"),
  /\b\d{4}[\/\-.]\d{1,2}[\/\-.]\d{1,2}\b/g, // ISO
  /\b\d{1,2}[\/\-.]\d{1,2}[\/\-.]\d{2,4}\b/g,
  /\b\d{1,2}[\/\-]\d{1,2}\b/g, // partial dd/mm
];

const AMOUNT_PATTERN = /(?:₹|rs\.?|inr)\s?([\d,]+(?:\.\d{1,2})?)/i;
// Fallback candidate: any number, optionally comma-grouped, optional 1-2 decimals.
const NUMBER_TOKEN = /\d[\d,]*(?:\.\d{1,2})?/g;
// Context immediately before a number that marks it as NOT an amount
// (masked account tails, reference/txn ids, VPA handles, phone labels).
const NON_AMOUNT_PREFIX = /(?:x+|a\/c|ac|acct|account|ref|txn|no\.?|vpa|upi|mob|ph|id|xx)\s*$/i;

const DEBIT_HINTS = [
  "paid", "pay to", "debited", "debit", "sent", "withdraw", "withdrew", "withdrawal",
  "spent", "purchase", "bought", "p2m", "pos ", "trf to", "transfer to",
];
const CREDIT_HINTS = [
  "received", "credited", "credit", "refund", "cashback", "salary", "stipend",
  "deposit", "neft cr", "imps cr", "payout", "reversal",
];

function extractDate(line) {
  for (const pattern of DATE_PATTERNS) {
    const m = line.match(pattern);
    if (m) return m[0];
  }
  return null;
}

/**
 * Best-effort amount extraction.
 * 1. Prefer a value explicitly tagged with ₹ / Rs / INR (unambiguous).
 * 2. Otherwise fall back to bare numbers — but only AFTER stripping dates,
 *    and after rejecting phone numbers, account/reference ids, years, and
 *    other long digit runs that used to cause misfires. Among survivors we
 *    prefer a value with paise (`.dd`) or a thousands separator, taking the
 *    earliest (statement amount usually precedes the running balance).
 */
function extractAmount(line) {
  const tagged = line.match(AMOUNT_PATTERN);
  if (tagged) {
    const val = parseFloat(tagged[1].replace(/,/g, ""));
    if (Number.isFinite(val) && val > 0) return val;
  }
  return fallbackAmount(line);
}

function fallbackAmount(line) {
  const cleaned = DATE_STRIP_PATTERNS.reduce((s, p) => s.replace(p, " "), line);
  const candidates = [];
  let m;
  NUMBER_TOKEN.lastIndex = 0;
  while ((m = NUMBER_TOKEN.exec(cleaned)) !== null) {
    const token = m[0];
    const digits = token.replace(/,/g, "");
    const intPart = digits.split(".")[0];
    const hasDecimal = /\.\d{1,2}$/.test(token);
    const hasSep = token.includes(",");
    const val = parseFloat(digits);
    if (!Number.isFinite(val) || val <= 0) continue;
    // Long unseparated digit runs => phone / account / OTP / reference id.
    if (!hasSep && intPart.length >= 6) continue;
    // Bare 4-digit year with no currency cue.
    if (!hasDecimal && !hasSep && /^(?:19|20)\d{2}$/.test(intPart)) continue;
    // Reject when the preceding text marks it as an id / account / handle.
    if (NON_AMOUNT_PREFIX.test(cleaned.slice(Math.max(0, m.index - 8), m.index))) continue;
    candidates.push({ val, hasDecimal, hasSep });
  }
  if (!candidates.length) return null;
  const decimal = candidates.find((c) => c.hasDecimal);
  if (decimal) return decimal.val;
  const grouped = candidates.find((c) => c.hasSep);
  if (grouped) return grouped.val;
  return candidates[0].val;
}

function extractDirection(lowerLine) {
  if (DEBIT_HINTS.some((h) => lowerLine.includes(h))) return "debit";
  if (CREDIT_HINTS.some((h) => lowerLine.includes(h))) return "credit";
  return "unknown";
}

function extractParty(line, lowerLine) {
  let m = lowerLine.match(/\b(?:to|from)\s+(?:vpa\s+)?([a-z0-9@.\s&'_-]{2,40})/i);
  if (m) {
    return (
      m[1]
        .replace(/\b(?:via|using|ref|upi|on|for|dated|txn|avl|bal|a\/c)\b.*/i, "")
        .replace(/[.,;:\s]+$/, "")
        .trim()
        .slice(0, 40) || "Unknown"
    );
  }
  // Fallback: strip known noise words and pick remaining text as description
  const cleaned = line
    .replace(AMOUNT_PATTERN, "")
    .replace(/₹|rs\.?|inr/gi, "")
    .trim();
  return cleaned.slice(0, 40) || "Unknown";
}

/**
 * Parses raw pasted/PDF-extracted text into normalized transaction rows.
 * Every line is attempted independently; unparseable lines are collected
 * in `skipped` rather than throwing, so one bad line never kills the batch.
 */
export function parseGenericText(raw) {
  const lines = raw
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 3);

  const rows = [];
  const skipped = [];

  for (const line of lines) {
    try {
      const lower = line.toLowerCase();
      const amount = extractAmount(line);
      if (amount === null || amount <= 0) {
        skipped.push({ line, reason: "No valid amount found" });
        continue;
      }
      const direction = extractDirection(lower);
      const date = extractDate(line);
      const party = extractParty(line, lower);

      rows.push({
        date: date || "Unknown",
        description: party,
        amount,
        direction, // 'debit' | 'credit' | 'unknown'
        raw: line,
      });
    } catch (err) {
      skipped.push({ line, reason: err.message });
    }
  }

  return { rows, skipped };
}

const MONTH_INDEX = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};
const MONTH_LABEL = ["", "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/**
 * Normalizes the many date string shapes the parser emits ("2 Jul 2026",
 * "05/07/2026", "2026-07-01", "03-07-26", "Jul 2, 2026") into a sortable
 * month bucket. Numeric slash/dash dates are read as dd/mm/yyyy (Indian
 * statement convention). Returns null for "Unknown" / unrecognized dates so
 * callers can simply skip them from month-over-month roll-ups.
 */
export function toMonthKey(dateStr) {
  if (!dateStr || String(dateStr).trim().toLowerCase() === "unknown") return null;
  const s = String(dateStr).trim().toLowerCase();
  let mo, y, m;

  if ((m = s.match(new RegExp(`\\b(\\d{1,2})\\s+(${MONTHS})[a-z]*\\.?\\s+(\\d{2,4})\\b`)))) {
    mo = MONTH_INDEX[m[2]];
    y = Number(m[3]);
  } else if ((m = s.match(new RegExp(`\\b(${MONTHS})[a-z]*\\.?\\s+(\\d{1,2}),?\\s+(\\d{2,4})\\b`)))) {
    mo = MONTH_INDEX[m[1]];
    y = Number(m[3]);
  } else if ((m = s.match(/\b(\d{4})[\/\-.](\d{1,2})[\/\-.](\d{1,2})\b/))) {
    y = Number(m[1]);
    mo = Number(m[2]);
  } else if ((m = s.match(/\b(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2,4})\b/))) {
    mo = Number(m[2]);
    y = Number(m[3]);
  } else {
    return null;
  }

  if (!Number.isFinite(y) || !Number.isFinite(mo) || mo < 1 || mo > 12) return null;
  if (y < 100) y += 2000;
  return { key: `${y}-${String(mo).padStart(2, "0")}`, label: `${MONTH_LABEL[mo]} ${y}` };
}

const HEADER_ALIASES = {
  date: ["date", "transaction date", "txn date", "value date"],
  description: ["description", "narration", "particulars", "remarks", "details", "payee", "merchant"],
  amount: ["amount", "amt", "value"],
  debit: ["debit", "withdrawal", "dr"],
  credit: ["credit", "deposit", "cr"],
  type: ["type", "transaction type", "dr/cr"],
};

function findHeader(headers, aliases) {
  return headers.find((h) => aliases.includes(String(h).trim().toLowerCase()));
}

/**
 * Normalizes rows already parsed from CSV/XLSX (array of plain objects,
 * keyed by header) into the same shape produced by parseGenericText.
 */
export function parseTabularRows(sheetRows) {
  const rows = [];
  const skipped = [];
  if (!sheetRows || !sheetRows.length) return { rows, skipped };

  const headers = Object.keys(sheetRows[0]);
  const dateKey = findHeader(headers, HEADER_ALIASES.date);
  const descKey = findHeader(headers, HEADER_ALIASES.description);
  const amountKey = findHeader(headers, HEADER_ALIASES.amount);
  const debitKey = findHeader(headers, HEADER_ALIASES.debit);
  const creditKey = findHeader(headers, HEADER_ALIASES.credit);
  const typeKey = findHeader(headers, HEADER_ALIASES.type);

  sheetRows.forEach((r, idx) => {
    try {
      let amount = null;
      let direction = "unknown";

      if (amountKey && r[amountKey] !== undefined && r[amountKey] !== "") {
        amount = parseFloat(String(r[amountKey]).replace(/[₹,]/g, ""));
        if (typeKey) {
          const t = String(r[typeKey] || "").toLowerCase();
          direction = t.includes("cr") || t.includes("credit") ? "credit" : "debit";
        } else {
          direction = amount < 0 ? "debit" : "credit";
        }
      } else if (debitKey || creditKey) {
        const debitVal = debitKey ? parseFloat(String(r[debitKey]).replace(/[₹,]/g, "")) : NaN;
        const creditVal = creditKey ? parseFloat(String(r[creditKey]).replace(/[₹,]/g, "")) : NaN;
        if (Number.isFinite(debitVal) && debitVal > 0) {
          amount = debitVal;
          direction = "debit";
        } else if (Number.isFinite(creditVal) && creditVal > 0) {
          amount = creditVal;
          direction = "credit";
        }
      }

      if (amount === null || !Number.isFinite(amount) || amount <= 0) {
        skipped.push({ line: JSON.stringify(r), reason: "No valid amount column found" });
        return;
      }

      rows.push({
        date: dateKey ? String(r[dateKey]) : "Unknown",
        description: descKey ? String(r[descKey]).slice(0, 60) : `Row ${idx + 1}`,
        amount: Math.abs(amount),
        direction,
        raw: JSON.stringify(r),
      });
    } catch (err) {
      skipped.push({ line: JSON.stringify(r), reason: err.message });
    }
  });

  return { rows, skipped };
}
