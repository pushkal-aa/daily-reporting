/**
 * lib/flatten.js
 * Turns raw spend/revenue rows from BigQuery into the flat
 * [Date, Vertical, Device, Type, Source, Plan Price, Units, Amount]
 * schema written to the Raw Pull tab.
 */

const { VERTICAL_LABELS, DEVICE_LABELS } = require('./config');

function round2(n) { return Math.round((n || 0) * 100) / 100; }

function titleCase(s) {
  return (s || '').split('-').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
}

function flattenRows(spendRows, revRows) {
  const out = [];

  spendRows.forEach(r => {
    const vertical = VERTICAL_LABELS[r.vertical] || r.vertical;
    const device = DEVICE_LABELS[r.deviceType] || 'Other';
    if (!r.publisher) return;
    out.push([r.date, vertical, device, 'Spend', titleCase(r.publisher), '', '', round2(parseFloat(r.cost) || 0)]);
  });

  revRows.forEach(r => {
    const vertical = VERTICAL_LABELS[r.vertical] || r.vertical;
    const device = DEVICE_LABELS[r.deviceType] || 'Other';
    const planPrice = parseFloat(r.planBucket) || 0;
    const units = parseInt(r.units, 10) || 0;
    out.push([r.date, vertical, device, 'Revenue', titleCase(r.partner), planPrice, units, round2(parseFloat(r.revenue) || 0)]);
  });

  out.sort((a, b) => {
    if (a[0] !== b[0]) return a[0] < b[0] ? -1 : 1;
    if (a[1] !== b[1]) return a[1] < b[1] ? -1 : 1;
    return 0;
  });

  return out;
}

module.exports = { flattenRows };
