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

async function getSheetId(sheets, spreadsheetId, tabName) {
  const meta = await sheets.spreadsheets.get({ spreadsheetId, fields: 'sheets.properties' });
  const found = meta.data.sheets.find(s => s.properties.title === tabName);
  return found ? found.properties.sheetId : null;
}

// Removes any row groups left over from a previous refresh, since the
// sheet is rebuilt from scratch each time and row counts/boundaries can
// shift between runs.
async function clearRowGroups(sheets, spreadsheetId, sheetId) {
  const meta = await sheets.spreadsheets.get({
    spreadsheetId,
    fields: 'sheets(properties.sheetId,rowGroups)'
  });
  const sheetMeta = meta.data.sheets.find(s => s.properties.sheetId === sheetId);
  const existingGroups = (sheetMeta && sheetMeta.rowGroups) || [];
  if (!existingGroups.length) return;

  const requests = existingGroups.map(g => ({ deleteDimensionGroup: { range: g.range } }));
  await sheets.spreadsheets.batchUpdate({ spreadsheetId, requestBody: { requests } });
}

// Applies one collapsible row group per month block. `groups` is
// [{startRow, endRow, collapsed}], 1-indexed and inclusive (as produced
// by buildVerticalMatrix) — only the most recent month has collapsed:false.
//
// NOTE: this is my best understanding of the Sheets API v4 shape for
// addDimensionGroup/updateDimensionGroup — I can't execute this myself to
// confirm, so if grouping doesn't apply cleanly on the first real run,
// check the Vercel function logs for the specific error and we'll adjust.
async function applyRowGroups(sheets, spreadsheetId, tabName, groups) {
  if (!groups || !groups.length) return;

  const sheetId = await getSheetId(sheets, spreadsheetId, tabName);
  if (sheetId === null) return;

  await clearRowGroups(sheets, spreadsheetId, sheetId);

  const addRequests = groups.map(g => ({
    addDimensionGroup: {
      range: { sheetId, dimension: 'ROWS', startIndex: g.startRow - 1, endIndex: g.endRow }
    }
  }));
  await sheets.spreadsheets.batchUpdate({ spreadsheetId, requestBody: { requests: addRequests } });

  const stateRequests = [];
  groups.forEach(g => {
    const range = { sheetId, dimension: 'ROWS', startIndex: g.startRow - 1, endIndex: g.endRow };
    stateRequests.push({
      updateDimensionGroup: {
        dimensionGroup: { range, depth: 1, collapsed: g.collapsed },
        fields: 'collapsed'
      }
    });
    stateRequests.push({
      updateDimensionProperties: {
        range,
        properties: { hiddenByUser: g.collapsed },
        fields: 'hiddenByUser'
      }
    });
  });
  if (stateRequests.length) {
    await sheets.spreadsheets.batchUpdate({ spreadsheetId, requestBody: { requests: stateRequests } });
  }
}

module.exports = { getSheetsClient, ensureSheetExists, writeMatrix, applyRowGroups };
