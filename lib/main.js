/**
 * lib/main.js
 *
 * - Cron (daily 9am IST): pulls the CURRENT MONTH ONLY, through
 *   yesterday. Uses a BOUNDED TAIL READ (not the whole sheet) to find
 *   where the current month's existing rows start, then clears and
 *   rewrites only that trailing block — every row before it is never
 *   read or touched. This is the fix for the 504 timeouts: on Vercel's
 *   Hobby plan (60s hard cap), reading + rewriting the entire 100,000+
 *   row historical dataset every single day was the bottleneck, even
 *   though the actual new data each day is tiny.
 * - Manual (curl, Apps Script test call, anything hitting /api/refresh
 *   without the cron's query param): unchanged — still does a FULL
 *   refresh, re-pulling everything from START_DATE through yesterday
 *   and replacing the whole tab. This path is rare enough that its
 *   cost is acceptable, and simplicity here matters more than speed.
 *
 * TAIL_BUFFER_ROWS: how far back the cron path reads to find the
 * current-month boundary. Measured actual volume is ~260 rows/day,
 * ~8,000 rows for a full month — this is set to ~3x that as a safety
 * margin. If monthly volume grows substantially (e.g. many more
 * verticals/partners), this may need raising; if it's ever too small,
 * the boundary-detection falls back to treating the month as "brand
 * new" and could append duplicate rows, so err on the generous side.
 */

const { fetchRows } = require('./bigquery');
const { flattenRows } = require('./flatten');
const {
  getSheetsClient, readRows, writeMatrix,
  readTail, clearAndWriteFrom, readMetaRowCount, writeMetaRowCount
} = require('./sheets');
const { SHEET_ID, START_DATE, TIMEZONE, RAW_SHEET, RAW_HEADERS } = require('./config');

const TAIL_BUFFER_ROWS = 25000;

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

function currentMonthStartISO(dateStr) {
  return dateStr.slice(0, 7) + '-01';
}

function elapsed(start) {
  return ((Date.now() - start) / 1000).toFixed(1) + 's';
}

async function runFullRefresh(isCronTrigger) {
  if (!SHEET_ID) throw new Error('Missing GOOGLE_SHEET_ID env var');

  const t0 = Date.now();
  const sheets = await getSheetsClient();
  console.log(`[timing] getSheetsClient: ${elapsed(t0)}`);

  const endDate = yesterdayISO();
  let pullType;
  let rowCountResult;

  if (isCronTrigger) {
    const monthStart = currentMonthStartISO(endDate);

    const t1 = Date.now();
    const fresh = await fetchRows(monthStart, endDate);
    console.log(`[timing] BigQuery fetch (current month): ${elapsed(t1)}`);

    const t2 = Date.now();
    const freshFlat = flattenRows(fresh.spendRows, fresh.revRows);
    console.log(`[timing] flatten (${freshFlat.length} rows): ${elapsed(t2)}`);

    const t3 = Date.now();
    const knownRowCount = await readMetaRowCount(sheets, SHEET_ID);
    console.log(`[timing] readMetaRowCount: ${elapsed(t3)} (known=${knownRowCount})`);

    if (knownRowCount === null) {
      // No metadata yet — one-time fallback to the old full-read
      // approach, then establish Meta so every future run takes the
      // fast path instead.
      const t3b = Date.now();
      const existing = await readRows(sheets, SHEET_ID, RAW_SHEET);
      console.log(`[timing] Sheets readRows FALLBACK (existing ${existing.length} rows): ${elapsed(t3b)}`);

      const kept = existing.filter(r => !(r[0] >= monthStart && r[0] <= endDate));
      const finalRows = kept.concat(freshFlat);
      finalRows.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0)));

      const t4 = Date.now();
      await writeMatrix(sheets, SHEET_ID, RAW_SHEET, [RAW_HEADERS, ...finalRows]);
      console.log(`[timing] Sheets writeMatrix FALLBACK (${finalRows.length} rows): ${elapsed(t4)}`);

      await writeMetaRowCount(sheets, SHEET_ID, finalRows.length);
      pullType = 'currentMonth-fallbackFullWrite';
      rowCountResult = finalRows.length;
    } else {
      // Fast path: bounded tail read only.
      const tailStartRow = Math.max(2, (knownRowCount + 1) - TAIL_BUFFER_ROWS + 1);

      const t3c = Date.now();
      const tail = await readTail(sheets, SHEET_ID, RAW_SHEET, tailStartRow);
      console.log(`[timing] readTail (${tail.length} rows from row ${tailStartRow}): ${elapsed(t3c)}`);

      const boundaryOffset = tail.findIndex(r => r[0] >= monthStart);
      const boundaryRow = boundaryOffset === -1 ? knownRowCount + 2 : tailStartRow + boundaryOffset;

      const t4 = Date.now();
      await clearAndWriteFrom(sheets, SHEET_ID, RAW_SHEET, boundaryRow, freshFlat);
      console.log(`[timing] clearAndWriteFrom (${freshFlat.length} rows at row ${boundaryRow}): ${elapsed(t4)}`);

      const newTotalRows = (boundaryRow - 2) + freshFlat.length;
      await writeMetaRowCount(sheets, SHEET_ID, newTotalRows);
      pullType = 'currentMonth';
      rowCountResult = newTotalRows;
    }
  } else {
    const t1 = Date.now();
    const fresh = await fetchRows(START_DATE, endDate);
    console.log(`[timing] BigQuery fetch (full history): ${elapsed(t1)}`);

    const finalRows = flattenRows(fresh.spendRows, fresh.revRows);
    pullType = 'full';

    const t4 = Date.now();
    await writeMatrix(sheets, SHEET_ID, RAW_SHEET, [RAW_HEADERS, ...finalRows]);
    console.log(`[timing] Sheets writeMatrix (${finalRows.length} rows): ${elapsed(t4)}`);

    await writeMetaRowCount(sheets, SHEET_ID, finalRows.length);
    rowCountResult = finalRows.length;
  }

  console.log(`[timing] TOTAL: ${elapsed(t0)}`);

  return {
    refreshedAt: new Date().toISOString(),
    trigger: isCronTrigger ? 'cron' : 'manual',
    pullType,
    pulledThrough: endDate,
    rowCount: rowCountResult
  };
}

module.exports = { runFullRefresh };
