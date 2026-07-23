/**
 * lib/configSettings.js
 * Reads the "Config" tab — a simple two-column Setting | Value sheet:
 *
 *   Force Full Refresh Now            | FALSE
 *   Refresh Range Start (YYYY-MM-DD)  |
 *   Refresh Range End (YYYY-MM-DD)    |
 *   Force Range Refresh Now           | FALSE
 *
 * Both "Force ... Now" settings are one-time triggers — check the box
 * (TRUE), run the refresh, and the script resets it back to FALSE once
 * acted on.
 */

const CONFIG_SHEET = 'Config';

function parseBool(v) {
  return String(v || '').trim().toUpperCase() === 'TRUE';
}

async function readConfig(sheets, spreadsheetId) {
  const defaults = {
    forceFullRefresh: false,
    rangeStart: '',
    rangeEnd: '',
    forceRangeRefresh: false
  };

  let values;
  try {
    const resp = await sheets.spreadsheets.values.get({ spreadsheetId, range: `'${CONFIG_SHEET}'!A:B` });
    values = resp.data.values || [];
  } catch (e) {
    return defaults; // Config tab missing — proceed with sensible defaults
  }

  const map = {};
  values.forEach(r => { if (r[0]) map[String(r[0]).trim()] = r[1]; });

  return {
    forceFullRefresh: parseBool(map['Force Full Refresh Now']),
    rangeStart: (map['Refresh Range Start (YYYY-MM-DD)'] || '').toString().trim(),
    rangeEnd: (map['Refresh Range End (YYYY-MM-DD)'] || '').toString().trim(),
    forceRangeRefresh: parseBool(map['Force Range Refresh Now'])
  };
}

// Resets the one-time trigger checkboxes back to FALSE after they've
// been acted on, so the next scheduled run doesn't re-trigger them.
async function resetConfigFlags(sheets, spreadsheetId, { resetFullRefresh, resetRangeRefresh }) {
  let values;
  try {
    const resp = await sheets.spreadsheets.values.get({ spreadsheetId, range: `'${CONFIG_SHEET}'!A:B` });
    values = resp.data.values || [];
  } catch (e) {
    return; // no Config tab — nothing to reset
  }

  for (let i = 0; i < values.length; i++) {
    const key = values[i][0];
    const rowNum = i + 1;
    if (resetFullRefresh && key === 'Force Full Refresh Now') {
      await sheets.spreadsheets.values.update({
        spreadsheetId, range: `'${CONFIG_SHEET}'!B${rowNum}`,
        valueInputOption: 'USER_ENTERED', requestBody: { values: [['FALSE']] }
      });
    }
    if (resetRangeRefresh && key === 'Force Range Refresh Now') {
      await sheets.spreadsheets.values.update({
        spreadsheetId, range: `'${CONFIG_SHEET}'!B${rowNum}`,
        valueInputOption: 'USER_ENTERED', requestBody: { values: [['FALSE']] }
      });
    }
  }
}

module.exports = { readConfig, resetConfigFlags, CONFIG_SHEET };
