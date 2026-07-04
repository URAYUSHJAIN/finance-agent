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
  // Per-category monthly budget limits { [category]: numberString }. Session
  // only — nothing is persisted.
  const [budgets, setBudgets] = useState({});
  // Table pagination: render this many rows at a time so a 300+ row statement
  // doesn't mount hundreds of <select>s at once. "Load more" bumps it.
  const PAGE_SIZE = 50;
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);
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
      setVisibleCount(PAGE_SIZE);
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
    setBudgets({});
    setVisibleCount(PAGE_SIZE);
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

  // Recurring Spend Ledger: debit merchants that repeat within the statement,
  // plus anything tagged Subscriptions (a subscription recurs even if it shows
  // up once). Treating one statement as ~one month, the group total is its
  // monthly cost — which drives the "what if I cut this" projection.
  const recurring = useMemo(() => {
    if (!rows) return null;
    const groups = {};
    rows.forEach((r) => {
      if (r.direction !== "debit") return;
      const key = (r.description || "").trim().toLowerCase();
      if (!key) return;
      const g = (groups[key] ||= { name: r.description.trim(), category: r.category, count: 0, total: 0 });
      g.count += 1;
      g.total += r.amount;
      if (g.category === "Uncategorized" && r.category !== "Uncategorized") g.category = r.category;
    });
    const list = Object.values(groups)
      .filter((g) => g.count >= 2 || g.category === "Subscriptions")
      .sort((a, b) => b.total - a.total);
    return list.length ? list : null;
  }, [rows]);

  // Two-statement diff: the latest upload vs the one before it, per category.
  const comparison = useMemo(() => {
    if (runs.length < 2) return null;
    const cur = runs[runs.length - 1];
    const prev = runs[runs.length - 2];
    const sumByCat = (rs) => {
      const m = {};
      rs.forEach((r) => {
        if (r.direction !== "debit") return;
        m[r.category] = (m[r.category] || 0) + r.amount;
      });
      return m;
    };
    const c = sumByCat(cur.rows);
    const p = sumByCat(prev.rows);
    const cats = new Set([...Object.keys(c), ...Object.keys(p)]);
    const list = [...cats]
      .map((cat) => ({ cat, cur: c[cat] || 0, prev: p[cat] || 0, delta: (c[cat] || 0) - (p[cat] || 0) }))
      .filter((d) => d.delta !== 0)
      .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));
    return { curLabel: cur.label, prevLabel: prev.label, list };
  }, [runs]);

  function setBudget(cat, value) {
    setBudgets((prev) => ({ ...prev, [cat]: value }));
  }

  // Render the summary (3 stat cards + top categories) to a PNG entirely on a
  // canvas — no server, no library. Handy for screenshotting a monthly recap.
  async function downloadSummaryImage() {
    if (!summary) return;
    try {
      await (document.fonts?.ready || Promise.resolve());
    } catch {
      /* fonts API unavailable — fall back to system fonts */
    }
    const scale = 2;
    const W = 900;
    const H = 560;
    const canvas = document.createElement("canvas");
    canvas.width = W * scale;
    canvas.height = H * scale;
    const ctx = canvas.getContext("2d");
    ctx.scale(scale, scale);

    const COL = {
      bg: "#0e1113",
      panel: "#171b1e",
      border: "#2a3034",
      text: "#ececE7",
      muted: "#8b9298",
      gold: "#c9a24b",
      debit: "#cd645b",
      credit: "#5e9c76",
    };
    // next/font self-hosts under hashed family names — read them off the CSS
    // variables so the canvas uses the real Ubuntu faces (falling back cleanly
    // if for some reason they aren't loaded).
    const rootStyle = getComputedStyle(document.documentElement);
    const monoVar = rootStyle.getPropertyValue("--font-ubuntu-mono").trim();
    const sansVar = rootStyle.getPropertyValue("--font-ubuntu").trim();
    const mono = `${monoVar ? monoVar + ", " : ""}"Ubuntu Mono", monospace`;
    const sans = `${sansVar ? sansVar + ", " : ""}"Ubuntu", sans-serif`;
    const rupee = (n) => "₹" + Math.round(n).toLocaleString("en-IN");

    const roundRect = (x, y, w, h, r) => {
      ctx.beginPath();
      ctx.moveTo(x + r, y);
      ctx.arcTo(x + w, y, x + w, y + h, r);
      ctx.arcTo(x + w, y + h, x, y + h, r);
      ctx.arcTo(x, y + h, x, y, r);
      ctx.arcTo(x, y, x + w, y, r);
      ctx.closePath();
    };

    // background
    ctx.fillStyle = COL.bg;
    ctx.fillRect(0, 0, W, H);
    const grad = ctx.createLinearGradient(0, 0, 0, 180);
    grad.addColorStop(0, "rgba(201,162,75,0.10)");
    grad.addColorStop(1, "rgba(201,162,75,0)");
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, W, 180);

    // header
    ctx.fillStyle = COL.gold;
    ctx.font = `500 13px ${mono}`;
    ctx.fillText("RULE-BASED · NO AI API · RUNS IN YOUR BROWSER", 40, 52);
    ctx.fillStyle = COL.text;
    ctx.font = `700 30px ${sans}`;
    ctx.fillText("Finance Summary", 40, 92);

    // stat cards
    const cards = [
      { label: "TOTAL SPENT", value: rupee(summary.debit), color: COL.debit },
      { label: "TOTAL RECEIVED", value: rupee(summary.credit), color: COL.credit },
      { label: "NET", value: (summary.net >= 0 ? "+" : "-") + rupee(Math.abs(summary.net)), color: summary.net >= 0 ? COL.credit : COL.debit },
    ];
    const cardW = (W - 80 - 24) / 3;
    cards.forEach((c, i) => {
      const x = 40 + i * (cardW + 12);
      const y = 120;
      ctx.fillStyle = COL.panel;
      roundRect(x, y, cardW, 96, 10);
      ctx.fill();
      ctx.strokeStyle = COL.border;
      ctx.lineWidth = 1;
      roundRect(x, y, cardW, 96, 10);
      ctx.stroke();
      ctx.fillStyle = COL.muted;
      ctx.font = `400 11px ${mono}`;
      ctx.fillText(c.label, x + 18, y + 32);
      ctx.fillStyle = c.color;
      ctx.font = `500 26px ${mono}`;
      ctx.fillText(c.value, x + 18, y + 68);
    });

    // top categories
    ctx.fillStyle = COL.muted;
    ctx.font = `400 11px ${mono}`;
    ctx.fillText("TOP SPENDING CATEGORIES", 40, 262);
    const bars = summary.topCategories.slice(0, 6);
    const maxCat = summary.maxCat || 1;
    bars.forEach(([cat, amt], i) => {
      const y = 288 + i * 38;
      ctx.fillStyle = COL.text;
      ctx.font = `400 13px ${sans}`;
      ctx.fillText(cat, 40, y + 14);
      const trackX = 240;
      const trackW = W - trackX - 140;
      ctx.fillStyle = COL.panel;
      roundRect(trackX, y + 4, trackW, 12, 6);
      ctx.fill();
      ctx.fillStyle = COL.gold;
      const fillW = Math.max(6, (amt / maxCat) * trackW);
      roundRect(trackX, y + 4, fillW, 12, 6);
      ctx.fill();
      ctx.fillStyle = COL.muted;
      ctx.font = `400 13px ${mono}`;
      ctx.textAlign = "right";
      ctx.fillText(rupee(amt), W - 40, y + 15);
      ctx.textAlign = "left";
    });

    // footer
    ctx.fillStyle = COL.border;
    ctx.fillRect(40, H - 46, W - 80, 1);
    ctx.fillStyle = COL.muted;
    ctx.font = `400 11px ${mono}`;
    ctx.fillText("Generated by Finance Categorizer Agent · runs in your browser", 40, H - 24);

    const blob = await new Promise((res) => canvas.toBlob(res, "image/png"));
    if (!blob) return;
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "finance-summary.png";
    a.click();
    URL.revokeObjectURL(url);
  }

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
              role="button"
              tabIndex={0}
              aria-label={
                tab === "sheet"
                  ? "Upload a CSV or XLSX file — click or press Enter to browse"
                  : "Upload a PDF statement — click or press Enter to browse"
              }
              onClick={() => fileInputRef.current?.click()}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  fileInputRef.current?.click();
                }
              }}
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
          {rows && (
            <button className="btn" onClick={downloadSummaryImage} title="Render your summary as a shareable PNG">
              Download summary image
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
              <p className="section-cap">
                Where most of your money went. Set a monthly limit and the bar turns red when you go over.
              </p>
              {summary.topCategories.map(([cat, amt]) => {
                const limit = parseFloat(budgets[cat]);
                const hasLimit = Number.isFinite(limit) && limit > 0;
                const over = hasLimit && amt > limit;
                return (
                  <div className="cat-row" key={cat}>
                    <div className="bar-row budgeted">
                      <span>{cat}</span>
                      <div className="bar-track">
                        <div
                          className="bar-fill"
                          style={{
                            width: `${Math.min(100, (amt / summary.maxCat) * 100)}%`,
                            background: over ? "var(--debit)" : "var(--gold)",
                          }}
                        />
                      </div>
                      <span className={`bar-amount ${over ? "over" : ""}`}>₹{amt.toLocaleString("en-IN")}</span>
                      <span className="budget-field">
                        <span className="budget-cur">₹</span>
                        <input
                          type="number"
                          inputMode="numeric"
                          min="0"
                          className="budget-input"
                          placeholder="limit"
                          aria-label={`Monthly budget limit for ${cat}`}
                          value={budgets[cat] ?? ""}
                          onChange={(e) => setBudget(cat, e.target.value)}
                        />
                      </span>
                    </div>
                    {over && (
                      <div className="budget-warn" role="status">
                        ⚠ Over your ₹{limit.toLocaleString("en-IN")} limit by ₹
                        {(amt - limit).toLocaleString("en-IN")}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}

          {recurring && (
            <div className="panel bars">
              <h2 className="summary-label as-heading">Recurring spend ledger</h2>
              <p className="section-cap">
                Merchants you paid more than once (and subscriptions). The “cut in half” note shows what you'd
                save if you halved each one.
              </p>
              {recurring.map((g) => {
                const halfMonth = g.total / 2;
                return (
                  <div className="ledger-row" key={g.name}>
                    <div className="ledger-main">
                      <span className="ledger-name">{g.name}</span>
                      <span className="ledger-meta">
                        {g.category} · ×{g.count}
                      </span>
                    </div>
                    <div className="ledger-figures">
                      <span className="ledger-amount">₹{g.total.toLocaleString("en-IN")}/mo</span>
                      <span className="ledger-whatif">
                        Cut in half → save ₹{Math.round(halfMonth).toLocaleString("en-IN")}/mo · ₹
                        {Math.round(halfMonth * 12).toLocaleString("en-IN")}/yr
                      </span>
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          {comparison && comparison.list.length > 0 && (
            <div className="panel bars">
              <h2 className="summary-label as-heading">Vs your last upload</h2>
              <p className="section-cap">
                How this statement ({comparison.curLabel}) compares to the previous one ({comparison.prevLabel}),
                per category.
              </p>
              {comparison.list.map((d) => {
                const up = d.delta > 0;
                return (
                  <div className="compare-row" key={d.cat}>
                    <span className="compare-cat">{d.cat}</span>
                    <span className="compare-prev">₹{d.prev.toLocaleString("en-IN")}</span>
                    <span className="compare-arrow">→</span>
                    <span className="compare-cur">₹{d.cur.toLocaleString("en-IN")}</span>
                    <span className={`compare-delta ${up ? "up" : "down"}`}>
                      {up ? "▲" : "▼"} ₹{Math.abs(d.delta).toLocaleString("en-IN")}
                    </span>
                  </div>
                );
              })}
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
              onClick={() => {
                setOnlyLowConf((v) => !v);
                setVisibleCount(PAGE_SIZE);
              }}
              disabled={lowConfCount === 0}
              title="Show only rows the agent couldn't confidently categorize"
            >
              Needs review{lowConfCount > 0 ? ` · ${lowConfCount}` : ""}
            </button>
            <button
              className={`chip ${reviewLowFirst ? "active" : ""}`}
              onClick={() => {
                setReviewLowFirst((v) => !v);
                setVisibleCount(PAGE_SIZE);
              }}
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
                {displayRows.slice(0, visibleCount).map(({ r, idx }) => (
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

          {displayRows.length > visibleCount && (
            <div className="load-more-row">
              <span className="load-more-count">
                Showing {visibleCount} of {displayRows.length}
              </span>
              <button
                className="btn"
                onClick={() => setVisibleCount((n) => Math.min(n + PAGE_SIZE, displayRows.length))}
              >
                Load {Math.min(PAGE_SIZE, displayRows.length - visibleCount)} more
              </button>
            </div>
          )}
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
