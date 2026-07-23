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
