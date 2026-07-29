/**
 * lib/bigquery.js
 * Requires GOOGLE_SERVICE_ACCOUNT_KEY env var — the full JSON key for a
 * service account with BigQuery Data Viewer + BigQuery Job User on
 * aa-analytics-project.
 *
 * REVENUE QUERY — as of 2026-07-30:
 *
 * - Attributed by CONVERSION date (c.date), NOT click date. Reverted from
 *   a brief click-date experiment (which joined to the `clicks` table) —
 *   back to conversions.date directly, per instruction.
 *
 * - Reversed sales are excluded. Reversals are NOT an in-place status
 *   update on the original 'sale' row — they're a SEPARATE row with
 *   type='reversal_sale', linked back via reversesConversionId. The
 *   original 'sale' row keeps its own approvalStatus unchanged (often
 *   still 'pending'), so filtering on just `approvalStatus != 'reversed'`
 *   was letting every reversed sale's full revenue through uncontested.
 *   Fixed via a NOT EXISTS anti-join against any reversal_sale row
 *   referencing this conversion. This fix stays in place regardless of
 *   which date axis is used.
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
       c.date,
       c.vertical, c.deviceType, c.country, c.publisher, c.partnerId AS partner,
       ROUND(c.revenue) AS planBucket, COUNT(*) AS units, SUM(c.revenue) AS revenue, c.segment
FROM \`${BQ_PROJECT}.analytics.conversions\` c
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
  AND c.date >= '${startDate}' AND c.date <= '${endDate}'
GROUP BY 1,2,3,4,5,6,7,10`;
}

// Reversals — pulled separately so they can show up as their own Type
// in Raw Pull, distinct from Revenue. Same conversion-date axis as
// revenueQuery for consistency.
function reversalsQuery(startDate, endDate) {
  return `SELECT
       c.date,
       c.vertical, c.deviceType, c.country, c.publisher, c.partnerId AS partner,
       ROUND(c.revenue) AS planBucket, COUNT(*) AS units, SUM(c.revenue) AS revenue, c.segment
FROM \`${BQ_PROJECT}.analytics.conversions\` c
WHERE c.type = 'reversal_sale' AND c.approvalStatus = 'reversed'
  AND c.vertical IN ('antivirus','hosting','llc','student-loans-refinance')
  AND c.date >= '${startDate}' AND c.date <= '${endDate}'
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
  const [reversalRows] = await bq.query({ query: reversalsQuery(startDate, endDate) });
  return {
    spendRows: spendRows.map(r => ({ ...r, date: dateStrOf(r.date) })),
    revRows: revRows.map(r => ({ ...r, date: dateStrOf(r.date) })),
    reversalRows: reversalRows.map(r => ({ ...r, date: dateStrOf(r.date) }))
  };
}

module.exports = { fetchRows };
