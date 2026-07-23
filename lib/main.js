/**
 * lib/main.js
 */

const { fetchRows } = require('./bigquery');
const { buildDataModel } = require('./dataModel');
const { buildVerticalMatrix } = require('./verticalTabWriter');
const { buildTotalAllMatrix } = require('./totalAllWriter');
const { readTargets } = require('./targets');
const { getSheetsClient, writeMatrix } = require('./sheets');
const { VERTICALS, SHEET_ID } = require('./config');

async function runFullRefresh() {
  if (!SHEET_ID) throw new Error('Missing GOOGLE_SHEET_ID env var');

  const sheets = await getSheetsClient();
  const { spendRows, revRows } = await fetchRows();
  const data = buildDataModel(spendRows, revRows);
  const targets = await readTargets(sheets, SHEET_ID);

  for (const v of VERTICALS) {
    const matrix = buildVerticalMatrix(v, data[v.code]);
    await writeMatrix(sheets, SHEET_ID, v.tab, matrix);
  }

  const totalAllMatrix = buildTotalAllMatrix(data, targets);
  await writeMatrix(sheets, SHEET_ID, 'Total All', totalAllMatrix);

  return { refreshedAt: new Date().toISOString(), verticals: VERTICALS.map(v => v.tab) };
}

module.exports = { runFullRefresh };
