/**
 * lib/flatten.js
 * Turns raw spend/revenue rows from BigQuery into the flat
 * [Date, Vertical, Geo, Device, Type, Publisher, Brand, Plan Price, Units, Amount]
 * schema written to the Raw Pull tab.
 *
 * Publisher = ad platform (Google/Bing), populated for BOTH Spend and
 * Revenue rows. Brand = blank for Spend rows, partner name for Revenue
 * rows. This lets a single Geo+Device+Publisher filter apply cleanly to
 * both spend and conversions for the same segment (e.g. "US Google Desktop").
 */

const { VERTICAL_LABELS, DEVICE_LABELS } = require('./config');

function round2(n) { return Math.round((n || 0) * 100) / 100; }

function titleCase(s) {
  return (s || '').split('-').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
}

// Same bucketing convention already locked in elsewhere: US+CA -> "US",
// GB -> "UK", everything else -> "WE". Missing/null country AND the
// literal string "unknown" (BigQuery uses this as an actual value, not
// just null — confirmed via a distinct-values check) both get their own
// "Unknown" bucket rather than silently folding into "WE".
function geoLabel(country) {
  if (!country || String(country).trim().toLowerCase() === 'unknown') return 'Unknown';
  if (country === 'US' || country === 'CA') return 'US';
  if (country === 'GB') return 'UK';
  return 'WE';
}

function flattenRows(spendRows, revRows) {
  const out = [];

  spendRows.forEach(r => {
    const vertical = VERTICAL_LABELS[r.vertical] || r.vertical;
    const device = DEVICE_LABELS[r.deviceType] || 'Other';
    const geo = geoLabel(r.country);
    if (!r.publisher) return;
    out.push([r.date, vertical, geo, device, 'Spend', titleCase(r.publisher), '', '', '', round2(parseFloat(r.cost) || 0)]);
  });

  revRows.forEach(r => {
    const vertical = VERTICAL_LABELS[r.vertical] || r.vertical;
    const device = DEVICE_LABELS[r.deviceType] || 'Other';
    const geo = geoLabel(r.country);
    const publisher = r.publisher ? titleCase(r.publisher) : '';
    const planPrice = parseFloat(r.planBucket) || 0;
    const units = parseInt(r.units, 10) || 0;
    out.push([r.date, vertical, geo, device, 'Revenue', publisher, titleCase(r.partner), planPrice, units, round2(parseFloat(r.revenue) || 0)]);
  });

  out.sort((a, b) => {
    if (a[0] !== b[0]) return a[0] < b[0] ? -1 : 1;
    if (a[1] !== b[1]) return a[1] < b[1] ? -1 : 1;
    return 0;
  });

  return out;
}

module.exports = { flattenRows };
