/**
 * lib/config.js
 * Same scope/simplifications as the Apps Script version:
 * 1. Plan/SKU rows = partner + ROUND(revenue) buckets (payout value as plan proxy).
 * 2. Device split: Desktop / Mobile / Other (tablet+unknown combined).
 * 3. Revenue/VMM Targets have no BigQuery source — read from the Targets tab.
 * 4. History starts 2026-06-01.
 */

module.exports = {
  BQ_PROJECT: 'aa-analytics-project',
  START_DATE: '2026-06-01',
  TIMEZONE: 'Asia/Kolkata',
  SHEET_ID: process.env.GOOGLE_SHEET_ID,

  VERTICALS: [
    { code: 'antivirus', tab: 'AVR', hasScorecard: true },
    { code: 'hosting', tab: 'Hosting', hasScorecard: true },
    { code: 'student-loans-refinance', tab: 'SLR', hasScorecard: true },
    { code: 'llc', tab: 'LLC', hasScorecard: true }
  ],

  SCORECARD_HEADERS: ['', 'MTD', 'RR', 'Target', '% of Target', '',
    'Last 7d Avg', 'RR based 7d', 'MTD + 7d RR', 'Avg/d to Target'],

  DEVICE_SEGMENT_MAP: { desktop: 'Desktop', mobile: 'Mobile', tablet: 'Other', unknown: 'Other' },
  SEGMENT_ORDER: ['Total', 'Desktop', 'Mobile', 'Other'],

  TOTAL_ALL_HEADERS: ['', 'Spend', 'Revenue', 'VMM', 'ROI', 'Spend RR', 'Revenue RR', 'VMM RR',
    'Revenue Target', 'VMM Target', 'Days', 'VMM Gap', 'Revenue Gap']
};
