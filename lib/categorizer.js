import rules from "../data/categoryRules.json";

/**
 * Pure rule-based categorization — no ML, no API.
 * Scores every category by counting keyword hits in the transaction's
 * description + raw text, picks the highest score, and reports a
 * confidence so low-confidence guesses can be surfaced to the user
 * instead of silently trusted.
 */
export function categorizeTransactions(rows) {
  return rows.map((row) => {
    try {
      const haystack = `${row.description} ${row.raw}`.toLowerCase();
      let best = { category: "Uncategorized", score: 0 };

      for (const [category, keywords] of Object.entries(rules)) {
        let score = 0;
        for (const kw of keywords) {
          if (haystack.includes(kw)) score += 1;
        }
        if (score > best.score) best = { category, score };
      }

      // Income override: credited transactions with no keyword match
      // still get a sane default instead of "Uncategorized".
      if (best.score === 0 && row.direction === "credit") {
        best = { category: "Income", score: 0 };
      }

      const confidence = best.score === 0 ? 0 : Math.min(1, best.score / 2);

      return {
        ...row,
        category: best.category,
        confidence,
      };
    } catch (err) {
      // Never let one bad row break the whole batch.
      return { ...row, category: "Uncategorized", confidence: 0, error: err.message };
    }
  });
}

// De-duplicated so the category dropdown never renders two identical options
// ("Income" is already a key in categoryRules.json). Scoring is unaffected.
export const CATEGORY_LIST = [...new Set([...Object.keys(rules), "Uncategorized", "Income"])];
