/**
 * lib/main.js
 *
 * Writes ONLY to per-vertical tabs (e.g. "AVR Raw", "Hosting Raw",
 * "SLR Raw", "LLC Raw"), named `${Vertical} Raw`. The combined "Raw
 * Pull" tab has been fully migrated away from and deleted (2026-08-19) —
 * this file no longer writes to it at all.
 *
 * The "last date pulled" marker lives in a fixed tab (MARKER_TAB below)
 * since there's no single combined tab to anchor it to anymore.
 *
 * - Cron (daily 9am IST): incremental append. Reads the marker to
 *   compute the gap (normally 1 day), fetches BigQuery for just that gap,
 *   groups results by vertical, and appends each group to its own tab —
 *   never reads, clears, or rewrites any existing row.
 *
 *   READ-FAILURE DEFAULT: if the marker read fails, defaults to "just
 *   pull yesterday" rather than a full refresh (this app has months of
 *   real history already — assuming "no marker means no history" would
 *   be wrong and costly).
 *
 * - Manual (curl, Apps Script test call, anything hitting /api/refresh
 *   without the cron's query param): full refresh — re-pulls everything
 *   from START_DATE through yesterday, groups by vertical, and does a
 *   full clear+rewrite of each vertical's own tab. On-demand tool for
 *   catching reversals/revisions to older data.
 */

const { fetchRows } = require('./bigquery');
const { flattenRows } = require('./flatten');
const { getSheetsClient, writeMatrix, appendRows, readMetaLastDate, writeMetaLastDate } = require('./sheets');
const { SHEET_ID, START_DATE, TIMEZONE, RAW_HEADERS } = require('./config');

// Fixed tab used for the "last date pulled" marker — AVR reliably has
// data every single day, so this is a stable anchor regardless of which
// other verticals happen to have rows on any given day.
const MARKER_TAB = 'AVR Raw';

function rawTabName(vertical) {
  return `${vertical} Raw`;
}

// Splits flattened rows (schema: [Date, Vertical, Geo, ...]) by their
// Vertical (index 1) into { vertical: [rows] }.
function groupByVertical(rows) {
  const groups = {};
  rows.forEach(r => {
    const vertical = r[1];
    if (!groups[vertical]) groups[vertical] = [];
    groups[vertical].push(r);
  });
  return groups;
}

function todayISO() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: TIMEZONE, year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(new Date());
  const map = {};
  parts.forEach(p => { map[p.type] = p.value; });
  return `${map.year}-${map.month}-${map.day}`;
}

function yesterdayISO() {
  const [y, m, d] = todayISO().split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() - 1);
  return dt.getUTCFullYear() + '-' + String(dt.getUTCMonth() + 1).padStart(2, '0') + '-' + String(dt.getUTCDate()).padStart(2, '0');
}

function addOneDayISO(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + 1);
  return dt.getUTCFullYear() + '-' + String(dt.getUTCMonth() + 1).padStart(2, '0') + '-' + String(dt.getUTCDate()).padStart(2, '0');
}

function elapsed(start) {
  return ((Date.now() - start) / 1000).toFixed(1) + 's';
}

async function doFullRefresh(sheets, endDate) {
  const t1 = Date.now();
  const fresh = await fetchRows(START_DATE, endDate);
  console.log(`[timing] BigQuery fetch (full history): ${elapsed(t1)}`);

  const finalRows = flattenRows(fresh.spendRows, fresh.revRows);
  const grouped = groupByVertical(finalRows);

  const t2 = Date.now();
  let totalRows = 0;
  for (const vertical of Object.keys(grouped)) {
    await writeMatrix(sheets, SHEET_ID, rawTabName(vertical), [RAW_HEADERS, ...grouped[vertical]]);
    totalRows += grouped[vertical].length;
  }
  console.log(`[timing] Sheets writeMatrix (${Object.keys(grouped).length} vertical tabs, ${totalRows} total rows): ${elapsed(t2)}`);

  await writeMetaLastDate(sheets, SHEET_ID, MARKER_TAB, endDate);
  return { totalRows, verticals: Object.keys(grouped) };
}

async function runFullRefresh(isCronTrigger) {
  if (!SHEET_ID) throw new Error('Missing GOOGLE_SHEET_ID env var');

  const t0 = Date.now();
  const sheets = await getSheetsClient();
  console.log(`[timing] getSheetsClient: ${elapsed(t0)}`);

  const endDate = yesterdayISO();

  if (isCronTrigger) {
    const t1 = Date.now();
    const lastDate = await readMetaLastDate(sheets, SHEET_ID, MARKER_TAB);
    console.log(`[timing] readMetaLastDate: ${elapsed(t1)} (last=${lastDate})`);

    const rangeStart = lastDate ? addOneDayISO(lastDate) : endDate;
    const usedFallbackDefault = lastDate === null;

    if (lastDate !== null && rangeStart > endDate) {
      console.log(`[timing] Already up to date (rangeStart ${rangeStart} > endDate ${endDate}) — no-op`);
      return {
        refreshedAt: new Date().toISOString(),
        trigger: 'cron', pullType: 'noop-alreadyUpToDate', pulledThrough: lastDate
      };
    }

    const t2 = Date.now();
    const fresh = await fetchRows(rangeStart, endDate);
    console.log(`[timing] BigQuery fetch (${rangeStart} to ${endDate}): ${elapsed(t2)}`);

    const t3 = Date.now();
    const freshFlat = flattenRows(fresh.spendRows, fresh.revRows);
    const grouped = groupByVertical(freshFlat);
    console.log(`[timing] flatten (${freshFlat.length} rows, ${Object.keys(grouped).length} verticals): ${elapsed(t3)}`);

    const t4 = Date.now();
    for (const vertical of Object.keys(grouped)) {
      await appendRows(sheets, SHEET_ID, rawTabName(vertical), grouped[vertical]);
    }
    console.log(`[timing] appendRows (${Object.keys(grouped).length} vertical tabs): ${elapsed(t4)}`);

    await writeMetaLastDate(sheets, SHEET_ID, MARKER_TAB, endDate);
    console.log(`[timing] TOTAL: ${elapsed(t0)}`);

    return {
      refreshedAt: new Date().toISOString(),
      trigger: 'cron',
      pullType: usedFallbackDefault ? 'incremental-noReadMarker' : 'incremental',
      rangeStart, rangeEnd: endDate, rowCount: freshFlat.length, verticals: Object.keys(grouped)
    };
  }

  // Manual — full refresh, on-demand tool for catching reversals/revisions.
  const { totalRows, verticals } = await doFullRefresh(sheets, endDate);
  console.log(`[timing] TOTAL: ${elapsed(t0)}`);

  return {
    refreshedAt: new Date().toISOString(),
    trigger: 'manual', pullType: 'full', pulledThrough: endDate, rowCount: totalRows, verticals
  };
}

module.exports = { runFullRefresh };
