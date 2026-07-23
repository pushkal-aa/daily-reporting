/**
 * lib/totalAllWriter.js
 * Monthly summary block per vertical + YTD summary, built as a matrix.
 * `targets` is a map keyed 'VertTab|yyyy-MM' -> {revenueTarget, vmmTarget},
 * read from the Targets tab by lib/targets.js before calling this.
 */

const { VERTICALS, TOTAL_ALL_HEADERS, START_DATE } = require('./config');
const {
  listMonthsAcrossVerticals, monthLabel, daysInMonth, daysElapsedInMonth,
  datesInMonth, columnLetter, round2, isoDate
} = require('./utils');

function monthActuals(data, vertCode, monthKey) {
  const segData = (data[vertCode] && data[vertCode]['Total']) || {};
  const dates = datesInMonth(monthKey);
  let spend = 0, revenue = 0;
  dates.forEach(d => {
    const cell = segData[isoDate(d)];
    if (!cell) return;
    spend += (cell.google || 0) + (cell.bing || 0) + (cell.max || 0) + (cell.nb || 0);
    Object.values(cell.deals).forEach(deal => { revenue += deal.units * deal.price; });
  });
  return { spend, revenue };
}

function buildTotalAllMatrix(data, targets) {
  const rows = [];
  const months = listMonthsAcrossVerticals(data);
  const ytd = {};
  VERTICALS.forEach(v => { ytd[v.tab] = { spend: 0, revenue: 0 }; });

  months.forEach(monthKey => {
    rows.push([monthLabel(monthKey)]);
    rows.push(TOTAL_ALL_HEADERS.slice());

    const blockStart = rows.length + 1;
    const daysInMon = daysInMonth(monthKey);
    const daysElapsed = daysElapsedInMonth(monthKey);

    VERTICALS.forEach(v => {
      const actuals = monthActuals(data, v.code, monthKey);
      const vmm = actuals.revenue - actuals.spend;
      const roi = actuals.spend ? vmm / actuals.spend : 0;
      const spendRR = daysElapsed ? (actuals.spend / daysElapsed) * daysInMon : 0;
      const revenueRR = daysElapsed ? (actuals.revenue / daysElapsed) * daysInMon : 0;
      const vmmRR = revenueRR - spendRR;
      const tgt = targets[v.tab + '|' + monthKey] || { revenueTarget: 0, vmmTarget: 0 };
      const vmmGap = vmmRR - tgt.vmmTarget;
      const revenueGap = revenueRR - tgt.revenueTarget;

      rows.push([
        v.tab, round2(actuals.spend), round2(actuals.revenue), round2(vmm), roi,
        round2(spendRR), round2(revenueRR), round2(vmmRR),
        tgt.revenueTarget, tgt.vmmTarget, daysElapsed, round2(vmmGap), round2(revenueGap)
      ]);

      ytd[v.tab].spend += actuals.spend;
      ytd[v.tab].revenue += actuals.revenue;
    });

    const totalRowNum = rows.length + 1;
    const totalRow = ['Total'];
    for (let c = 2; c <= 13; c++) {
      const colLetter = columnLetter(c);
      if (c === 5) {
        totalRow.push('=IF(' + columnLetter(2) + totalRowNum + '=0,0,' + columnLetter(4) + totalRowNum + '/' + columnLetter(2) + totalRowNum + ')');
      } else {
        totalRow.push('=SUM(' + colLetter + blockStart + ':' + colLetter + (totalRowNum - 1) + ')');
      }
    }
    rows.push(totalRow);
    rows.push([]);
    rows.push([]);
  });

  rows.push(['YTD (since ' + START_DATE + ')']);
  rows.push(['', 'Spend', 'Revenue', 'VMM', 'ROI']);
  const ytdBlockStart = rows.length + 1;

  VERTICALS.forEach(v => {
    const spend = round2(ytd[v.tab].spend), revenue = round2(ytd[v.tab].revenue);
    const vmm = round2(revenue - spend);
    const roi = spend ? vmm / spend : 0;
    rows.push([v.tab, spend, revenue, vmm, roi]);
  });

  const ytdTotalRowNum = rows.length + 1;
  const ytdTotalRow = ['Total'];
  for (let c = 2; c <= 4; c++) {
    const colLetter = columnLetter(c);
    ytdTotalRow.push('=SUM(' + colLetter + ytdBlockStart + ':' + colLetter + (ytdTotalRowNum - 1) + ')');
  }
  ytdTotalRow.push('=IF(B' + ytdTotalRowNum + '=0,0,D' + ytdTotalRowNum + '/B' + ytdTotalRowNum + ')');
  rows.push(ytdTotalRow);

  return rows;
}

module.exports = { buildTotalAllMatrix };
