/**
 * All readers run entirely in the browser — no file ever leaves the
 * device, which matters because this is bank/UPI data.
 */

export function readFileAsText(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error("Could not read the file. It may be corrupted."));
    reader.readAsText(file);
  });
}

export function readFileAsArrayBuffer(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error("Could not read the file. It may be corrupted."));
    reader.readAsArrayBuffer(file);
  });
}

/**
 * Reads a CSV/XLSX file and returns an array of plain row objects
 * (first row treated as header).
 */
export async function readSheetRows(file) {
  const XLSX = await import("xlsx");
  const buffer = await readFileAsArrayBuffer(file);
  let workbook;
  try {
    workbook = XLSX.read(buffer, { type: "array" });
  } catch {
    // Swallow the library's internal error text in favour of a friendly one.
    throw new Error("This spreadsheet couldn't be opened — it may be corrupted or an unsupported format.");
  }
  const firstSheetName = workbook.SheetNames[0];
  if (!firstSheetName) throw new Error("The spreadsheet has no sheets.");
  const sheet = workbook.Sheets[firstSheetName];
  const rows = XLSX.utils.sheet_to_json(sheet, { defval: "" });
  if (!rows.length) throw new Error("The spreadsheet appears to be empty.");
  return rows;
}

/**
 * Extracts raw text from a PDF statement using pdf.js, running fully
 * client-side. The worker is self-hosted from /public (copied from the
 * matching pdfjs-dist version) rather than a CDN, so nothing leaves the
 * browser and there's no external request to fail.
 *
 * pdf.js returns individually-positioned text fragments, not lines. We
 * rebuild line breaks by watching each fragment's Y coordinate
 * (transform[5]); a jump means a new row, otherwise fragments on the same
 * row are space-joined. Without this a one-page statement collapses into a
 * single line and only the first transaction is ever parsed.
 */
export async function readPdfText(file) {
  const pdfjsLib = await import("pdfjs-dist/build/pdf");
  pdfjsLib.GlobalWorkerOptions.workerSrc = "/pdf.worker.min.js";

  const buffer = await readFileAsArrayBuffer(file);
  let pdf;
  try {
    pdf = await pdfjsLib.getDocument({ data: buffer }).promise;
  } catch (err) {
    // pdf.js throws typed errors; translate the common ones to plain English.
    const name = err?.name || "";
    if (name === "PasswordException") {
      throw new Error("This PDF is password-protected — remove the password and try again.");
    }
    throw new Error("This PDF couldn't be opened — it may be corrupted or not a valid PDF.");
  }

  let fullText = "";
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const content = await page.getTextContent();

    let pageText = "";
    let lastY = null;
    for (const item of content.items) {
      if (typeof item.str !== "string") continue;
      const y = Array.isArray(item.transform) ? item.transform[5] : null;
      if (lastY !== null && y !== null && Math.abs(y - lastY) > 2) {
        pageText += "\n" + item.str; // new row
      } else {
        pageText += (pageText ? " " : "") + item.str; // same row
      }
      lastY = y;
    }
    fullText += pageText + "\n";
  }

  if (!fullText.trim()) {
    throw new Error(
      "No text could be extracted — this PDF may be a scanned image rather than a text statement."
    );
  }
  return fullText;
}
