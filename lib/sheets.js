/**
 * lib/sheets.js
 * Requires GOOGLE_SERVICE_ACCOUNT_KEY env var — same service account key
 * used for BigQuery. This account must additionally be shared as an
 * Editor on the target Google Sheet.
 */

const { google } = require('googleapis');

const SHEETS_CALL_TIMEOUT_MS = 20000;

// Explicit timeout guard for every Sheets API call — a single hung
// request otherwise silently consumes the entire function timeout with
// no catchable error (a plain try/catch can't catch a promise that
// never resolves or rejects on its own).
function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`Timed out after ${ms}ms: ${label}`)), ms))
  ]);
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
  const authClient = await withTimeout(auth.getClient(), SHEETS_CALL_TIMEOUT_MS, 'auth.getClient');
  return google.sheets({ version: 'v4', auth: authClient });
}

async function ensureSheetExists(sheets, spreadsheetId, title) {
  const meta = await withTimeout(
    sheets.spreadsheets.get({ spreadsheetId, fields: 'sheets.properties' }),
    SHEETS_CALL_TIMEOUT_MS, `ensureSheetExists.get(${title})`
  );
  const existing = meta.data.sheets.find(s => s.properties.title === title);
  if (existing) return existing.properties.sheetId;

  const resp = await withTimeout(
    sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: { requests: [{ addSheet: { properties: { title } } }] }
    }),
    SHEETS_CALL_TIMEOUT_MS, `ensureSheetExists.addSheet(${title})`
  );
  return resp.data.replies[0].addSheet.properties.sheetId;
}

// Full clear + rewrite. Used ONLY by the manual/on-demand full refresh
// now — the daily cron never touches existing rows at all, see
// appendRows() below.
async function writeMatrix(sheets, spreadsheetId, tabName, matrix) {
  await ensureSheetExists(sheets, spreadsheetId, tabName);
  await withTimeout(
    sheets.spreadsheets.values.clear({ spreadsheetId, range: `'${tabName}'!A1:ZZ200000` }),
    SHEETS_CALL_TIMEOUT_MS, `writeMatrix.clear(${tabName})`
  );

  if (!matrix.length) return;

  const maxCols = matrix.reduce((m, r) => Math.max(m, r.length), 0);
  const padded = matrix.map(r => {
    const row = r.slice();
    while (row.length < maxCols) row.push('');
    return row;
  });

  await withTimeout(
    sheets.spreadsheets.values.update({
      spreadsheetId,
      range: `'${tabName}'!A1`,
      valueInputOption: 'USER_ENTERED',
      requestBody: { values: padded }
    }),
    SHEETS_CALL_TIMEOUT_MS * 3,
    `writeMatrix.update(${tabName}, ${matrix.length} rows)`
  );
}

// Pure append — never reads, never clears, never touches any existing
// row. Google Sheets' own append API finds the end of the table for us,
// so this is fast and safe regardless of how large the tab has grown.
// This is the ONLY Sheets write the daily cron does.
async function appendRows(sheets, spreadsheetId, tabName, rows) {
  await ensureSheetExists(sheets, spreadsheetId, tabName);
  if (!rows.length) return;

  const maxCols = rows.reduce((m, r) => Math.max(m, r.length), 0);
  const padded = rows.map(r => {
    const row = r.slice();
    while (row.length < maxCols) row.push('');
    return row;
  });

  await withTimeout(
    sheets.spreadsheets.values.append({
      spreadsheetId,
      range: `'${tabName}'!A1`,
      valueInputOption: 'USER_ENTERED',
      insertDataOption: 'INSERT_ROWS',
      requestBody: { values: padded }
    }),
    SHEETS_CALL_TIMEOUT_MS, `appendRows(${tabName}, ${rows.length} rows)`
  );
}

// The last-date marker lives in reserved cells (M1/N1) within the Raw
// Pull tab itself, NOT a separate tab. Raw Pull already exists (it's the
// whole point of this app), so this avoids ever needing to create a new
// sheet just to store one date — which is what was hanging before.
const META_LABEL_CELL = 'M1';
const META_VALUE_CELL = 'N1';

async function readMetaLastDate(sheets, spreadsheetId, tabName) {
  try {
    const resp = await withTimeout(
      sheets.spreadsheets.values.get({ spreadsheetId, range: `'${tabName}'!${META_VALUE_CELL}` }),
      SHEETS_CALL_TIMEOUT_MS, 'readMetaLastDate'
    );
    const v = resp.data.values && resp.data.values[0] && resp.data.values[0][0];
    return v || null;
  } catch (e) {
    console.log(`[sheets] readMetaLastDate: ${e.message}`);
    return null;
  }
}

async function writeMetaLastDate(sheets, spreadsheetId, tabName, dateStr) {
  await withTimeout(
    sheets.spreadsheets.values.update({
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
