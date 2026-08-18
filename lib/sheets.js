/**
 * lib/sheets.js
 * Requires GOOGLE_SERVICE_ACCOUNT_KEY env var — same service account key
 * used for BigQuery. This account must additionally be shared as an
 * Editor on the target Google Sheet.
 *
 * RELIABILITY NOTE (2026-08-15): Sheets API calls from this environment
 * have intermittently hung outright (no response, no error) on at least
 * two different call types so far — creating a new sheet, and a plain
 * single-cell read. Neither is inherently slow, so this looks like a
 * transient issue rather than something tied to one specific call.
 * Every call now goes through withRetry(), which wraps the existing
 * timeout guard with a couple of retry attempts before actually giving
 * up — a hang on attempt 1 no longer forces the (slower/safer but not
 * ideal) fallback path if a retry would have gone through fine.
 */

const { google } = require('googleapis');

const SHEETS_CALL_TIMEOUT_MS = 20000;
const DEFAULT_RETRIES = 2; // total attempts = 1 + this

// This specific read (readMetaLastDate) has failed consistently across
// two different API methods and multiple retry attempts — retries have
// proven not to help for this particular call. Rather than keep paying
// ~67s of wasted retry time every single cron run for a call that
// reliably doesn't work, this one uses a short timeout and NO retries —
// fail fast, fall back immediately, and this can be revisited if the
// underlying cause is ever identified.
const META_READ_TIMEOUT_MS = 8000;
const META_READ_RETRIES = 0;

// `factory` must be a FUNCTION that returns a fresh promise each call —
// a hung promise can't be "retried," the underlying request has to be
// re-issued from scratch on each attempt.
//
// BACKOFF: the 2026-08-15 incident showed all 3 attempts failing with the
// IDENTICAL timeout, back to back, no variation — that pattern looks more
// like hitting a Google API rate limit/quota than a random network blip
// (plausible here, given how many test calls have hit this same service
// account in rapid succession). Retrying instantly just re-hits the same
// throttle window, so each retry now waits a bit first (2s, then 5s).
const RETRY_BACKOFF_MS = [2000, 5000];

async function withRetry(factory, ms, label, retries = DEFAULT_RETRIES) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await Promise.race([
        factory(),
        new Promise((_, reject) => setTimeout(() => reject(new Error(`Timed out after ${ms}ms: ${label}`)), ms))
      ]);
    } catch (e) {
      lastErr = e;
      if (attempt < retries) {
        const backoff = RETRY_BACKOFF_MS[attempt] || 5000;
        console.log(`[sheets] ${label} attempt ${attempt + 1} failed (${e.message}) — retrying in ${backoff}ms`);
        await new Promise(r => setTimeout(r, backoff));
      }
    }
  }
  throw lastErr;
}

function getCredentials() {
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_KEY;
  if (!raw) throw new Error('Missing GOOGLE_SERVICE_ACCOUNT_KEY env var');
  return JSON.parse(raw);
}

async function getSheetsClient() {
  const auth = new google.auth.GoogleAuth({
    credentials: getCredentials(),
    scopes: ['https://www.googleapis.com/auth/spreadsheets']
  });
  const authClient = await withRetry(() => auth.getClient(), SHEETS_CALL_TIMEOUT_MS, 'auth.getClient');
  return google.sheets({ version: 'v4', auth: authClient });
}

async function ensureSheetExists(sheets, spreadsheetId, title) {
  const meta = await withRetry(
    () => sheets.spreadsheets.get({ spreadsheetId, fields: 'sheets.properties' }),
    SHEETS_CALL_TIMEOUT_MS, `ensureSheetExists.get(${title})`
  );
  const existing = meta.data.sheets.find(s => s.properties.title === title);
  if (existing) return existing.properties.sheetId;

  const resp = await withRetry(
    () => sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: { requests: [{ addSheet: { properties: { title } } }] }
    }),
    SHEETS_CALL_TIMEOUT_MS, `ensureSheetExists.addSheet(${title})`
  );
  return resp.data.replies[0].addSheet.properties.sheetId;
}

// Full clear + rewrite. Used ONLY by the manual/on-demand full refresh —
// the daily cron never touches existing rows, see appendRows() below.
async function writeMatrix(sheets, spreadsheetId, tabName, matrix) {
  await ensureSheetExists(sheets, spreadsheetId, tabName);
  await withRetry(
    () => sheets.spreadsheets.values.clear({ spreadsheetId, range: `'${tabName}'!A1:ZZ200000` }),
    SHEETS_CALL_TIMEOUT_MS, `writeMatrix.clear(${tabName})`
  );

  if (!matrix.length) return;

  const maxCols = matrix.reduce((m, r) => Math.max(m, r.length), 0);
  const padded = matrix.map(r => {
    const row = r.slice();
    while (row.length < maxCols) row.push('');
    return row;
  });

  await withRetry(
    () => sheets.spreadsheets.values.update({
      spreadsheetId,
      range: `'${tabName}'!A1`,
      valueInputOption: 'USER_ENTERED',
      requestBody: { values: padded }
    }),
    SHEETS_CALL_TIMEOUT_MS * 3, `writeMatrix.update(${tabName}, ${matrix.length} rows)`
  );
}

// Pure append — never reads, never clears, never touches any existing
// row. This is the ONLY Sheets write the daily cron does.
async function appendRows(sheets, spreadsheetId, tabName, rows) {
  await ensureSheetExists(sheets, spreadsheetId, tabName);
  if (!rows.length) return;

  const maxCols = rows.reduce((m, r) => Math.max(m, r.length), 0);
  const padded = rows.map(r => {
    const row = r.slice();
    while (row.length < maxCols) row.push('');
    return row;
  });

  await withRetry(
    () => sheets.spreadsheets.values.append({
      spreadsheetId,
      range: `'${tabName}'!A1`,
      valueInputOption: 'USER_ENTERED',
      insertDataOption: 'INSERT_ROWS',
      requestBody: { values: padded }
    }),
    SHEETS_CALL_TIMEOUT_MS, `appendRows(${tabName}, ${rows.length} rows)`
  );
}

// Last-date marker lives in reserved cells (M1/N1) within the Raw Pull
// tab itself, not a separate tab.
const META_LABEL_CELL = 'M1';
const META_VALUE_CELL = 'N1';

// Uses spreadsheets.get (with a targeted range + fields) rather than
// spreadsheets.values.get — the latter has repeatedly, reproducibly
// hung on this exact single-cell read even when a valid value was
// genuinely present, while spreadsheets.get (already used elsewhere in
// this file, in ensureSheetExists) has been reliable every time. Same
// underlying data, different API surface, sidestepping whatever's wrong
// with the values.get path specifically.
async function readMetaLastDate(sheets, spreadsheetId, tabName) {
  try {
    const resp = await withRetry(
      () => sheets.spreadsheets.get({
        spreadsheetId,
        ranges: [`'${tabName}'!${META_VALUE_CELL}`],
        fields: 'sheets.data.rowData.values.formattedValue'
      }),
      META_READ_TIMEOUT_MS, 'readMetaLastDate', META_READ_RETRIES
    );
    const sheetsData = resp.data.sheets;
    const v = sheetsData && sheetsData[0] && sheetsData[0].data && sheetsData[0].data[0]
      && sheetsData[0].data[0].rowData && sheetsData[0].data[0].rowData[0]
      && sheetsData[0].data[0].rowData[0].values && sheetsData[0].data[0].rowData[0].values[0]
      && sheetsData[0].data[0].rowData[0].values[0].formattedValue;
    return v || null;
  } catch (e) {
    console.log(`[sheets] readMetaLastDate: ${e.message}`);
    return null;
  }
}

async function writeMetaLastDate(sheets, spreadsheetId, tabName, dateStr) {
  await withRetry(
    () => sheets.spreadsheets.values.update({
      spreadsheetId,
      range: `'${tabName}'!${META_LABEL_CELL}`,
      valueInputOption: 'USER_ENTERED',
      requestBody: { values: [['LastDatePulled', dateStr]] }
    }),
    SHEETS_CALL_TIMEOUT_MS, 'writeMetaLastDate'
  );
}

module.exports = {
  getSheetsClient, ensureSheetExists, writeMatrix, appendRows,
  readMetaLastDate, writeMetaLastDate
};
