/**
 * lib/targets.js
 * Reads the manually-edited Targets tab: Vertical | Month (YYYY-MM) |
 * Spend Target | Revenue Target
 *
 * Spend Target is needed for the SLR/LLC scorecard block (Target/% of
 * Target columns for Spend). VMM Target = Revenue Target - Spend Target,
 * derived automatically — no separate VMM Target column needed anymore.
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
    spendTarget: headers.indexOf('Spend Target'),
    revenueTarget: headers.indexOf('Revenue Target')
  };

  const targets = {};
  values.slice(1).forEach(r => {
    if (!r[idx.vertical] || !r[idx.month]) return;
    const key = String(r[idx.vertical]).trim() + '|' + String(r[idx.month]).trim();
    const spendTarget = parseFloat(r[idx.spendTarget]) || 0;
    const revenueTarget = parseFloat(r[idx.revenueTarget]) || 0;
    targets[key] = {
      spendTarget,
      revenueTarget,
      vmmTarget: revenueTarget - spendTarget
    };
  });
  return targets;
}

module.exports = { readTargets };
