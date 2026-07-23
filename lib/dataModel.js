/**
 * lib/dataModel.js
 * Same shape as the Apps Script DataModel.gs: data[vertical][segment][dateStr] = {
 *   google, bing, max, nb, deals: { 'partner@price': { price, label, units } }
 * }
 */

const { DEVICE_SEGMENT_MAP } = require('./config');

function titleCase(s) {
  return (s || '').split('-').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
}

function buildDataModel(spendRows, revRows) {
  const data = {};

  function ensure(vertical, segment, dateStr) {
    data[vertical] = data[vertical] || {};
    data[vertical][segment] = data[vertical][segment] || {};
    if (!data[vertical][segment][dateStr]) {
      data[vertical][segment][dateStr] = { google: 0, bing: 0, max: 0, nb: 0, deals: {} };
    }
    return data[vertical][segment][dateStr];
  }

  spendRows.forEach(r => {
    const { vertical, date: dateStr, publisher } = r;
    const cost = parseFloat(r.cost) || 0;
    if (!publisher) return;
    const segment = DEVICE_SEGMENT_MAP[r.deviceType] || 'Other';
    ['Total', segment].forEach(seg => {
      const cell = ensure(vertical, seg, dateStr);
      if (cell[publisher] !== undefined) cell[publisher] += cost;
    });
  });

  revRows.forEach(r => {
    const { vertical, date: dateStr, partner } = r;
    const price = parseFloat(r.planBucket) || 0;
    const units = parseInt(r.units, 10) || 0;
    const segment = DEVICE_SEGMENT_MAP[r.deviceType] || 'Other';
    const dealKey = partner + '@' + price;
    const label = titleCase(partner) + ' - $' + price;
    ['Total', segment].forEach(seg => {
      const cell = ensure(vertical, seg, dateStr);
      cell.deals[dealKey] = cell.deals[dealKey] || { price, label, units: 0 };
      cell.deals[dealKey].units += units;
    });
  });

  return data;
}

module.exports = { buildDataModel, titleCase };
