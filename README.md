# Aries BigQuery Tracker — Vercel Refresh Job

Replaces the Apps Script trigger: a Vercel serverless function, on a daily
cron, pulls from BigQuery and rewrites the Total All / AVR / Hosting / SLR /
LLC tabs in your existing Google Sheet.

**This does not replace the Google Sheet** — it's the "engine" that keeps
it updated. The Sheet itself is still where you read the numbers and edit
the Targets tab.

## 1. Create a GCP service account

In the same GCP project as your BigQuery data (`aa-analytics-project`), or
one with cross-project query permission:

1. IAM & Admin → Service Accounts → Create Service Account.
2. Grant it these roles on `aa-analytics-project`:
   - `BigQuery Data Viewer`
   - `BigQuery Job User`
3. Keys tab → Add Key → Create new key → JSON. Download it.
4. Enable the **Google Sheets API** on this same GCP project (APIs & Services → Library).

## 2. Share the Sheet with the service account

Open the JSON key file, find `client_email` (looks like
`something@your-project.iam.gserviceaccount.com`). Share your Google Sheet
with that email address as an **Editor** — same as sharing with a person.

## 3. Push this repo to GitHub

```
git init
git add .
git commit -m "Initial commit"
git remote add origin <your-github-repo-url>
git push -u origin main
```

## 4. Import into Vercel

1. vercel.com → Add New → Project → import the GitHub repo.
2. Before first deploy, add these Environment Variables (Project Settings → Environment Variables):
   - `GOOGLE_SERVICE_ACCOUNT_KEY` — paste the **entire contents** of the JSON key file as one value.
   - `GOOGLE_SHEET_ID` — the ID from your Sheet's URL: `docs.google.com/spreadsheets/d/`**`THIS_PART`**`/edit`
   - `CRON_SECRET` — any random string you make up (protects the endpoint from random triggering).
3. Deploy.

## 5. Test it manually before trusting the cron

```
curl -H "Authorization: Bearer <your CRON_SECRET>" https://<your-app>.vercel.app/api/refresh
```

Should return `{"ok": true, "refreshedAt": "...", "verticals": ["AVR","Hosting","SLR","LLC"]}`.
Check the Sheet to confirm the tabs populated. Check Vercel's function logs
if it fails — most likely causes are a missing/incorrect env var or the
Sheet not being shared with the service account.

## 6. Cron schedule

`vercel.json` has `"schedule": "30 3 * * *"` — 3:30 AM UTC = 9:00 AM IST
(India has no DST, so this offset is fixed year-round). Vercel Cron Jobs
call the `/api/refresh` path directly — no `Authorization` header is sent
by Vercel's own cron trigger, so if you set `CRON_SECRET`, Vercel's
built-in cron will actually be blocked by your own check. Vercel instead
signs cron requests with a `x-vercel-cron` header automatically — for
simplicity, either:
  (a) drop the `CRON_SECRET` check entirely and rely on the URL being
      unguessable + not linked anywhere, or
  (b) look up Vercel's current cron-verification approach in their docs,
      since this may have changed — check https://vercel.com/docs/cron-jobs
      for whatever's current, as this is exactly the kind of detail that
      shifts between platform versions.

## 7. Function timeout

`vercel.json` sets `maxDuration: 60` for the refresh function (BigQuery
queries + several Sheets API calls can take a bit). Some Vercel plans cap
this lower by default — if you see timeout errors in the logs, check your
plan's function duration limits and adjust.

## Targets tab

Columns: `Vertical | Month (YYYY-MM) | Spend Target | Revenue Target`
VMM Target is derived automatically (Revenue Target - Spend Target) —
no separate VMM Target column needed.

## Monthly collapsing (AVR/Hosting/SLR/LLC tabs)

Matches the reference tracker: each month's full block (all device
segments together) sits under a single visible month-marker row, and is
collapsed by default via a Google Sheets row group — except the most
recent month, which stays expanded. When the calendar rolls into a new
month, the previous month's group collapses automatically on the next
refresh and the new month's block appears below, expanded.

**Confidence note:** the row-grouping/collapsing calls
(`addDimensionGroup`/`updateDimensionGroup` in `lib/sheets.js`) are my
best understanding of the Sheets API v4 shape — I can't execute this
myself to confirm before you run it. If grouping doesn't apply cleanly
on the first real run, check the Vercel function logs for the specific
error and we'll adjust.

## Config tab

Add a tab named exactly `Config` — two columns, `Setting | Value`:

```
Force Full Refresh Now            | FALSE
Refresh Range Start (YYYY-MM-DD)  |
Refresh Range End (YYYY-MM-DD)    |
Force Range Refresh Now           | FALSE
```

- **Force Full Refresh Now** — check to TRUE to force a fresh BigQuery
  pull on the next run, even if it's a manual (non-cron) call. Resets to
  FALSE automatically once acted on.
- **Refresh Range Start/End** + **Force Range Refresh Now** — pulls just
  that date window from BigQuery and merges it into the cache (replacing
  cached rows in that window only, leaving everything else untouched).
  Independent of everything else. Resets to FALSE once acted on.

## Refresh behavior: cron vs. manual vs. forced

- **The daily cron** (9:00 AM IST) pulls fresh data for the **current
  month only** (month-start through today) and merges it into the
  cache. Previous months are left exactly as they were — the cron never
  touches them.
- **Manual calls** — curl, the Apps Script test snippet, browser console,
  anything hitting `/api/refresh` directly without the cron's special
  query param — do **not** pull from BigQuery at all by default. They
  just rebuild the sheet (layout, formulas, structure) from whatever's
  already cached. This is the mode for testing code changes: edit files
  in GitHub, push, re-run the same test call, see the new layout — no
  BigQuery cost, no re-pull.
- **Force Full Refresh Now** (Config tab) — the only thing that re-pulls
  the *entire* history from `START_DATE` (2026-06-01) through today,
  replacing the whole cache. Use this whenever you actually want previous
  months' data refreshed (e.g. after a late correction upstream).
- **Force Range Refresh Now** + Refresh Range Start/End (Config tab) —
  pulls just that specific window and merges it in, independent of
  everything else.
- The **first-ever run** always does a full pull (nothing cached yet to
  render from).

The cache lives in an auto-created `Data Cache` tab (safe to ignore or
hide — the script manages it, don't edit it by hand).

**Confidence note:** the cron path includes `?trigger=cron` in
`vercel.json` so the endpoint can tell cron calls apart from manual
ones — I believe Vercel Cron just does a plain HTTP GET to whatever path
you configure (query string included), but I haven't been able to
execute this myself to confirm. If the daily cron run isn't behaving as
expected, check the Vercel function logs for the `trigger` and `pullType`
values in the response and we'll adjust.

## Scorecard block (all four vertical tabs, every month)

Every month's block, on every vertical tab (AVR/Hosting/SLR/LLC), starts
with a scorecard: MTD actual, run-rate, target, % of target, plus a
trailing-7-day trend. For the current in-progress month this is a true
"as of today" snapshot; for a completed past month, MTD = the full month
and the 7-day trend is anchored to that month's last day. It sits inside
that month's collapsible group, so it collapses/expands along with the
rest of that month's data.

**Honesty note:** this was reconstructed from the reference tracker's
static values, not its actual formulas. "% of Target" is verified exact.
"RR based 7d," "MTD + 7d RR," and "Avg/d to Target" are a best-effort,
internally-consistent reconstruction (see comments in
`lib/scorecardWriter.js`) — compare a live run against the original and
flag if any column should compute differently.

## Feb-May 2026 historical months

BigQuery's spend data (`campaigns_attributed_daily`) only goes back to
2026-06-01 — there's no ad-spend history in there for Feb-May at all. So
those months can't be auto-computed and need a one-time manual entry:

1. Add a tab named exactly `Manual History` to the Sheet.
2. Headers in row 1: `Vertical | Month (YYYY-MM) | Spend | Revenue`
3. One row per vertical per month, e.g. `AVR | 2026-02 | 45000 | 52000`

The script reads this tab on every refresh (it never writes to it) and
folds those months into Total All's monthly blocks and YTD summary
alongside the live June+ BigQuery data — same structure, blended sources.
Revenue/VMM Targets still come from the separate `Targets` tab as before.

## Known simplifications (same as the Apps Script version)

- Plan/SKU rows are partner + rounded-payout-value buckets, not exact plan
  names (BigQuery has no plan/SKU field).
- Device split is Desktop / Mobile / Other (tablet+unknown combined).
- History starts 2026-06-01.
- Revenue/VMM Targets are manual — edit the Targets tab in the Sheet directly.

## Local testing (optional)

```
npm install
npm install -g vercel
vercel dev
```

Then hit `http://localhost:3000/api/refresh` with the same curl command
above (swap the URL). You'll need a `.env` file locally with the same three
variables — `vercel dev` reads `.env` automatically.
