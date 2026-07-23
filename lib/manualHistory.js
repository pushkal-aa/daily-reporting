/**
 * lib/manualHistory.js
 * Reads the "Manual History" tab — a simple, hand-maintained table for
 * months BigQuery has no spend data for (Feb-May 2026, before the
 * campaigns_attributed_daily table starts on 2026-06-01).
 *
 * Expected columns: Vertical | Month (YYYY-MM) | Spend | Revenue
 * One row per vertical per month. Fill this in once from your separate
 * historical pull — the script does not touch this tab, only reads it.
 */

async function readManualHistory(sheets, spreadsheetId) {
  let values;
  try {
    const resp = await sheets.spreadsheets.values.get({ spreadsheetId, range: 'Manual History!A:D' });
    values = resp.data.values || [];
  } catch (e) {
    return {}; // tab missing — proceed with no manual history
  }
  if (values.length < 2) return {};

  const headers = values[0].map(h => (h || '').toString().trim());
  const idx = {
    vertical: headers.indexOf('Vertical'),
    month: headers.indexOf('Month (YYYY-MM)'),
    spend: headers.indexOf('Spend'),
    revenue: headers.indexOf('Revenue')
  };

  const history = {};
  values.slice(1).forEach(r => {
    if (!r[idx.vertical] || !r[idx.month]) return;
    const key = String(r[idx.vertical]).trim() + '|' + String(r[idx.month]).trim();
    history[key] = {
      spend: parseFloat(r[idx.spend]) || 0,
      revenue: parseFloat(r[idx.revenue]) || 0
    };
  });
  return history;
}

module.exports = { readManualHistory };
