# Aries BigQuery Raw Pull

This app has exactly one job: pull spend + conversion data from BigQuery
and write it as a flat table into the **Raw Pull** tab of your tracker
Sheet. It does not build Total All, AVR/Hosting/SLR/LLC layouts,
scorecards, or any formatting — that's all built with formulas in the
Sheet itself, reading from Raw Pull.

## Raw Pull tab schema

| Date | Vertical | Device | Type | Source | Plan Price | Units | Amount |
|---|---|---|---|---|---|---|---|

- **Date**: `yyyy-MM-dd`
- **Vertical**: `AVR` / `Hosting` / `SLR` / `LLC` (your tab names directly)
- **Device**: `Desktop` / `Mobile` / `Other` (tablet+unknown combined)
- **Type**: `Spend` or `Revenue`
- **Source**: ad publisher name for Spend rows, partner name for Revenue rows
- **Plan Price**: only populated for Revenue rows — the partner's
  rounded payout value, used as a proxy for plan/SKU (BigQuery has no
  actual plan/SKU field — see note below)
- **Units**: only populated for Revenue rows — conversion count for that
  Source + Plan Price combination
- **Amount**: cost (Spend rows) or revenue $ (Revenue rows)

**Plan/SKU note:** exact plan names (e.g. "Norton 160 Plan") aren't
stored anywhere in BigQuery. Grouping conversions by
`(partner, ROUND(revenue))` reconstructs clean plan tiers for
fixed-price partners (Norton's $160/$120/$100 etc. come out exact) but
produces multiple near-duplicate buckets for partners with FX-variable
payouts (e.g. Fasthosts, IONOS — non-USD, so each sale's USD-converted
value varies slightly).

## Refresh behavior

- **Daily cron** (9:00 AM IST): pulls the **current month only** and
  merges it into Raw Pull — other months' rows are read back and kept
  exactly as they are, not re-pulled.
- **Manual / on-request** (curl, Apps Script test call, anything hitting
  `/api/refresh` directly without the cron's query param): does a
  **full refresh** — re-pulls everything from `2026-06-01` through
  today and replaces the whole tab. Use this whenever you want the full
  history refreshed (e.g. after an upstream correction).

## Setup

### 1. GCP service account
Same as before — a service account with `BigQuery Data Viewer` +
`BigQuery Job User` on `aa-analytics-project`, Sheets API enabled on the
same GCP project, JSON key downloaded.

### 2. Share the Sheet
Share your tracker Sheet with the service account's `client_email` as
an Editor.

### 3. Push to GitHub, import into Vercel
Same as before. Environment variables needed:
- `GOOGLE_SERVICE_ACCOUNT_KEY` — the full JSON key contents
- `GOOGLE_SHEET_ID` — from the Sheet's URL
- `CRON_SECRET` — any random string (see note below on cron auth)

### 4. Test manually
```
curl -H "Authorization: Bearer <your CRON_SECRET>" https://<your-app>.vercel.app/api/refresh
```
Should return `{"ok":true,"trigger":"manual","pullType":"full","rowCount":N}`.
Check the Raw Pull tab — it should now have the flat table above,
covering June 1 through today.

**Confidence note:** the cron path includes `?trigger=cron` in
`vercel.json` so the endpoint can tell cron calls apart from manual
ones — I believe Vercel Cron just does a plain HTTP GET to whatever path
you configure (query string included), but I haven't been able to
execute this myself to confirm. If the daily cron run isn't behaving as
expected, check the Vercel function logs for the `trigger` and
`pullType` values in the response and we'll adjust.

## Building your formulas on top of Raw Pull

Some starting points for the kinds of lookups you'll likely want:

- **Total daily spend for a vertical/device:**
  `=SUMIFS('Raw Pull'!H:H, 'Raw Pull'!A:A, date, 'Raw Pull'!B:B, "AVR", 'Raw Pull'!C:C, "Desktop", 'Raw Pull'!D:D, "Spend")`
- **Total daily revenue for a specific partner+plan:**
  `=SUMIFS('Raw Pull'!H:H, 'Raw Pull'!A:A, date, 'Raw Pull'!B:B, "AVR", 'Raw Pull'!E:E, "Norton", 'Raw Pull'!F:F, 160, 'Raw Pull'!D:D, "Revenue")`
- **Units sold for a partner+plan:**
  `=SUMIFS('Raw Pull'!G:G, 'Raw Pull'!A:A, date, 'Raw Pull'!E:E, "Norton", 'Raw Pull'!F:F, 160)`
- A `QUERY()` pulling distinct partner+plan combinations per vertical
  per month is probably the cleanest way to auto-generate your deal-row
  lists, if you want that to stay dynamic rather than hand-maintained.
