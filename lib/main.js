/**
 * lib/main.js
 *
 * Raw Pull only ever contains complete days — data through yesterday,
 * never today. Today's BigQuery data is still partial (the day isn't
 * over), so including it would show an incomplete row that then gets
 * silently overwritten hours later once the day actually finishes —
 * confusing to look at either way. Both pull paths stop at yesterday:
 *
 * - Cron (daily 9am IST): pulls the CURRENT MONTH ONLY, through
 *   yesterday, and merges it into whatever's already in the Raw Pull
 *   tab — rows for other months are read back and kept exactly as they
 *   were.
 * - Manual (curl, Apps Script test call, anything hitting /api/refresh
 *   without the cron's query param): does a FULL refresh — re-pulls
 *   everything from START_DATE (2026-06-01) through yesterday and
 *   replaces the whole tab. This is the "on request, full refresh"
 *   behavior.
 *
 * That's the entire job. Everything else (Total All, AVR/Hosting/SLR/LLC
 * calculations, formatting) is built with formulas in the Sheet itself,
 * reading from the Raw Pull tab this writes.
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

// One calendar day before "today" (Asia/Kolkata) — the actual end
// boundary for every pull, so today's partial day never lands in Raw Pull.
function yesterdayISO() {
  const [y, m, d] = todayISO().split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() - 1);
  return dt.getUTCFullYear() + '-' + String(dt.getUTCMonth() + 1).padStart(2, '0') + '-' + String(dt.getUTCDate()).padStart(2, '0');
}

function currentMonthStartISO(dateStr) {
  return dateStr.slice(0, 7) + '-01';
}

async function runFullRefresh(isCronTrigger) {
  if (!SHEET_ID) throw new Error('Missing GOOGLE_SHEET_ID env var');

  const sheets = await getSheetsClient();
  const endDate = yesterdayISO();

  let finalRows;
  let pullType;

  if (isCronTrigger) {
    const monthStart = currentMonthStartISO(endDate);
    const fresh = await fetchRows(monthStart, endDate);
    const freshFlat = flattenRows(fresh.spendRows, fresh.revRows);

    const existing = await readRows(sheets, SHEET_ID, RAW_SHEET);
    const kept = existing.filter(r => !(r[0] >= monthStart && r[0] <= endDate));

    finalRows = kept.concat(freshFlat);
    finalRows.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0)));
    pullType = 'currentMonth';
  } else {
    const fresh = await fetchRows(START_DATE, endDate);
    finalRows = flattenRows(fresh.spendRows, fresh.revRows);
    pullType = 'full';
  }

  await writeMatrix(sheets, SHEET_ID, RAW_SHEET, [RAW_HEADERS, ...finalRows]);

  return {
    refreshedAt: new Date().toISOString(),
    trigger: isCronTrigger ? 'cron' : 'manual',
    pullType,
    pulledThrough: endDate,
    rowCount: finalRows.length
  };
}

module.exports = { runFullRefresh };
