/**
 * lib/main.js
 *
 * Refresh behavior depends on how it was triggered and what's in Config:
 *
 * - Cron (the daily 9am IST schedule): pulls fresh data for the CURRENT
 *   MONTH ONLY (month-start through today) and merges it into the
 *   cache — previous months are left untouched. This is what runs
 *   automatically every day.
 * - Manual (curl, Apps Script test call, anything hitting /api/refresh
 *   directly): does NOT pull from BigQuery by default — just rebuilds
 *   the sheet from whatever's cached. Safe to re-run while testing
 *   layout/structural code changes without re-querying BigQuery.
 * - "Force Full Refresh Now" (Config tab): pulls the FULL range from
 *   START_DATE (2026-06-01) through today, replacing the entire cache.
 *   This is the only way previous months' cached data actually gets
 *   refreshed — use it whenever you want the full history re-pulled.
 * - "Force Range Refresh Now" + Refresh Range Start/End (Config tab):
 *   pulls just that date window and merges it into the cache,
 *   independent of everything else above.
 *
 * First-ever run (no cache exists yet) always does a full pull —
 * there's nothing to render otherwise.
 */

const { fetchRows } = require('./bigquery');
const { buildDataModel } = require('./dataModel');
const { buildVerticalMatrix } = require('./verticalTabWriter');
const { buildTotalAllMatrix } = require('./totalAllWriter');
const { readTargets } = require('./targets');
const { readManualHistory } = require('./manualHistory');
const { readCache, writeCache } = require('./cache');
const { readConfig, resetConfigFlags } = require('./configSettings');
const { getSheetsClient, writeMatrix, applyRowGroups } = require('./sheets');
const { VERTICALS, SHEET_ID, START_DATE, TIMEZONE } = require('./config');

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

// Replaces any cached rows falling inside [start, end] with the freshly
// pulled rows for that window; leaves everything outside the window as-is.
function mergeRowsForRange(existingRows, freshRowsForRange, start, end) {
  const kept = (existingRows || []).filter(r => !(r.date >= start && r.date <= end));
  return kept.concat(freshRowsForRange);
}

async function runFullRefresh(isCronTrigger) {
  if (!SHEET_ID) throw new Error('Missing GOOGLE_SHEET_ID env var');

  const sheets = await getSheetsClient();
  const config = await readConfig(sheets, SHEET_ID);
  const targets = await readTargets(sheets, SHEET_ID);
  const manualHistory = await readManualHistory(sheets, SHEET_ID);

  let cache = await readCache(sheets, SHEET_ID);
  const noCacheYet = !cache;
  const today = todayISO();

  let spendRows, revRows;
  let resetFullRefresh = false, resetRangeRefresh = false;
  let pullType = 'none';

  if (config.forceFullRefresh || noCacheYet) {
    // Full history pull — replaces the entire cache.
    const fresh = await fetchRows(START_DATE, today);
    spendRows = fresh.spendRows;
    revRows = fresh.revRows;
    cache = {
      spendRows, revRows,
      lastPulledAt: new Date().toISOString(),
      cachedRangeStart: START_DATE, cachedRangeEnd: today
    };
    await writeCache(sheets, SHEET_ID, cache);
    if (config.forceFullRefresh) resetFullRefresh = true;
    pullType = 'full';
  } else if (isCronTrigger) {
    // Daily cron: current month only, merged into existing cache.
    // Previous months are left exactly as they were.
    const monthStart = currentMonthStartISO(today);
    const fresh = await fetchRows(monthStart, today);
    spendRows = mergeRowsForRange(cache.spendRows, fresh.spendRows, monthStart, today);
    revRows = mergeRowsForRange(cache.revRows, fresh.revRows, monthStart, today);
    cache.spendRows = spendRows;
    cache.revRows = revRows;
    cache.lastPulledAt = new Date().toISOString();
    cache.cachedRangeEnd = today;
    await writeCache(sheets, SHEET_ID, cache);
    pullType = 'currentMonth';
  } else {
    // Manual call, nothing forced — visual-only rebuild from cache.
    spendRows = cache.spendRows;
    revRows = cache.revRows;
  }

  if (config.forceRangeRefresh && config.rangeStart && config.rangeEnd) {
    const rangeFresh = await fetchRows(config.rangeStart, config.rangeEnd);
    spendRows = mergeRowsForRange(spendRows, rangeFresh.spendRows, config.rangeStart, config.rangeEnd);
    revRows = mergeRowsForRange(revRows, rangeFresh.revRows, config.rangeStart, config.rangeEnd);
    cache.spendRows = spendRows;
    cache.revRows = revRows;
    await writeCache(sheets, SHEET_ID, cache);
    resetRangeRefresh = true;
  }

  if (resetFullRefresh || resetRangeRefresh) {
    await resetConfigFlags(sheets, SHEET_ID, { resetFullRefresh, resetRangeRefresh });
  }

  const data = buildDataModel(spendRows, revRows);

  for (const v of VERTICALS) {
    const { matrix, groups } = buildVerticalMatrix(v, data[v.code], targets);
    await writeMatrix(sheets, SHEET_ID, v.tab, matrix);
    await applyRowGroups(sheets, SHEET_ID, v.tab, groups);
  }

  const totalAllMatrix = buildTotalAllMatrix(data, targets, manualHistory);
  await writeMatrix(sheets, SHEET_ID, 'Total All', totalAllMatrix);

  return {
    refreshedAt: new Date().toISOString(),
    trigger: isCronTrigger ? 'cron' : 'manual',
    pullType, // 'full' | 'currentMonth' | 'none'
    didRangeBigQueryPull: !!(config.forceRangeRefresh && config.rangeStart && config.rangeEnd),
    verticals: VERTICALS.map(v => v.tab)
  };
}

module.exports = { runFullRefresh };
