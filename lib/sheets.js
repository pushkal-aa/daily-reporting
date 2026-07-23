/**
 * lib/sheets.js
 * Requires GOOGLE_SERVICE_ACCOUNT_KEY env var — same service account key
 * used for BigQuery. This account must additionally be shared as an
 * Editor on the target Google Sheet (share it with the service account's
 * "client_email" like any other collaborator).
 */

const { google } = require('googleapis');

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

async function writeMatrix(sheets, spreadsheetId, tabName, matrix) {
  await ensureSheetExists(sheets, spreadsheetId, tabName);

  // Clear existing content before writing the fresh rebuild
  await sheets.spreadsheets.values.clear({ spreadsheetId, range: `'${tabName}'!A1:ZZ20000` });

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

module.exports = { getSheetsClient, ensureSheetExists, writeMatrix };
