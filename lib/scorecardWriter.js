/**
 * lib/scorecardWriter.js
 *
 * Sits above each month's daily tables — MTD actual, run-rate, target,
 * % of target, plus a trailing-7-day trend. Computed per month: for the
 * current in-progress month, MTD/trend are truly "as of today"; for a
 * past (completed) month, MTD = full month, and the trailing-7-day
 * window is anchored to that month's last day rather than today.
 *
 * HONESTY NOTE: reconstructed from the reference tracker's static values,
 * not its actual formulas (which I can't see). "% of Target" is verified
 * exact (= RR / Target, confirmed by matching the reference numbers).
 * "RR based 7d", "MTD + 7d RR", and "Avg/d to Target" are my best-effort,
 * internally-consistent reconstruction — compare a live run against the
 * original and flag if any column should compute differently.
 *
 * Columns: MTD | RR | Target | % of Target | (blank) | Last 7d Avg |
 *          RR based 7d | MTD + 7d RR | Avg/d to Target
 * Rows: Spend, Rev, Profit, ROI
 */

const { SCORECARD_HEADERS } = require('./config');
const {
  daysInMonth, daysElapsedInMonth, datesInMonth, lastNDaysEnding,
  isoDate, round2
} = require('./utils');

function actualsForDates(segData, dates) {
  let spend = 0, revenue = 0;
  dates.forEach(d => {
    const cell = segData[isoDate(d)];
    if (!cell) return;
    spend += (cell.google || 0) + (cell.bing || 0) + (cell.max || 0) + (cell.nb || 0);
    Object.values(cell.deals).forEach(deal => { revenue += deal.units * deal.price; });
  });
  return { spend, revenue };
}

function buildScorecardRows(vertData, targets, vertTab, monthKey) {
  const segData = (vertData && vertData['Total']) || {};

  const mtdDates = datesInMonth(monthKey);
  const mtd = actualsForDates(segData, mtdDates);
  const mtdProfit = mtd.revenue - mtd.spend;

  const daysElapsed = daysElapsedInMonth(monthKey);
  const daysInMon = daysInMonth(monthKey);
  const daysRemaining = Math.max(daysInMon - daysElapsed, 0);

  const rrSpend = daysElapsed ? (mtd.spend / daysElapsed) * daysInMon : 0;
  const rrRevenue = daysElapsed ? (mtd.revenue / daysElapsed) * daysInMon : 0;
  const rrProfit = rrRevenue - rrSpend;

  // Trailing-7-day window anchored to this month's last visible date
  // (today, for the current month; the month's actual last day, for a
  // completed past month) — not always "today".
  const anchorDate = mtdDates.length ? mtdDates[mtdDates.length - 1] : { y: 2000, m: 1, d: 1 };
  const last7 = actualsForDates(segData, lastNDaysEnding(anchorDate, 7));
  const last7AvgSpend = last7.spend / 7;
  const last7AvgRevenue = last7.revenue / 7;
  const last7AvgProfit = (last7.revenue - last7.spend) / 7;

  const rr7Spend = last7AvgSpend * daysInMon;
  const rr7Revenue = last7AvgRevenue * daysInMon;
  const rr7Profit = rr7Revenue - rr7Spend;

  const mtd7Spend = mtd.spend + last7AvgSpend * daysRemaining;
  const mtd7Revenue = mtd.revenue + last7AvgRevenue * daysRemaining;
  const mtd7Profit = mtd7Revenue - mtd7Spend;

  const tgt = targets[vertTab + '|' + monthKey] || { spendTarget: 0, revenueTarget: 0, vmmTarget: 0 };
  const spendTarget = tgt.spendTarget || 0;
  const revenueTarget = tgt.revenueTarget || 0;
  const profitTarget = revenueTarget - spendTarget;

  const rows = [];
  rows.push([vertTab + ' Scorecard - ' + monthKey + ' (Day ' + daysElapsed + ' of ' + daysInMon + ')']);
  rows.push(SCORECARD_HEADERS.slice());

  function metricRow(label, mtdVal, rrVal, targetVal, last7AvgVal, rr7Val, mtd7Val) {
    const pctOfTarget = targetVal ? rrVal / targetVal : 0;
    const avgPerDayToTarget = daysRemaining ? (targetVal - mtdVal) / daysRemaining : 0;
    return [
      label,
      round2(mtdVal), round2(rrVal), round2(targetVal), round2(pctOfTarget),
      '',
      round2(last7AvgVal), round2(rr7Val), round2(mtd7Val), round2(avgPerDayToTarget)
    ];
  }

  rows.push(metricRow('Spend', mtd.spend, rrSpend, spendTarget, last7AvgSpend, rr7Spend, mtd7Spend));
  rows.push(metricRow('Rev', mtd.revenue, rrRevenue, revenueTarget, last7AvgRevenue, rr7Revenue, mtd7Revenue));
  rows.push(metricRow('Profit', mtdProfit, rrProfit, profitTarget, last7AvgProfit, rr7Profit, mtd7Profit));

  const roiMtd = mtd.spend ? mtdProfit / mtd.spend : 0;
  const roiRR = rrSpend ? rrProfit / rrSpend : 0;
  const roiTarget = spendTarget ? profitTarget / spendTarget : 0;
  const roiLast7Avg = last7AvgSpend ? last7AvgProfit / last7AvgSpend : 0;
  const roiRR7 = rr7Spend ? rr7Profit / rr7Spend : 0;
  const roiMtd7 = mtd7Spend ? mtd7Profit / mtd7Spend : 0;
  rows.push(['ROI', roiMtd, roiRR, roiTarget, roiTarget ? roiRR / roiTarget : 0, '', roiLast7Avg, roiRR7, roiMtd7, '']);

  return rows;
}

module.exports = { buildScorecardRows };
