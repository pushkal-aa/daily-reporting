/**
 * lib/bigquery.js
 * Requires GOOGLE_SERVICE_ACCOUNT_KEY env var — the full JSON key for a
 * service account with BigQuery Data Viewer + BigQuery Job User on
 * aa-analytics-project.
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
  return `SELECT date, vertical, deviceType, country, publisher, SUM(cost) AS cost
FROM \`${BQ_PROJECT}.analytics.campaigns_attributed_daily\`
WHERE vertical IN ('antivirus','hosting','llc','student-loans-refinance')
  AND date >= '${startDate}' AND date <= '${endDate}'
GROUP BY 1,2,3,4,5`;
}

function revenueQuery(startDate, endDate) {
  return `SELECT c.date, c.vertical, c.deviceType, c.country, c.publisher, c.partnerId AS partner,
       ROUND(c.revenue) AS planBucket, COUNT(*) AS units, SUM(c.revenue) AS revenue
FROM \`${BQ_PROJECT}.analytics.conversions\` c
LEFT JOIN \`${BQ_PROJECT}.analytics.partner_conversion_config\` cfg
  ON c.partnerId = cfg.partner AND c.type = cfg.conversionType
LEFT JOIN (SELECT DISTINCT partner FROM \`${BQ_PROJECT}.analytics.partner_conversion_config\`) hc
  ON c.partnerId = hc.partner
WHERE (cfg.partner IS NOT NULL OR (hc.partner IS NULL AND c.type = 'sale'))
  AND c.approvalStatus != 'reversed'
  AND c.vertical IN ('antivirus','hosting','llc','student-loans-refinance')
  AND c.date >= '${startDate}' AND c.date <= '${endDate}'
GROUP BY 1,2,3,4,5,6,7`;
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
