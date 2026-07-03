/**
 * Agent state machine.
 *
 * States: IDLE -> READING -> PARSING -> CATEGORIZING -> DONE
 *         any state -> ERROR (recoverable: agent logs the failure and
 *         either skips the offending unit of work or halts, depending
 *         on whether the error is per-row or fatal)
 *
 * The FSM never throws out of run(); every step is wrapped so the caller
 * always gets back a result object plus a full transition log.
 */

export const STATES = {
  IDLE: "IDLE",
  READING: "READING",
  PARSING: "PARSING",
  CATEGORIZING: "CATEGORIZING",
  DONE: "DONE",
  ERROR: "ERROR",
};

/**
 * @param {{
 *   read: () => Promise<string>,
 *   parse: (raw: string) => Array<object>,
 *   categorize: (rows: Array<object>) => Array<object>,
 *   onTransition?: (log: {state: string, message: string, level: 'info'|'warn'|'error', at: number}) => void
 * }} steps
 */
export async function runAgent({ read, parse, categorize, onTransition }) {
  const log = [];
  let state = STATES.IDLE;

  const emit = (nextState, message, level = "info") => {
    state = nextState;
    const entry = { state: nextState, message, level, at: Date.now() };
    log.push(entry);
    if (onTransition) onTransition(entry);
  };

  emit(STATES.IDLE, "Agent initialized.");

  // --- READING ---
  let raw;
  try {
    emit(STATES.READING, "Reading input source...");
    raw = await read();
    if (!raw || !raw.trim()) {
      throw new Error("Input is empty. Nothing to read.");
    }
    emit(STATES.READING, `Read ${raw.length.toLocaleString()} characters.`);
  } catch (err) {
    emit(STATES.ERROR, `Read failed: ${err.message}`, "error");
    return { ok: false, state, log, rows: [] };
  }

  // --- PARSING ---
  let rows;
  try {
    emit(STATES.PARSING, "Extracting transactions...");
    const result = parse(raw);
    rows = result.rows;
    if (result.skipped && result.skipped.length) {
      emit(
        STATES.PARSING,
        `Skipped ${result.skipped.length} unrecognized line(s) — see details below.`,
        "warn"
      );
    }
    if (!rows.length) {
      throw new Error(
        "No transactions could be recognized in this input. Check the format and try again."
      );
    }
    emit(STATES.PARSING, `Extracted ${rows.length} transaction(s).`);
  } catch (err) {
    emit(STATES.ERROR, `Parse failed: ${err.message}`, "error");
    return { ok: false, state, log, rows: [] };
  }

  // --- CATEGORIZING ---
  let categorized;
  try {
    emit(STATES.CATEGORIZING, "Applying category rules...");
    categorized = categorize(rows);
    const uncategorized = categorized.filter((r) => r.category === "Uncategorized").length;
    if (uncategorized > 0) {
      emit(
        STATES.CATEGORIZING,
        `${uncategorized} transaction(s) had no rule match — tagged "Uncategorized".`,
        "warn"
      );
    }
  } catch (err) {
    // Categorization failure is non-fatal: fall back to raw rows, uncategorized.
    emit(
      STATES.CATEGORIZING,
      `Categorizer threw an error (${err.message}) — continuing with rows uncategorized.`,
      "warn"
    );
    categorized = rows.map((r) => ({ ...r, category: "Uncategorized", confidence: 0 }));
  }

  emit(STATES.DONE, `Done. ${categorized.length} transaction(s) ready for review.`);
  return { ok: true, state, log, rows: categorized };
}
