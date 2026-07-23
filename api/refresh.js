/**
 * api/refresh.js
 * Vercel serverless function. Triggered on schedule by the cron config in
 * vercel.json (9:00 AM IST daily, current month only) — that call
 * includes ?trigger=cron.
 *
 * Manual test/on-request calls (curl, Apps Script, browser console)
 * should NOT include that param — they do a full refresh from
 * 2026-06-01 through today:
 *   curl -H "Authorization: Bearer $CRON_SECRET" https://<your-app>.vercel.app/api/refresh
 *
 * CRON_SECRET is optional but recommended — without it, this endpoint is
 * publicly triggerable by anyone with the URL.
 */

const { runFullRefresh } = require('../lib/main');

module.exports = async function handler(req, res) {
  if (process.env.CRON_SECRET) {
    const auth = req.headers['authorization'];
    if (auth !== `Bearer ${process.env.CRON_SECRET}`) {
      return res.status(401).json({ ok: false, error: 'Unauthorized' });
    }
  }

  const isCronTrigger = req.query && req.query.trigger === 'cron';

  try {
    const result = await runFullRefresh(isCronTrigger);
    return res.status(200).json({ ok: true, ...result });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ ok: false, error: err.message });
  }
};
