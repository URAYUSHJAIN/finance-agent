"use client";

import { useState, useRef, useMemo } from "react";
import { runAgent, STATES } from "../lib/fsm";
import { parseGenericText, parseTabularRows, toMonthKey } from "../lib/parser";
import { categorizeTransactions, CATEGORY_LIST } from "../lib/categorizer";
import { readSheetRows, readPdfText } from "../lib/fileReaders";

const TABS = [
  { id: "paste", label: "Paste text" },
  { id: "sheet", label: "CSV / XLSX" },
  { id: "pdf", label: "PDF statement" },
];

const MAX_FILE_MB = 8;
const ACCEPTED_EXT = {
  sheet: [".csv", ".xlsx", ".xls"],
  pdf: [".pdf"],
};

export default function Home() {
  const [tab, setTab] = useState("paste");
  const [pastedText, setPastedText] = useState("");
  const [file, setFile] = useState(null);
  const [fileError, setFileError] = useState(null);
  const [log, setLog] = useState([]);
  // Every completed run is kept in-memory (not persisted) so multiple
  // statements uploaded in one session can be compared month-over-month.
  const [runs, setRuns] = useState([]);
  const [running, setRunning] = useState(false);
  const [fatalError, setFatalError] = useState(null);
  const [reviewLowFirst, setReviewLowFirst] = useState(false);
  const [onlyLowConf, setOnlyLowConf] = useState(false);
  // Agent log is collapsed by default so the empty state stays a single clean
  // screen; the user can expand it to watch the FSM transitions.
  const [logOpen, setLogOpen] = useState(false);
  const fileInputRef = useRef(null);

  // The active result shown in the table/summary is always the latest run.
  const rows = useMemo(() => (runs.length ? runs[runs.length - 1].rows : null), [runs]);

  const canRun = tab === "paste" ? pastedText.trim().length > 0 : !!file;

  /** Cheap, friendly pre-flight validation. Returns an error string or null. */
  function validateInput() {
    if (tab === "paste") {
      const text = pastedText.trim();
      if (!text) return "Paste at least one transaction line first.";
      if (!/\d/.test(text)) return "No amounts detected — each line needs a number, e.g. “Paid ₹350 to Swiggy”.";
      return null;
    }
    if (!file) return "Choose a file first.";
    return null;
  }

  function chooseFile(f) {
    setFatalError(null);
    if (!f) {
      setFile(null);
      setFileError(null);
      return;
    }
    const name = f.name.toLowerCase();
    const okExt = ACCEPTED_EXT[tab].some((ext) => name.endsWith(ext));
    if (!okExt) {
      setFile(null);
      setFileError(`That doesn't look like a ${ACCEPTED_EXT[tab].join(" / ")} file.`);
      return;
    }
    if (f.size > MAX_FILE_MB * 1024 * 1024) {
      setFile(null);
      setFileError(`File is larger than ${MAX_FILE_MB} MB — try a smaller export.`);
      return;
    }
    setFileError(null);
    setFile(f);
  }

  async function handleRun() {
    const problem = validateInput();
    if (problem) {
      setFatalError(problem);
      return;
    }

    setRunning(true);
    setLog([]);
    setFatalError(null);

    const read = async () => {
      if (tab === "paste") return pastedText;
      if (!file) throw new Error("No file selected.");
      if (tab === "pdf") return readPdfText(file);
      // sheet mode reads structured rows, marshalled through JSON so
      // the FSM's generic `raw` contract still holds
      const sheetRows = await readSheetRows(file);
      return JSON.stringify({ __sheet: true, rows: sheetRows });
    };

    const parse = (raw) => {
      try {
        const asObj = JSON.parse(raw);
        if (asObj && asObj.__sheet) {
          return parseTabularRows(asObj.rows);
        }
      } catch {
        // not JSON => plain text, fall through
      }
      return parseGenericText(raw);
    };

    const categorize = (parsedRows) => categorizeTransactions(parsedRows);

    const result = await runAgent({
      read,
      parse,
      categorize,
      onTransition: (entry) => setLog((prev) => [...prev, entry]),
    });

    if (result.ok) {
      const label = tab === "paste" ? `Pasted text #${runs.length + 1}` : file.name;
      setRuns((prev) => [...prev, { id: Date.now(), label, rows: result.rows }]);
    } else {
      setFatalError(result.log[result.log.length - 1]?.message || "Agent failed.");
    }
    setRunning(false);
  }

  function updateCategory(idx, newCategory) {
    // Edits apply to the active (latest) run; confidence jumps to 100% since
    // it's now a human decision, dropping the row out of the review filter.
    setRuns((prev) =>
      prev.map((run, ri) =>
        ri === prev.length - 1
          ? {
              ...run,
              rows: run.rows.map((r, i) => (i === idx ? { ...r, category: newCategory, confidence: 1 } : r)),
            }
          : run
      )
    );
  }

  function clearSession() {
    setRuns([]);
    setLog([]);
    setFatalError(null);
    setReviewLowFirst(false);
    setOnlyLowConf(false);
  }

  function exportCsv() {
    if (!rows) return;
    const header = "Date,Description,Amount,Direction,Category\n";
    const body = rows
      .map((r) => `"${r.date}","${r.description.replace(/"/g, '""')}",${r.amount},${r.direction},"${r.category}"`)
      .join("\n");
    const blob = new Blob([header + body], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "categorized-transactions.csv";
    a.click();
    URL.revokeObjectURL(url);
  }

  const summary = useMemo(() => {
    if (!rows) return null;
    const debit = rows.filter((r) => r.direction === "debit").reduce((s, r) => s + r.amount, 0);
    const credit = rows.filter((r) => r.direction === "credit").reduce((s, r) => s + r.amount, 0);
    const byCategory = {};
    rows.forEach((r) => {
      if (r.direction !== "debit") return;
      byCategory[r.category] = (byCategory[r.category] || 0) + r.amount;
    });
    const topCategories = Object.entries(byCategory)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 6);
    const maxCat = topCategories[0]?.[1] || 1;
    return { debit, credit, net: credit - debit, topCategories, maxCat };
  }, [rows]);

  const lowConfCount = useMemo(() => (rows ? rows.filter((r) => r.confidence === 0).length : 0), [rows]);

  // Display rows carry their original index so sort/filter never break edits.
  const displayRows = useMemo(() => {
    if (!rows) return [];
    let list = rows.map((r, idx) => ({ r, idx }));
    if (onlyLowConf) list = list.filter(({ r }) => r.confidence === 0);
    if (reviewLowFirst) list = [...list].sort((a, b) => a.r.confidence - b.r.confidence);
    return list;
  }, [rows, onlyLowConf, reviewLowFirst]);

  // Month-over-month roll-up across every statement uploaded this session.
  const monthly = useMemo(() => {
    if (runs.length < 2) return null;
    const byMonth = {};
    runs
      .flatMap((run) => run.rows)
      .forEach((r) => {
        if (r.direction !== "debit") return;
        const mk = toMonthKey(r.date);
        if (!mk) return;
        const bucket = (byMonth[mk.key] ||= { label: mk.label, byCat: {}, total: 0 });
        bucket.byCat[r.category] = (bucket.byCat[r.category] || 0) + r.amount;
        bucket.total += r.amount;
      });
    const months = Object.entries(byMonth)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, m]) => {
        const cats = Object.entries(m.byCat).sort((a, b) => b[1] - a[1]);
        return { key, label: m.label, total: m.total, cats, maxCat: cats[0]?.[1] || 1 };
      });
    return months.length ? months : null;
  }, [runs]);

  return (
    <main className="shell">
      <header className="header">
        <div className="eyebrow">rule-based · no ai api · runs in your browser</div>
        <h1 className="title">Finance Categorizer Agent</h1>
        <p className="subtitle">
          Paste a UPI statement, drop a CSV/XLSX export, or upload a PDF. The agent parses,
          categorizes, and totals every transaction using plain regex and keyword rules —
          nothing is uploaded anywhere.
        </p>
      </header>

      <div className="tabs" role="tablist">
        {TABS.map((t) => (
          <button
            key={t.id}
            role="tab"
            aria-selected={tab === t.id}
            className={`tab ${tab === t.id ? "active" : ""}`}
            onClick={() => {
              setTab(t.id);
              setFile(null);
              setFileError(null);
              setFatalError(null);
            }}
          >
            {t.label}
          </button>
        ))}
      </div>

      <section className="panel">
        {tab === "paste" && (
          <textarea
            className="textarea"
            placeholder={`Paste transaction lines here, e.g.\nPaid ₹350 to Swiggy on 2 Jul 2026\nReceived ₹500 from Papa on 1 Jul 2026`}
            value={pastedText}
            onChange={(e) => setPastedText(e.target.value)}
          />
        )}

        {(tab === "sheet" || tab === "pdf") && (
          <div>
            <div
              className="dropzone"
              onClick={() => fileInputRef.current?.click()}
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => {
                e.preventDefault();
                if (e.dataTransfer.files?.[0]) chooseFile(e.dataTransfer.files[0]);
              }}
            >
              {file ? (
                <span>Selected: <strong>{file.name}</strong></span>
              ) : tab === "sheet" ? (
                <span>Click or drag a .csv / .xlsx file here</span>
              ) : (
                <span>Click or drag a .pdf statement here</span>
              )}
            </div>
            <input
              ref={fileInputRef}
              type="file"
              className="file-input"
              accept={tab === "sheet" ? ".csv,.xlsx,.xls" : ".pdf"}
              onChange={(e) => chooseFile(e.target.files?.[0] || null)}
            />
            {fileError && <div className="field-hint warn">{fileError}</div>}
          </div>
        )}

        {runs.length === 0 && !running && (
          <div className="panel-hint">
            <h2 className="panel-hint-title">How this works</h2>
            <div className="steps">
              <div className="step">
                <span className="step-num">1</span>
                <div>
                  <div className="step-title">Upload</div>
                  <div className="step-sub">Paste your UPI/SMS lines, or drop a bank CSV, XLSX, or PDF export.</div>
                </div>
              </div>
              <div className="step">
                <span className="step-num">2</span>
                <div>
                  <div className="step-title">Agent reads &amp; sorts it</div>
                  <div className="step-sub">It pulls out each amount, date, and payee, then tags a category — all in this tab.</div>
                </div>
              </div>
              <div className="step">
                <span className="step-num">3</span>
                <div>
                  <div className="step-title">Review &amp; export</div>
                  <div className="step-sub">Fix anything it wasn't sure about, then download a clean CSV.</div>
                </div>
              </div>
            </div>
            <div className="panel-hint-foot">
              🔒 Nothing leaves your browser. Upload more than one statement to compare months.
            </div>
          </div>
        )}

        <div className="btn-row">
          <button className="btn btn-primary" disabled={!canRun || running} onClick={handleRun}>
            {running ? "Running agent…" : runs.length ? "Run another" : "Run agent"}
          </button>
          {rows && (
            <button className="btn" onClick={exportCsv}>
              Export CSV
            </button>
          )}
          {runs.length > 0 && (
            <button className="btn" onClick={clearSession} title="Forget every statement from this session">
              Clear session
            </button>
          )}
          {runs.length > 0 && (
            <span className="session-count">
              {runs.length} statement{runs.length > 1 ? "s" : ""} this session
            </span>
          )}
        </div>

        {log.length > 0 && (
          <div className="log-wrap">
            <button
              className="log-toggle"
              onClick={() => setLogOpen((v) => !v)}
              aria-expanded={logOpen}
            >
              <span className="log-toggle-caret">{logOpen ? "▾" : "▸"}</span>
              Agent log
              <span className="log-toggle-meta">
                {logOpen ? `${log.length} steps` : log[log.length - 1]?.message || `${log.length} steps`}
              </span>
            </button>
            {logOpen && (
              <div className="log-panel log-scroll">
                {log.map((entry, i) => (
                  <div key={i} className={`log-line ${entry.level}`}>
                    <span className="log-state">[{entry.state}]</span>
                    <span>{entry.message}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {fatalError && <div className="error-banner">Agent stopped: {fatalError}</div>}
      </section>

      {summary && (
        <>
          <div className="section-head">
            <h2 className="section-title">At a glance</h2>
            <p className="section-cap">Your totals for this statement — money out, money in, and what's left.</p>
          </div>
          <div className="summary-grid">
            <div className="summary-card">
              <div className="summary-label">Total spent</div>
              <div className="summary-value debit">₹{summary.debit.toLocaleString("en-IN")}</div>
            </div>
            <div className="summary-card">
              <div className="summary-label">Total received</div>
              <div className="summary-value credit">₹{summary.credit.toLocaleString("en-IN")}</div>
            </div>
            <div className="summary-card">
              <div className="summary-label">Net</div>
              <div className={`summary-value ${summary.net >= 0 ? "credit" : "debit"}`}>
                {summary.net >= 0 ? "+" : "-"}₹{Math.abs(summary.net).toLocaleString("en-IN")}
              </div>
            </div>
          </div>

          {summary.topCategories.length > 0 && (
            <div className="panel bars">
              <h2 className="summary-label as-heading">Top spending categories</h2>
              <p className="section-cap">Where most of your money went, ranked highest to lowest.</p>
              {summary.topCategories.map(([cat, amt]) => (
                <div className="bar-row" key={cat}>
                  <span>{cat}</span>
                  <div className="bar-track">
                    <div className="bar-fill" style={{ width: `${(amt / summary.maxCat) * 100}%` }} />
                  </div>
                  <span className="bar-amount">₹{amt.toLocaleString("en-IN")}</span>
                </div>
              ))}
            </div>
          )}

          {monthly && (
            <div className="panel bars">
              <h2 className="summary-label as-heading">Month-over-month spend</h2>
              <p className="section-cap">
                How your spending compares across months, combined from all {runs.length} statements this session.
              </p>
              {monthly.map((m) => (
                <div className="month-block" key={m.key}>
                  <div className="month-head">
                    <span className="month-name">{m.label}</span>
                    <span className="bar-amount">₹{m.total.toLocaleString("en-IN")}</span>
                  </div>
                  {m.cats.map(([cat, amt]) => (
                    <div className="bar-row" key={cat}>
                      <span>{cat}</span>
                      <div className="bar-track">
                        <div className="bar-fill" style={{ width: `${(amt / m.maxCat) * 100}%` }} />
                      </div>
                      <span className="bar-amount">₹{amt.toLocaleString("en-IN")}</span>
                    </div>
                  ))}
                </div>
              ))}
            </div>
          )}

          <div className="section-head">
            <h2 className="section-title">Your transactions</h2>
            <p className="section-cap">
              Every transaction the agent found. Fix any category with the dropdown — your change saves instantly.
            </p>
          </div>

          <div className="dot-legend" aria-hidden="true">
            <span className="legend-item">
              <span className="confidence-dot" style={{ background: "var(--credit)" }} /> Confident match
            </span>
            <span className="legend-item">
              <span className="confidence-dot" style={{ background: "var(--warn)" }} /> Low confidence
            </span>
            <span className="legend-item">
              <span className="confidence-dot" style={{ background: "var(--debit)" }} /> No rule matched — please check
            </span>
          </div>

          <div className="filter-row">
            <button
              className={`chip ${onlyLowConf ? "active" : ""}`}
              onClick={() => setOnlyLowConf((v) => !v)}
              disabled={lowConfCount === 0}
              title="Show only rows the agent couldn't confidently categorize"
            >
              Needs review{lowConfCount > 0 ? ` · ${lowConfCount}` : ""}
            </button>
            <button
              className={`chip ${reviewLowFirst ? "active" : ""}`}
              onClick={() => setReviewLowFirst((v) => !v)}
              title="Sort lowest-confidence rows to the top"
            >
              Low-confidence first
            </button>
            {onlyLowConf && lowConfCount === 0 && (
              <span className="field-hint">All rows reviewed — nothing left to check.</span>
            )}
          </div>

          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Description</th>
                  <th>Amount</th>
                  <th>Category</th>
                </tr>
              </thead>
              <tbody>
                {displayRows.map(({ r, idx }) => (
                  <tr key={idx} className={r.confidence === 0 ? "needs-review" : ""}>
                    <td data-label="Date">{r.date}</td>
                    <td data-label="Description">{r.description}</td>
                    <td data-label="Amount" className={`amount-cell ${r.direction}`}>
                      {r.direction === "debit" ? "-" : r.direction === "credit" ? "+" : ""}₹
                      {r.amount.toLocaleString("en-IN")}
                    </td>
                    <td data-label="Category">
                      <span
                        className="confidence-dot"
                        style={{
                          background:
                            r.confidence >= 0.5 ? "var(--credit)" : r.confidence > 0 ? "var(--warn)" : "var(--debit)",
                        }}
                        title={
                          r.confidence >= 0.5
                            ? "Confident match — the agent is sure about this category."
                            : r.confidence > 0
                            ? "Low confidence — worth a quick check."
                            : "No rule matched — please pick the right category."
                        }
                      />
                      <select
                        className="category-select"
                        value={r.category}
                        onChange={(e) => updateCategory(idx, e.target.value)}
                      >
                        {CATEGORY_LIST.map((c) => (
                          <option key={c} value={c}>
                            {c}
                          </option>
                        ))}
                      </select>
                    </td>
                  </tr>
                ))}
                {displayRows.length === 0 && (
                  <tr>
                    <td colSpan={4} className="empty-cell">
                      No rows match this filter.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </>
      )}

      <p className="footer-note">
        Everything above runs client-side in your browser — parsing, categorization, and totals
        never touch a server. Rules live in <code>data/categoryRules.json</code>; edit that file
        to teach the agent new merchants or categories.
      </p>

      <footer className="site-footer">
        Built by{" "}
        <a
          href="https://www.linkedin.com/in/URAYUSHJAIN"
          target="_blank"
          rel="noopener noreferrer"
        >
          Ayush Jain
        </a>
      </footer>
    </main>
  );
}
