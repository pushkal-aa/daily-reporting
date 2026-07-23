/**
 * lib/cache.js
 * Caches the last BigQuery pull in a "Data Cache" tab (auto-created,
 * hidden or not — safe to ignore/hide manually) so re-running the
 * refresh to test layout/visual changes doesn't re-query BigQuery every
 * time. main.js decides when to actually re-pull vs. reuse this cache.
 *
 * Stored as: lastPulledAt / cachedRangeStart / cachedRangeEnd (single
 * rows), then the spendRows/revRows arrays as JSON, chunked across
 * multiple rows (a single Sheets cell caps at ~50,000 characters).
 */

const { writeMatrix } = require('./sheets');

const CACHE_SHEET = 'Data Cache';
const CHUNK_SIZE = 40000;

function chunkString(str) {
  const chunks = [];
  for (let i = 0; i < str.length; i += CHUNK_SIZE) chunks.push(str.slice(i, i + CHUNK_SIZE));
  return chunks.length ? chunks : [''];
}

async function readCache(sheets, spreadsheetId) {
  let values;
  try {
    const resp = await sheets.spreadsheets.values.get({ spreadsheetId, range: `'${CACHE_SHEET}'!A:B` });
    values = resp.data.values || [];
  } catch (e) {
    return null; // tab missing — no cache yet, first run will create it
  }
  if (!values.length) return null;

  const meta = {};
  const spendChunks = [];
  const revChunks = [];
  values.forEach(r => {
    const key = r[0], val = r[1];
    if (key === 'lastPulledAt') meta.lastPulledAt = val;
    else if (key === 'cachedRangeStart') meta.cachedRangeStart = val;
    else if (key === 'cachedRangeEnd') meta.cachedRangeEnd = val;
    else if (key === 'spendRowsJson') spendChunks.push(val || '');
    else if (key === 'revRowsJson') revChunks.push(val || '');
  });

  if (!meta.lastPulledAt) return null;

  try {
    meta.spendRows = spendChunks.length ? JSON.parse(spendChunks.join('')) : [];
    meta.revRows = revChunks.length ? JSON.parse(revChunks.join('')) : [];
  } catch (e) {
    return null; // corrupted/partial cache — treat as missing, forces a fresh pull
  }
  return meta;
}

async function writeCache(sheets, spreadsheetId, { spendRows, revRows, lastPulledAt, cachedRangeStart, cachedRangeEnd }) {
  const matrix = [
    ['lastPulledAt', lastPulledAt],
    ['cachedRangeStart', cachedRangeStart],
    ['cachedRangeEnd', cachedRangeEnd]
  ];
  chunkString(JSON.stringify(spendRows || [])).forEach(chunk => matrix.push(['spendRowsJson', chunk]));
  chunkString(JSON.stringify(revRows || [])).forEach(chunk => matrix.push(['revRowsJson', chunk]));

  await writeMatrix(sheets, spreadsheetId, CACHE_SHEET, matrix);
}

module.exports = { readCache, writeCache, CACHE_SHEET };
