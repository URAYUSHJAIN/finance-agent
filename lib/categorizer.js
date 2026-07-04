import rules from "../data/categoryRules.json";
import { categorizeTransactions as core, categoryList } from "./categorizeCore.js";

/**
 * Pure rule-based categorization — no ML, no API. Thin wrapper that binds the
 * bundled rule table (data/categoryRules.json) to the shared scoring core in
 * categorizeCore.js. The core is kept import-free so the eval harness can run
 * it in plain Node with a disk-loaded copy of the same rules.
 */
export function categorizeTransactions(rows) {
  return core(rows, rules);
}

// De-duplicated so the category dropdown never renders two identical options
// ("Income" is already a key in categoryRules.json). Scoring is unaffected.
export const CATEGORY_LIST = categoryList(rules);
