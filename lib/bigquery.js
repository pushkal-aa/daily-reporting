/**
 * lib/bigquery.js
 * Requires GOOGLE_SERVICE_ACCOUNT_KEY env var — the full JSON key for a
 * service account with BigQuery Data Viewer + BigQuery Job User on
 * aa-analytics-project.
 *
 * REVENUE QUERY — two important fixes as of 2026-07-29:
 *
 * 1. Attributed by CLICK date, not conversion date. `conversions.date` is
 *    documented as the conversion event date, NOT click date — the true
 *    click date requires joining clickId back to the `clicks` table.
 *    This matters because Spend (from campaigns_attributed_daily) is
 *    inherently click-date attributed; Revenue needs to match that same
 *    axis for day-level ROI to mean anything. LEFT JOIN (not INNER) so a
 *    conversion with no matching click row still gets included, falling
 *    back to its own conversion date rather than being silently dropped.
 *
 * 2. Reversed sales are now properly excluded. Reversals are NOT an
 *    in-place status update on the original 'sale' row — they're a
 *    SEPARATE row with type='reversal_sale', linked back via
 *    reversesConversionId. The original 'sale' row keeps its own
 *    approvalStatus unchanged (often still 'pending'), so filtering on
 *    just `approvalStatus != 'reversed'` was letting every reversed
 *    sale's full revenue through uncontested. Fixed via a NOT EXISTS
 *    anti-join against any reversal_sale row referencing this conversion.
 */

const { BigQuery } = require('@google-cloud/bigquery');
const { BQ_PROJECT } = require('./config');

function getCredentials() {
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_KEY;
  if (!raw) throw new Error('Missing GOOGLE_SERVICE_ACCOUNT_KEY env var');
  return JSON.parse(raw);
}

function getClient() {
  return new BigQuery({ projectId: BQ_PROJECT, credentials: getCredentials() });
}

function spendQuery(startDate, endDate) {
  return `SELECT date, vertical, deviceType, country, publisher, segment, SUM(cost) AS cost
FROM \`${BQ_PROJECT}.analytics.campaigns_attributed_daily\`
WHERE vertical IN ('antivirus','hosting','llc','student-loans-refinance')
  AND date >= '${startDate}' AND date <= '${endDate}'
GROUP BY 1,2,3,4,5,6`;
}

function revenueQuery(startDate, endDate) {
  return `SELECT
       COALESCE(cl.date, c.date) AS date,
       c.vertical, c.deviceType, c.country, c.publisher, c.partnerId AS partner,
       ROUND(c.revenue) AS planBucket, COUNT(*) AS units, SUM(c.revenue) AS revenue, c.segment
FROM \`${BQ_PROJECT}.analytics.conversions\` c
LEFT JOIN \`${BQ_PROJECT}.analytics.clicks\` cl
  ON c.clickId = cl.clickId
LEFT JOIN \`${BQ_PROJECT}.analytics.partner_conversion_config\` cfg
  ON c.partnerId = cfg.partner AND c.type = cfg.conversionType
LEFT JOIN (SELECT DISTINCT partner FROM \`${BQ_PROJECT}.analytics.partner_conversion_config\`) hc
  ON c.partnerId = hc.partner
WHERE (cfg.partner IS NOT NULL OR (hc.partner IS NULL AND c.type = 'sale'))
  AND c.approvalStatus != 'reversed'
  AND NOT EXISTS (
    SELECT 1 FROM \`${BQ_PROJECT}.analytics.conversions\` r
    WHERE r.reversesConversionId = c.conversionId AND r.type = 'reversal_sale'
  )
  AND c.vertical IN ('antivirus','hosting','llc','student-loans-refinance')
  AND COALESCE(cl.date, c.date) >= '${startDate}' AND COALESCE(cl.date, c.date) <= '${endDate}'
GROUP BY 1,2,3,4,5,6,7,10`;
}

// BigQuery's Node client wraps DATE columns as { value: 'yyyy-MM-dd' }
function dateStrOf(field) {
  return (field && typeof field === 'object' && 'value' in field) ? field.value : field;
}

// startDate/endDate: 'yyyy-MM-dd' strings, inclusive.
async function fetchRows(startDate, endDate) {
  const bq = getClient();
  const [spendRows] = await bq.query({ query: spendQuery(startDate, endDate) });
  const [revRows] = await bq.query({ query: revenueQuery(startDate, endDate) });
  return {
    spendRows: spendRows.map(r => ({ ...r, date: dateStrOf(r.date) })),
    revRows: revRows.map(r => ({ ...r, date: dateStrOf(r.date) }))
  };
}

module.exports = { fetchRows };
