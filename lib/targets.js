/**
 * lib/targets.js
 * Reads the manually-edited Targets tab: Vertical | Month (YYYY-MM) |
 * Revenue Target | VMM Target — same layout as the Apps Script version.
 */

async function readTargets(sheets, spreadsheetId) {
  let values;
  try {
    const resp = await sheets.spreadsheets.values.get({ spreadsheetId, range: 'Targets!A:D' });
    values = resp.data.values || [];
  } catch (e) {
    return {}; // Targets tab missing or empty — proceed with no targets
  }
  if (values.length < 2) return {};

  const headers = values[0].map(h => (h || '').toString().trim());
  const idx = {
    vertical: headers.indexOf('Vertical'),
    month: headers.indexOf('Month (YYYY-MM)'),
    revenueTarget: headers.indexOf('Revenue Target'),
    vmmTarget: headers.indexOf('VMM Target')
  };

  const targets = {};
  values.slice(1).forEach(r => {
    if (!r[idx.vertical] || !r[idx.month]) return;
    const key = String(r[idx.vertical]).trim() + '|' + String(r[idx.month]).trim();
    targets[key] = {
      revenueTarget: parseFloat(r[idx.revenueTarget]) || 0,
      vmmTarget: parseFloat(r[idx.vmmTarget]) || 0
    };
  });
  return targets;
}

module.exports = { readTargets };
