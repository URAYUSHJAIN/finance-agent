/**
 * Categorization eval harness.
 *
 * A hand-labeled set of realistic UPI / bank-statement lines with the
 * category a human would assign. We run each line through the SAME pipeline
 * the app uses (parseGenericText -> categorizeTransactions) and measure how
 * often the agent's category matches the label.
 *
 * Pure Node, no dependencies:
 *     node lib/eval.js
 * Prints per-category accuracy, overall accuracy, and every miss. Exits
 * non-zero if accuracy drops below THRESHOLD, so it can gate CI if wanted.
 *
 * This measures CATEGORIZATION accuracy specifically (did it pick the right
 * bucket), which is different from parser.test.js (did it read the amount /
 * direction / party correctly).
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { parseGenericText } from "./parser.js";
import { categorizeTransactions } from "./categorizeCore.js";

// Load the SAME rule table the app bundles, from disk (plain Node can't do a
// static JSON import without an assertion, and we want one source of truth).
const __dir = dirname(fileURLToPath(import.meta.url));
const rules = JSON.parse(readFileSync(join(__dir, "../data/categoryRules.json"), "utf8"));

// Accuracy below this fails the run.
const THRESHOLD = 0.9;

/**
 * Each case: a raw line as it might appear in a statement, and the category a
 * human reviewer would file it under. Kept diverse across every category and
 * across GPay / PhonePe / Paytm / bank-SMS phrasings.
 */
const LABELED = [
  // Food & Dining
  { line: "Paid ₹350 to Swiggy on 2 Jul 2026", expect: "Food & Dining" },
  { line: "You paid ₹640 to Zomato using HDFC Bank", expect: "Food & Dining" },
  { line: "UPI-P2M ₹220 to Dominos Pizza Ref 88123", expect: "Food & Dining" },
  { line: "Paid ₹80 at Chai Point cafe", expect: "Food & Dining" },

  // Groceries
  { line: "Paid ₹1,200 to Blinkit using UPI", expect: "Groceries" },
  { line: "₹540 debited to Zepto instamart", expect: "Groceries" },
  { line: "Spent ₹2,300 at DMart", expect: "Groceries" },
  { line: "Paid ₹760 to BigBasket for grocery", expect: "Groceries" },

  // Transport
  { line: "Paid ₹180 to Uber on 4 Jul 2026", expect: "Transport" },
  { line: "₹95 paid to Ola cabs", expect: "Transport" },
  { line: "Rapido ride ₹60 debited", expect: "Transport" },
  { line: "Fuel ₹2,000 at petrol pump", expect: "Transport" },
  { line: "IRCTC ticket ₹1,340 booked", expect: "Transport" },

  // Shopping
  { line: "Paid ₹3,499 to Amazon for order", expect: "Shopping" },
  { line: "Flipkart purchase ₹1,299 debited", expect: "Shopping" },
  { line: "₹899 to Myntra fashion", expect: "Shopping" },

  // Bills & Utilities
  { line: "Airtel recharge ₹399 done", expect: "Bills & Utilities" },
  { line: "Electricity bill ₹1,450 paid", expect: "Bills & Utilities" },
  { line: "Jio postpaid ₹599 debited", expect: "Bills & Utilities" },

  // Rent & Housing
  { line: "Sent ₹15,000 to Landlord for rent on 05/07/2026", expect: "Rent & Housing" },
  { line: "Hostel maintenance ₹2,500 paid", expect: "Rent & Housing" },

  // Subscriptions
  { line: "Netflix subscription ₹199 debited", expect: "Subscriptions" },
  { line: "Spotify premium ₹119 charged", expect: "Subscriptions" },
  { line: "ChatGPT Plus ₹1,650 to OpenAI", expect: "Subscriptions" },

  // Entertainment
  { line: "BookMyShow ₹500 for movie tickets", expect: "Entertainment" },
  { line: "PVR cinema ₹700 paid", expect: "Entertainment" },
  { line: "Steam gaming purchase ₹1,200", expect: "Entertainment" },

  // Health & Medical
  { line: "PharmEasy medicine ₹640 debited", expect: "Health & Medical" },
  { line: "Apollo pharmacy ₹320 paid", expect: "Health & Medical" },
  { line: "Doctor consultation ₹800 at clinic", expect: "Health & Medical" },

  // Education
  { line: "Udemy course ₹499 purchased", expect: "Education" },
  { line: "Coaching tuition fee ₹4,000 paid", expect: "Education" },

  // Investments
  { line: "Zerodha ₹5,000 added to Kite", expect: "Investments" },
  { line: "SIP mutual fund ₹2,000 debited via Groww", expect: "Investments" },

  // Transfers & Family
  { line: "Sent ₹3,000 to Papa on 1 Jul 2026", expect: "Transfers & Family" },
  { line: "Paid ₹1,000 to roommate for split", expect: "Transfers & Family" },

  // ATM & Cash
  { line: "Withdrew ₹2,000 from ATM on 3 Jul 2026", expect: "ATM & Cash" },
  { line: "Cash withdrawal ₹5,000 at branch", expect: "ATM & Cash" },

  // Income
  { line: "Salary ₹55,000 credited by Acme Corp", expect: "Income" },
  { line: "Received ₹500 refund from Amazon", expect: "Income" },
  { line: "Stipend ₹15,000 credited", expect: "Income" },
];

function categoryFor(line) {
  const { rows } = parseGenericText(line);
  if (!rows.length) return null;
  const [row] = categorizeTransactions(rows, rules);
  return row.category;
}

const byCategory = {};
const misses = [];
let correct = 0;

for (const { line, expect } of LABELED) {
  const got = categoryFor(line);
  const ok = got === expect;
  if (ok) correct += 1;
  else misses.push({ line, expect, got });

  const stat = (byCategory[expect] ||= { total: 0, correct: 0 });
  stat.total += 1;
  if (ok) stat.correct += 1;
}

const total = LABELED.length;
const accuracy = correct / total;

console.log("\nCategorization eval — per category:");
for (const [cat, s] of Object.entries(byCategory)) {
  const pct = ((s.correct / s.total) * 100).toFixed(0);
  console.log(`  ${pct.padStart(3)}%  ${cat}  (${s.correct}/${s.total})`);
}

if (misses.length) {
  console.log("\nMisses:");
  for (const m of misses) {
    console.log(`  ✗ "${m.line}"\n      want ${m.expect}, got ${m.got}`);
  }
}

const pct = (accuracy * 100).toFixed(1);
console.log(`\neval.js: ${correct}/${total} correct — ${pct}% categorization accuracy on a ${total}-transaction labeled test set`);

if (accuracy < THRESHOLD) {
  console.error(`\nFAIL: accuracy ${pct}% is below threshold ${(THRESHOLD * 100).toFixed(0)}%`);
  process.exit(1);
}
