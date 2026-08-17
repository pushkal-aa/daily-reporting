/**
 * lib/sheets.js
 * Requires GOOGLE_SERVICE_ACCOUNT_KEY env var — same service account key
 * used for BigQuery. This account must additionally be shared as an
 * Editor on the target Google Sheet.
 */

const { google } = require('googleapis');

const META_SHEET = 'Raw Pull Meta';
const SHEETS_CALL_TIMEOUT_MS = 20000; // 20s — generous for any single Sheets API call

// Explicit timeout guard for every Sheets API call. Without this, a
// single hung request (root cause suspected: internal retry/backoff
// logic inside the googleapis client on an error we can't otherwise
// see) can silently consume the ENTIRE function timeout with no
// catchable error and no log line — exactly what happened on 2026-08-13,
// where readMetaRowCount() never resolved, never rejected, and the
// function just sat there for 5 minutes until Vercel force-killed it.
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

// Reads back ALL existing data rows (excludes header). Only used as a
// one-time fallback now — the normal cron path uses readTail() instead,
// which reads a bounded range rather than the whole tab.
//
// SAFETY: unlike the other read helpers, this one does NOT swallow a
// timeout and return an empty array — the caller treats an empty result
// as "no existing history" and would overwrite the whole tab with just
// the current month's data, which would be a serious silent data-loss
// bug if the real cause was just a slow/hung request rather than a
// genuinely empty tab. A real "sheet doesn't exist yet" error is still
// swallowed safely (that's a legitimate empty-history case); a timeout
// is re-thrown so the whole refresh fails loudly instead.
async function readRows(sheets, spreadsheetId, tabName) {
  try {
    const resp = await withTimeout(
      sheets.spreadsheets.values.get({ spreadsheetId, range: `'${tabName}'!A2:K` }),
      SHEETS_CALL_TIMEOUT_MS * 3, // generous — this can legitimately be a big read
      `readRows(${tabName})`
    );
    return resp.data.values || [];
  } catch (e) {
    if (String(e.message).startsWith('Timed out after')) {
      throw e; // don't guess — fail the whole refresh rather than risk wiping history
    }
    console.log(`[sheets] readRows(${tabName}) — treating as empty (${e.message})`);
    return [];
  }
}

// Reads a bounded tail of the tab, from `fromRow` (1-indexed, inclusive)
// to the end. Used by the cron path so it never has to read the entire
// historical dataset just to find where the current month's rows begin.
async function readTail(sheets, spreadsheetId, tabName, fromRow) {
  try {
    const resp = await withTimeout(
      sheets.spreadsheets.values.get({ spreadsheetId, range: `'${tabName}'!A${fromRow}:K` }),
      SHEETS_CALL_TIMEOUT_MS, `readTail(${tabName}, ${fromRow})`
    );
    return resp.data.values || [];
  } catch (e) {
    console.log(`[sheets] readTail(${tabName}) failed/timed out: ${e.message}`);
    return [];
  }
}

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
    SHEETS_CALL_TIMEOUT_MS * 3, // generous — this can legitimately be a big write
    `writeMatrix.update(${tabName}, ${matrix.length} rows)`
  );
}

// Clears from startRow (1-indexed) to a generous end, then writes rows
// starting at startRow. Used by the cron path to touch ONLY the current
// month's trailing block — everything before startRow is left completely
// untouched (never read, never rewritten).
async function clearAndWriteFrom(sheets, spreadsheetId, tabName, startRow, rows) {
  await withTimeout(
    sheets.spreadsheets.values.clear({ spreadsheetId, range: `'${tabName}'!A${startRow}:K200000` }),
    SHEETS_CALL_TIMEOUT_MS, `clearAndWriteFrom.clear(${tabName}, row ${startRow})`
  );
  if (!rows.length) return;

  const maxCols = rows.reduce((m, r) => Math.max(m, r.length), 0);
  const padded = rows.map(r => {
    const row = r.slice();
    while (row.length < maxCols) row.push('');
    return row;
  });

  await withTimeout(
    sheets.spreadsheets.values.update({
      spreadsheetId,
      range: `'${tabName}'!A${startRow}`,
      valueInputOption: 'USER_ENTERED',
      requestBody: { values: padded }
    }),
    SHEETS_CALL_TIMEOUT_MS, `clearAndWriteFrom.update(${tabName}, row ${startRow}, ${rows.length} rows)`
  );
}

// Small metadata tab tracking exactly how many data rows Raw Pull has
// (excluding its header). Since this app is the only writer, it always
// knows this number precisely after every write — storing it lets the
// cron path skip scanning the whole sheet to figure out where data ends.
async function readMetaRowCount(sheets, spreadsheetId) {
  try {
    const resp = await withTimeout(
      sheets.spreadsheets.values.get({ spreadsheetId, range: `'${META_SHEET}'!B1` }),
      SHEETS_CALL_TIMEOUT_MS, 'readMetaRowCount'
    );
    const v = resp.data.values && resp.data.values[0] && resp.data.values[0][0];
    const n = parseInt(v, 10);
    return isNaN(n) ? null : n;
  } catch (e) {
    console.log(`[sheets] readMetaRowCount failed/timed out: ${e.message}`);
    return null;
  }
}

async function writeMetaRowCount(sheets, spreadsheetId, count) {
  await ensureSheetExists(sheets, spreadsheetId, META_SHEET);
  await withTimeout(
    sheets.spreadsheets.values.update({
      spreadsheetId,
      range: `'${META_SHEET}'!A1`,
      valueInputOption: 'USER_ENTERED',
      requestBody: { values: [['RawPullDataRowCount', count], ['LastUpdated', new Date().toISOString()]] }
    }),
    SHEETS_CALL_TIMEOUT_MS, 'writeMetaRowCount'
  );
}

module.exports = {
  getSheetsClient, ensureSheetExists, readRows, writeMatrix,
  readTail, clearAndWriteFrom, readMetaRowCount, writeMetaRowCount
};
