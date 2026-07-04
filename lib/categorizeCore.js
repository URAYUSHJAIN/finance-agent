/**
 * Pure categorization logic, with the rule table passed in explicitly.
 *
 * Kept free of any static JSON import so it runs unchanged in three places:
 *   - the app (categorizer.js injects the bundled data/categoryRules.json)
 *   - the eval harness (eval.js reads the JSON from disk and injects it)
 *   - any future test
 *
 * Scoring: count how many of a category's keywords appear in the
 * transaction's `description + raw` text; the highest count wins. Confidence
 * is 0 for no match, else min(1, score/2) so a single keyword hit reads as
 * "0.5 — worth a check" and two-plus hits as "confident".
 */
export function categorizeTransactions(rows, ruleTable) {
  return rows.map((row) => {
    try {
      const haystack = `${row.description} ${row.raw}`.toLowerCase();
      let best = { category: "Uncategorized", score: 0 };

      for (const [category, keywords] of Object.entries(ruleTable)) {
        let score = 0;
        for (const kw of keywords) {
          if (haystack.includes(kw)) score += 1;
        }
        if (score > best.score) best = { category, score };
      }

      // Income override: credited transactions with no keyword match still
      // get a sane default instead of "Uncategorized".
      if (best.score === 0 && row.direction === "credit") {
        best = { category: "Income", score: 0 };
      }

      const confidence = best.score === 0 ? 0 : Math.min(1, best.score / 2);
      return { ...row, category: best.category, confidence };
    } catch (err) {
      // Never let one bad row break the whole batch.
      return { ...row, category: "Uncategorized", confidence: 0, error: err.message };
    }
  });
}

/** Category dropdown list — de-duped so "Income" (a rule key) isn't doubled. */
export function categoryList(ruleTable) {
  return [...new Set([...Object.keys(ruleTable), "Uncategorized", "Income"])];
}
