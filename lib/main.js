/**
 * lib/main.js
 *
 * - Cron (daily 9am IST): incremental append ONLY when there's already a
 *   known "last date pulled" marker. Reads that marker, fetches from
 *   BigQuery for just the gap since then through yesterday (normally
 *   exactly 1 day), and APPENDS those rows — never reads, clears, or
 *   rewrites any existing row. Self-heals if the cron misses a day or
 *   two by pulling the whole gap next time.
 *
 *   If NO marker exists yet, this does a full refresh (clear + rewrite)
 *   instead of appending — appending the entire history onto a tab that
 *   might already have real data in it is NOT safe (this caused a real
 *   data-duplication incident on 2026-08-14: the first-ever cron run
 *   found no marker, computed a full-history range, and appended a
 *   second copy of everything on top of what was already there). A full
 *   refresh is always safe regardless of what's currently in the tab.
 *
 *   This does NOT re-check older days for late-arriving postbacks or
 *   reversals once a marker exists — that's a deliberate tradeoff now,
 *   not an oversight.
 *
 * - Manual (curl, Apps Script test call, anything hitting /api/refresh
 *   without the cron's query param): full refresh — re-pulls everything
 *   from START_DATE through yesterday and replaces the whole tab. This
 *   is the on-demand tool for catching reversals and revisions to older
 *   data — run it whenever you actually need that.
 */

const { fetchRows } = require('./bigquery');
const { flattenRows } = require('./flatten');
const { getSheetsClient, writeMatrix, appendRows, readMetaLastDate, writeMetaLastDate } = require('./sheets');
const { SHEET_ID, START_DATE, TIMEZONE, RAW_SHEET, RAW_HEADERS } = require('./config');

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

  const t2 = Date.now();
  await writeMatrix(sheets, SHEET_ID, RAW_SHEET, [RAW_HEADERS, ...finalRows]);
  console.log(`[timing] Sheets writeMatrix (${finalRows.length} rows): ${elapsed(t2)}`);

  await writeMetaLastDate(sheets, SHEET_ID, RAW_SHEET, endDate);
  return finalRows.length;
}

async function runFullRefresh(isCronTrigger) {
  if (!SHEET_ID) throw new Error('Missing GOOGLE_SHEET_ID env var');

  const t0 = Date.now();
  const sheets = await getSheetsClient();
  console.log(`[timing] getSheetsClient: ${elapsed(t0)}`);

  const endDate = yesterdayISO();

  if (isCronTrigger) {
    const t1 = Date.now();
    const lastDate = await readMetaLastDate(sheets, SHEET_ID, RAW_SHEET);
    console.log(`[timing] readMetaLastDate: ${elapsed(t1)} (last=${lastDate})`);

    if (lastDate === null) {
      // No marker yet — full refresh, NOT an append. Safe regardless of
      // whatever's currently in the tab; also establishes the marker so
      // every future cron run takes the fast incremental path.
      console.log('[timing] No marker found — doing a full refresh instead of an append (safety)');
      const rowCount = await doFullRefresh(sheets, endDate);
      console.log(`[timing] TOTAL: ${elapsed(t0)}`);
      return {
        refreshedAt: new Date().toISOString(),
        trigger: 'cron', pullType: 'full-noMarkerYet', pulledThrough: endDate, rowCount
      };
    }

    const rangeStart = addOneDayISO(lastDate);

    if (rangeStart > endDate) {
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
    console.log(`[timing] flatten (${freshFlat.length} rows): ${elapsed(t3)}`);

    const t4 = Date.now();
    await appendRows(sheets, SHEET_ID, RAW_SHEET, freshFlat);
    console.log(`[timing] appendRows: ${elapsed(t4)}`);

    await writeMetaLastDate(sheets, SHEET_ID, RAW_SHEET, endDate);
    console.log(`[timing] TOTAL: ${elapsed(t0)}`);

    return {
      refreshedAt: new Date().toISOString(),
      trigger: 'cron', pullType: 'incremental',
      rangeStart, rangeEnd: endDate, rowCount: freshFlat.length
    };
  }

  // Manual — full refresh, on-demand tool for catching reversals/revisions.
  const rowCount = await doFullRefresh(sheets, endDate);
  console.log(`[timing] TOTAL: ${elapsed(t0)}`);

  return {
    refreshedAt: new Date().toISOString(),
    trigger: 'manual', pullType: 'full', pulledThrough: endDate, rowCount
  };
}

module.exports = { runFullRefresh };
