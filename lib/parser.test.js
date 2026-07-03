/**
 * Regression tests for the transaction parser.
 *
 * Pure Node, no test framework / no dependencies — run with:
 *     node lib/parser.test.js
 * Exits non-zero if any assertion fails, so it can gate a build if wanted.
 *
 * Focus areas:
 *   - real-world GPay / PhonePe / bank-SMS line shapes
 *   - the tightened fallback amount extractor (no more misfiring on dates,
 *     phone numbers, account tails, reference ids, years, OTPs, balances)
 */

import { parseGenericText, parseTabularRows } from "./parser.js";

let passed = 0;
let failed = 0;

function check(name, cond, detail) {
  if (cond) {
    passed += 1;
  } else {
    failed += 1;
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

/** Parse a single line and return its first row (or null). */
function one(line) {
  const { rows } = parseGenericText(line);
  return rows[0] || null;
}

function expectRow(name, line, { amount, direction, party }) {
  const r = one(line);
  if (!r) return check(name, false, "line was skipped (no amount found)");
  if (amount !== undefined) check(`${name} · amount`, r.amount === amount, `got ${r.amount}, want ${amount}`);
  if (direction !== undefined)
    check(`${name} · direction`, r.direction === direction, `got ${r.direction}, want ${direction}`);
  if (party !== undefined)
    check(
      `${name} · party`,
      r.description.toLowerCase().includes(party.toLowerCase()),
      `got "${r.description}", want to contain "${party}"`
    );
}

// ---------- Real-world line patterns ----------
expectRow("GPay: You paid ₹X to Y using Bank", "You paid ₹1,200 to Blinkit using HDFC Bank", {
  amount: 1200,
  direction: "debit",
  party: "blinkit",
});

expectRow("PhonePe: ₹X received from Y", "₹500 received from Rahul via PhonePe", {
  amount: 500,
  direction: "credit",
  party: "rahul",
});

expectRow("GPay: Paid ₹X to Y on date", "Paid ₹350 to Swiggy on 2 Jul 2026", {
  amount: 350,
  direction: "debit",
  party: "swiggy",
});

expectRow("UPI P2M merchant pay", "UPI-P2M ₹640.50 to Zomato Ref 402312556789", {
  amount: 640.5,
  direction: "debit",
  party: "zomato",
});

expectRow("Sent ₹X to person for rent", "Sent ₹15000 to Sanjay Jain for rent on 05/07/2026", {
  amount: 15000,
  direction: "debit",
  party: "sanjay jain",
});

expectRow("Withdrew ₹X from ATM", "Withdrew ₹2000 from ATM on 3 Jul 2026", {
  amount: 2000,
  direction: "debit",
});

expectRow("Large amount with lakh grouping", "Paid ₹1,00,000 to Landlord for rent", {
  amount: 100000,
  direction: "debit",
  party: "landlord",
});

// Bank SMS: amount tagged with Rs, a masked a/c, a VPA payee, a ref id, and a
// trailing balance also tagged with Rs. Must pick the FIRST Rs value, not the
// balance, and read the VPA handle as the party.
expectRow(
  "Bank SMS with a/c, VPA, ref, balance",
  "Rs.2,499.00 debited from a/c XXXX1234 on 05-07-2026 to VPA zomato@ybl Ref 512 Avl Bal Rs.10,000.00",
  { amount: 2499, direction: "debit", party: "zomato@ybl" }
);

// ---------- Fallback amount tightening (no ₹/Rs symbol present) ----------
expectRow(
  "PDF row: amount over date/ref/balance",
  "02 Jul 2026 UPI-SWIGGY-402312 350.00 12000.00",
  { amount: 350 } // not 2 (day), not 2026 (year), not 402312 (ref), not 12000 (balance)
);

expectRow("Phone number is not an amount", "Call 9876543210 for details 250.00 paid", {
  amount: 250,
  direction: "debit",
});

expectRow("Masked account tail is not an amount", "a/c XXXX1234 debited 500 on 03-07-26", {
  amount: 500,
  direction: "debit",
});

expectRow("Year is not an amount", "Annual fee 2026 charged 1,499", {
  amount: 1499,
});

// Lines that genuinely have no amount must be skipped, not fabricated from an id.
(() => {
  const { rows, skipped } = parseGenericText("OTP is 456123 do not share");
  check("OTP line skipped", rows.length === 0 && skipped.length === 1, JSON.stringify(rows));
})();

// ---------- Tabular sanity (CSV/XLSX path) ----------
(() => {
  const { rows } = parseTabularRows([
    { Date: "2026-07-01", Narration: "UPI/Swiggy/Order", Debit: "420.00", Credit: "" },
    { Date: "2026-07-02", Narration: "Salary Acme", Debit: "", Credit: "55000" },
  ]);
  check("CSV debit row", rows[0]?.direction === "debit" && rows[0]?.amount === 420, JSON.stringify(rows[0]));
  check("CSV credit row", rows[1]?.direction === "credit" && rows[1]?.amount === 55000, JSON.stringify(rows[1]));
})();

// ---------- Report ----------
console.log(`\nparser.test.js: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
