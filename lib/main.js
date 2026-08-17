/**
 * lib/main.js
 *
 * - Cron (daily 9am IST): incremental append. Reads the "last date
 *   pulled" marker to compute the gap (normally exactly 1 day) and
 *   appends just that — never reads, clears, or rewrites any existing
 *   row.
 *
 *   READ-FAILURE DEFAULT (changed 2026-08-17): if the marker read fails
 *   (this has happened repeatedly — a specific single-cell read hanging
 *   even with retries, across two different API methods), this used to
 *   fall back to a full refresh, on the assumption that "no marker" might
 *   mean "no history yet." That assumption made sense once, but it means
 *   every read failure now costs a full historical re-pull — unacceptable
 *   as a recurring daily cost once real history already exists (which it
 *   does). The default has flipped: a failed/missing read now defaults
 *   to "just pull yesterday" (the correct assumption almost always, given
 *   this app has been running for months), not "assume there's no
 *   history and rebuild everything." The residual risk is a duplicate
 *   day's rows if the marker read fails AND the cron somehow fires twice
 *   in the same day — rare, and self-healed by the next manual full
 *   refresh, which is a far better tradeoff than guaranteed daily full
 *   refreshes. A TRUE first-ever run (a brand new deployment with a
 *   genuinely empty Raw Pull) is a one-time bootstrap case, not the
 *   normal operating mode — run a manual full refresh once for that.
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

    // rangeStart: if we have a valid marker, pull the gap since then.
    // If the read failed/returned nothing, default to "just yesterday"
    // — NOT a full refresh — see the file-level comment for why.
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
    console.log(`[timing] flatten (${freshFlat.length} rows): ${elapsed(t3)}`);

    const t4 = Date.now();
    await appendRows(sheets, SHEET_ID, RAW_SHEET, freshFlat);
    console.log(`[timing] appendRows: ${elapsed(t4)}`);

    await writeMetaLastDate(sheets, SHEET_ID, RAW_SHEET, endDate);
    console.log(`[timing] TOTAL: ${elapsed(t0)}`);

    return {
      refreshedAt: new Date().toISOString(),
      trigger: 'cron',
      pullType: usedFallbackDefault ? 'incremental-noReadMarker' : 'incremental',
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
