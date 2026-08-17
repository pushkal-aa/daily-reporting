/**
 * lib/main.js
 *
 * - Cron (daily 9am IST): pulls the CURRENT MONTH ONLY, through
 *   yesterday, and merges it into whatever's already in the Raw Pull
 *   tab — rows for other months are read back and kept exactly as they
 *   were.
 * - Manual (curl, Apps Script test call, anything hitting /api/refresh
 *   without the cron's query param): does a FULL refresh — re-pulls
 *   everything from START_DATE (2026-06-01) through yesterday and
 *   replaces the whole tab.
 *
 * TIMING INSTRUMENTATION (2026-08-12): added after a 504 timeout on the
 * cron path. Logs how long each major step takes (BigQuery fetch, Sheets
 * read-back, Sheets write) so the NEXT run's Vercel logs show exactly
 * where time is going, rather than guessing — Raw Pull has grown large
 * enough that either BigQuery or the Sheets API read/write could plausibly
 * be the real bottleneck, and this will confirm which one.
 */

const { fetchRows } = require('./bigquery');
const { flattenRows } = require('./flatten');
const { getSheetsClient, readRows, writeMatrix } = require('./sheets');
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

  let finalRows;
  let pullType;

  if (isCronTrigger) {
    const monthStart = currentMonthStartISO(endDate);

    const t1 = Date.now();
    const fresh = await fetchRows(monthStart, endDate);
    console.log(`[timing] BigQuery fetch (current month): ${elapsed(t1)}`);

    const t2 = Date.now();
    const freshFlat = flattenRows(fresh.spendRows, fresh.revRows);
    console.log(`[timing] flatten: ${elapsed(t2)}`);

    const t3 = Date.now();
    const existing = await readRows(sheets, SHEET_ID, RAW_SHEET);
    console.log(`[timing] Sheets readRows (existing ${existing.length} rows): ${elapsed(t3)}`);

    const kept = existing.filter(r => !(r[0] >= monthStart && r[0] <= endDate));
    finalRows = kept.concat(freshFlat);
    finalRows.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0)));
    pullType = 'currentMonth';
  } else {
    const t1 = Date.now();
    const fresh = await fetchRows(START_DATE, endDate);
    console.log(`[timing] BigQuery fetch (full history): ${elapsed(t1)}`);

    finalRows = flattenRows(fresh.spendRows, fresh.revRows);
    pullType = 'full';
  }

  const t4 = Date.now();
  await writeMatrix(sheets, SHEET_ID, RAW_SHEET, [RAW_HEADERS, ...finalRows]);
  console.log(`[timing] Sheets writeMatrix (${finalRows.length} rows): ${elapsed(t4)}`);

  console.log(`[timing] TOTAL: ${elapsed(t0)}`);

  return {
    refreshedAt: new Date().toISOString(),
    trigger: isCronTrigger ? 'cron' : 'manual',
    pullType,
    pulledThrough: endDate,
    rowCount: finalRows.length
  };
}

module.exports = { runFullRefresh };
