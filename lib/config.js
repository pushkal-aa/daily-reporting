/**
 * lib/config.js
 *
 * Scope: this app's ONLY job is to pull raw spend + conversion data from
 * BigQuery and write it as a flat table into the "Raw Pull" tab. All
 * calculations, formatting, monthly blocks, scorecards, targets, etc.
 * live in Google Sheets formulas built by hand — not this code.
 */

module.exports = {
  BQ_PROJECT: 'aa-analytics-project',
  START_DATE: '2026-06-01', // Raw Pull never includes anything before this
  TIMEZONE: 'Asia/Kolkata',
  SHEET_ID: process.env.GOOGLE_SHEET_ID,
  RAW_SHEET: 'Raw Pull',

  // BigQuery vertical code -> the tab name you actually use.
  VERTICAL_LABELS: {
    'antivirus': 'AVR',
    'hosting': 'Hosting',
    'student-loans-refinance': 'SLR',
    'llc': 'LLC'
  },

  DEVICE_LABELS: { desktop: 'Desktop', mobile: 'Mobile', tablet: 'Other', unknown: 'Other' },

  RAW_HEADERS: ['Date', 'Vertical', 'Device', 'Type', 'Source', 'Plan Price', 'Units', 'Amount']
};
