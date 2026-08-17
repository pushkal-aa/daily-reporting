/**
 * lib/sheets.js
 * Requires GOOGLE_SERVICE_ACCOUNT_KEY env var — same service account key
 * used for BigQuery. This account must additionally be shared as an
 * Editor on the target Google Sheet.
 */

const { google } = require('googleapis');

const META_SHEET = 'Raw Pull Meta';

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
  const authClient = await auth.getClient();
  return google.sheets({ version: 'v4', auth: authClient });
}

async function ensureSheetExists(sheets, spreadsheetId, title) {
  const meta = await sheets.spreadsheets.get({ spreadsheetId, fields: 'sheets.properties' });
  const existing = meta.data.sheets.find(s => s.properties.title === title);
  if (existing) return existing.properties.sheetId;

  const resp = await sheets.spreadsheets.batchUpdate({
    spreadsheetId,
    requestBody: { requests: [{ addSheet: { properties: { title } } }] }
  });
  return resp.data.replies[0].addSheet.properties.sheetId;
}

// Reads back ALL existing data rows (excludes header). Only used as a
// one-time fallback now — the normal cron path uses readTail() instead,
// which reads a bounded range rather than the whole tab.
async function readRows(sheets, spreadsheetId, tabName) {
  try {
    const resp = await sheets.spreadsheets.values.get({ spreadsheetId, range: `'${tabName}'!A2:K` });
    return resp.data.values || [];
  } catch (e) {
    return [];
  }
}

// Reads a bounded tail of the tab, from `fromRow` (1-indexed, inclusive)
// to the end. Used by the cron path so it never has to read the entire
// historical dataset just to find where the current month's rows begin.
async function readTail(sheets, spreadsheetId, tabName, fromRow) {
  try {
    const resp = await sheets.spreadsheets.values.get({ spreadsheetId, range: `'${tabName}'!A${fromRow}:K` });
    return resp.data.values || [];
  } catch (e) {
    return [];
  }
}

async function writeMatrix(sheets, spreadsheetId, tabName, matrix) {
  await ensureSheetExists(sheets, spreadsheetId, tabName);
  await sheets.spreadsheets.values.clear({ spreadsheetId, range: `'${tabName}'!A1:ZZ200000` });

  if (!matrix.length) return;

  const maxCols = matrix.reduce((m, r) => Math.max(m, r.length), 0);
  const padded = matrix.map(r => {
    const row = r.slice();
    while (row.length < maxCols) row.push('');
    return row;
  });

  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: `'${tabName}'!A1`,
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: padded }
  });
}

// Clears from startRow (1-indexed) to a generous end, then writes rows
// starting at startRow. Used by the cron path to touch ONLY the current
// month's trailing block — everything before startRow is left completely
// untouched (never read, never rewritten).
async function clearAndWriteFrom(sheets, spreadsheetId, tabName, startRow, rows) {
  await sheets.spreadsheets.values.clear({ spreadsheetId, range: `'${tabName}'!A${startRow}:K200000` });
  if (!rows.length) return;

  const maxCols = rows.reduce((m, r) => Math.max(m, r.length), 0);
  const padded = rows.map(r => {
    const row = r.slice();
    while (row.length < maxCols) row.push('');
    return row;
  });

  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: `'${tabName}'!A${startRow}`,
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: padded }
  });
}

// Small metadata tab tracking exactly how many data rows Raw Pull has
// (excluding its header). Since this app is the only writer, it always
// knows this number precisely after every write — storing it lets the
// cron path skip scanning the whole sheet to figure out where data ends.
async function readMetaRowCount(sheets, spreadsheetId) {
  try {
    const resp = await sheets.spreadsheets.values.get({ spreadsheetId, range: `'${META_SHEET}'!B1` });
    const v = resp.data.values && resp.data.values[0] && resp.data.values[0][0];
    const n = parseInt(v, 10);
    return isNaN(n) ? null : n;
  } catch (e) {
    return null;
  }
}

async function writeMetaRowCount(sheets, spreadsheetId, count) {
  await ensureSheetExists(sheets, spreadsheetId, META_SHEET);
  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: `'${META_SHEET}'!A1`,
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: [['RawPullDataRowCount', count], ['LastUpdated', new Date().toISOString()]] }
  });
}

module.exports = {
  getSheetsClient, ensureSheetExists, readRows, writeMatrix,
  readTail, clearAndWriteFrom, readMetaRowCount, writeMetaRowCount
};
