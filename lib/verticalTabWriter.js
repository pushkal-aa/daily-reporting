/**
 * lib/verticalTabWriter.js
 * Builds one vertical's full tab content as a 2D array (matrix), which
 * gets written to the sheet in a single values.update call. Formula
 * strings reference cells by row/column position within this same
 * matrix, so they line up once written.
 */

const { SEGMENT_ORDER } = require('./config');
const {
  listMonths, monthLabel, datesInMonth, activePublishers, activeDeals,
  sumPublisherSpend, columnLetter, round2, titleCase, isoDate, formatDM, weekdayShort
} = require('./utils');
const { buildScorecardRows } = require('./scorecardWriter');

function buildVerticalMatrix(vertConfig, vertData, targets) {
  vertData = vertData || {};
  targets = targets || {};
  const months = listMonths(vertData);
  const publishers = activePublishers(vertData);
  const rows = [];
  const groups = []; // {startRow, endRow, collapsed} — 1-indexed, inclusive

  months.forEach((monthKey, idx) => {
    const isMostRecentMonth = idx === months.length - 1;

    // Ungrouped marker row — stays visible even when the month collapses,
    // matching the reference's pattern of one visible "month start" row
    // per collapsed block.
    rows.push([monthLabel(monthKey)]);
    const groupStart = rows.length + 1;

    if (vertConfig.hasScorecard) {
      buildScorecardRows(vertData, targets, vertConfig.tab, monthKey).forEach(r => rows.push(r));
      rows.push([]);
      rows.push([]);
    }

    SEGMENT_ORDER.forEach(segment => {
      const segData = vertData[segment] || {};
      const dates = datesInMonth(monthKey);
      const deals = activeDeals(segData, dates);
      const spend = sumPublisherSpend(segData, dates, publishers);

      if (deals.length === 0 && spend === 0) return; // nothing to show

      appendBlock(rows, vertConfig.tab + ' - ' + segment + ' (' + monthLabel(monthKey) + ')',
        dates, segData, publishers, deals);
      rows.push([]);
      rows.push([]); // spacer between blocks
    });

    const groupEnd = rows.length;
    if (groupEnd >= groupStart) {
      groups.push({ startRow: groupStart, endRow: groupEnd, collapsed: !isMostRecentMonth });
    }
  });

  return { matrix: rows, groups };
}

function appendBlock(rows, title, dates, segData, publishers, deals) {
  const firstDateCol = 3; // column C (A=label, B=Deal price)

  const titleRow = [title, ''];
  dates.forEach(d => titleRow.push(weekdayShort(d)));
  rows.push(titleRow);

  const dateRow = ['Date', 'Deal'];
  dates.forEach(d => dateRow.push(formatDM(d)));
  rows.push(dateRow);

  const spendRowStart = rows.length + 1;
  publishers.forEach(pub => {
    const row = [titleCase(pub) + ' Spend', ''];
    dates.forEach(d => {
      const val = (segData[isoDate(d)] && segData[isoDate(d)][pub]) || 0;
      row.push(round2(val));
    });
    rows.push(row);
  });
  const spendRowEnd = rows.length;

  const totalSpendRow = rows.length + 1;
  const totalRow = ['Total Spend', ''];
  dates.forEach((d, i) => {
    const col = columnLetter(firstDateCol + i);
    totalRow.push(spendRowEnd >= spendRowStart ? '=SUM(' + col + spendRowStart + ':' + col + spendRowEnd + ')' : 0);
  });
  rows.push(totalRow);

  const dealRowStart = rows.length + 1;
  deals.forEach(deal => {
    const row = [deal.label, deal.price];
    dates.forEach(d => {
      const dealCell = segData[isoDate(d)] && segData[isoDate(d)].deals[deal.key];
      row.push(dealCell ? dealCell.units : 0);
    });
    rows.push(row);
  });
  const dealRowEnd = rows.length;

  const revenueRow = rows.length + 1;
  const revRow = ['Revenue', ''];
  dates.forEach((d, i) => {
    const col = columnLetter(firstDateCol + i);
    revRow.push(dealRowEnd >= dealRowStart
      ? '=SUMPRODUCT($B$' + dealRowStart + ':$B$' + dealRowEnd + ',' + col + dealRowStart + ':' + col + dealRowEnd + ')'
      : 0);
  });
  rows.push(revRow);

  const profitRow = rows.length + 1;
  const pRow = ['Profit', ''];
  dates.forEach((d, i) => {
    const col = columnLetter(firstDateCol + i);
    pRow.push('=' + col + revenueRow + '-' + col + totalSpendRow);
  });
  rows.push(pRow);

  const roiRow = ['ROI', ''];
  dates.forEach((d, i) => {
    const col = columnLetter(firstDateCol + i);
    roiRow.push('=IF(' + col + totalSpendRow + '=0,0,' + col + profitRow + '/' + col + totalSpendRow + ')');
  });
  rows.push(roiRow);
}

module.exports = { buildVerticalMatrix };
