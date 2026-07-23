/**
 * lib/utils.js — plain-JS ports of the Apps Script date/column helpers.
 * Dates are handled as calendar dates (y, m, d) throughout; no timezone
 * math needed for the day arithmetic itself. "Today" for capping the
 * current month is computed specifically in Asia/Kolkata so the cap is
 * correct regardless of the server's own timezone (Vercel runs UTC).
 */

const { TIMEZONE } = require('./config');

function round2(n) { return Math.round((n || 0) * 100) / 100; }

function columnLetter(col) {
  let letter = '';
  while (col > 0) {
    const rem = (col - 1) % 26;
    letter = String.fromCharCode(65 + rem) + letter;
    col = Math.floor((col - 1) / 26);
  }
  return letter;
}

function todayInTZ() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: TIMEZONE, year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(new Date());
  const map = {};
  parts.forEach(p => { map[p.type] = p.value; });
  return { year: parseInt(map.year, 10), month: parseInt(map.month, 10), day: parseInt(map.day, 10) };
}

function monthKeyOf(dateStr) { return dateStr.substring(0, 7); }

function monthLabel(monthKey) {
  const [y, m] = monthKey.split('-').map(Number);
  const names = ['January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December'];
  return names[m - 1] + ' ' + y;
}

function daysInMonth(monthKey) {
  const [y, m] = monthKey.split('-').map(Number);
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

// All calendar dates in the month as {y,m,d} objects, capped at "today"
// (Asia/Kolkata) for the current month.
function datesInMonth(monthKey) {
  const [y, m] = monthKey.split('-').map(Number);
  const totalDays = daysInMonth(monthKey);
  const today = todayInTZ();
  const isCurrentMonth = (today.year === y && today.month === m);
  const lastDay = isCurrentMonth ? today.day : totalDays;
  const dates = [];
  for (let d = 1; d <= lastDay; d++) dates.push({ y, m, d });
  return dates;
}

function daysElapsedInMonth(monthKey) { return datesInMonth(monthKey).length; }

function isoDate({ y, m, d }) {
  return y + '-' + String(m).padStart(2, '0') + '-' + String(d).padStart(2, '0');
}

function formatDM({ m, d }) { return d + '.' + m; }

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
function weekdayShort({ y, m, d }) {
  return WEEKDAYS[new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
}

function listMonths(vertData) {
  const keys = {};
  Object.keys(vertData || {}).forEach(segment => {
    Object.keys(vertData[segment]).forEach(dateStr => { keys[monthKeyOf(dateStr)] = true; });
  });
  return Object.keys(keys).sort();
}

function listMonthsAcrossVerticals(data) {
  const keys = {};
  Object.keys(data || {}).forEach(vertical => {
    listMonths(data[vertical]).forEach(mk => { keys[mk] = true; });
  });
  return Object.keys(keys).sort();
}

function activePublishers(vertData) {
  const totals = (vertData && vertData['Total']) || {};
  const found = { google: false, bing: false, max: false, nb: false };
  Object.keys(totals).forEach(dateStr => {
    const cell = totals[dateStr];
    Object.keys(found).forEach(p => { if (cell[p]) found[p] = true; });
  });
  return Object.keys(found).filter(p => found[p]);
}

function activeDeals(segData, dates) {
  const totals = {};
  dates.forEach(d => {
    const dateStr = isoDate(d);
    const cell = segData[dateStr];
    if (!cell) return;
    Object.keys(cell.deals).forEach(key => {
      const deal = cell.deals[key];
      totals[key] = totals[key] || { key, label: deal.label, price: deal.price, revenue: 0 };
      totals[key].revenue += deal.units * deal.price;
    });
  });
  return Object.values(totals).sort((a, b) => b.revenue - a.revenue);
}

function sumPublisherSpend(segData, dates, publishers) {
  let sum = 0;
  dates.forEach(d => {
    const cell = segData[isoDate(d)];
    if (!cell) return;
    publishers.forEach(p => { sum += cell[p] || 0; });
  });
  return sum;
}

function titleCase(s) {
  return (s || '').split('-').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
}

module.exports = {
  round2, columnLetter, todayInTZ, monthKeyOf, monthLabel, daysInMonth, datesInMonth,
  daysElapsedInMonth, isoDate, formatDM, weekdayShort, listMonths, listMonthsAcrossVerticals,
  activePublishers, activeDeals, sumPublisherSpend, titleCase
};
