/**
 * api/refresh.js
 * Vercel serverless function. Triggered on schedule by the cron config in
 * vercel.json (9:00 AM IST daily) — that call includes ?trigger=cron.
 *
 * AUTH FIX (2026-08-09): Vercel Cron does NOT send our custom
 * Authorization header when it triggers scheduled jobs — it verifies
 * cron requests via its own internal `x-vercel-cron` header instead.
 * Requiring CRON_SECRET on every request (including cron-triggered ones)
 * meant every single automated cron call was silently failing with 401,
 * every day, since deployment — the daily refresh never actually ran on
 * schedule. Fixed by only checking CRON_SECRET for non-cron (manual)
 * requests, and trusting Vercel's own x-vercel-cron header for the
 * scheduled path.
 *
 * Manual test calls (curl, Apps Script, browser console) still require
 * the secret, since they don't carry Vercel's internal cron header:
 *   curl -H "Authorization: Bearer $CRON_SECRET" https://<your-app>.vercel.app/api/refresh
 */

const { runFullRefresh } = require('../lib/main');

module.exports = async function handler(req, res) {
  const isCronTrigger = req.query && req.query.trigger === 'cron';
  const hasVercelCronHeader = !!req.headers['x-vercel-cron'];

  if (!isCronTrigger || !hasVercelCronHeader) {
    // Not a verified Vercel-cron request — require the manual secret.
    if (process.env.CRON_SECRET) {
      const auth = req.headers['authorization'];
      if (auth !== `Bearer ${process.env.CRON_SECRET}`) {
        return res.status(401).json({ ok: false, error: 'Unauthorized' });
      }
    }
  }

  try {
    const result = await runFullRefresh(isCronTrigger);
    return res.status(200).json({ ok: true, ...result });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ ok: false, error: err.message });
  }
};
