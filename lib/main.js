/**
 * lib/main.js
 *
 * - Cron (daily 9am IST): pulls the CURRENT MONTH ONLY and merges it into
 *   whatever's already in the Raw Pull tab — rows for other months are
 *   read back and kept exactly as they were.
 * - Manual (curl, Apps Script test call, anything hitting /api/refresh
 *   without the cron's query param): does a FULL refresh — re-pulls
 *   everything from START_DATE (2026-06-01) through today and replaces
 *   the whole tab. This is the "on request, full refresh" behavior.
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

function currentMonthStartISO(todayStr) {
  return todayStr.slice(0, 7) + '-01';
}

async function runFullRefresh(isCronTrigger) {
  if (!SHEET_ID) throw new Error('Missing GOOGLE_SHEET_ID env var');

  const sheets = await getSheetsClient();
  const today = todayISO();

  let finalRows;
  let pullType;

  if (isCronTrigger) {
    const monthStart = currentMonthStartISO(today);
    const fresh = await fetchRows(monthStart, today);
    const freshFlat = flattenRows(fresh.spendRows, fresh.revRows);

    const existing = await readRows(sheets, SHEET_ID, RAW_SHEET);
    const kept = existing.filter(r => !(r[0] >= monthStart && r[0] <= today));

    finalRows = kept.concat(freshFlat);
    finalRows.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0)));
    pullType = 'currentMonth';
  } else {
    const fresh = await fetchRows(START_DATE, today);
    finalRows = flattenRows(fresh.spendRows, fresh.revRows);
    pullType = 'full';
  }

  await writeMatrix(sheets, SHEET_ID, RAW_SHEET, [RAW_HEADERS, ...finalRows]);

  return {
    refreshedAt: new Date().toISOString(),
    trigger: isCronTrigger ? 'cron' : 'manual',
    pullType,
    rowCount: finalRows.length
  };
}

module.exports = { runFullRefresh };
