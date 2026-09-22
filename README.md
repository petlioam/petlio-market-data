# Petlio Market Data

Petlio's normalized **market activity** feed for Adopt Me items.

## Source and refresh

- Source: [FairStash](https://fairstash.app/data)
- Feed: [FairStash supply CSV](https://fairstash.app/data/supply.csv)
- License: [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/) — data is used with attribution to **fairstash.app**
- Petlio check interval: every 6 hours at minute 17

FairStash refreshes its underlying data on its own schedule, so a Petlio check does not always produce different numbers.

## Fields

- `selling`: how much of FairStash's recent listing window was occupied by sellers for the item
- `buying`: the corresponding buyer count when FairStash recorded it; `null` means it was not recorded, not zero
- `activity`: `selling + buying` when both are present; when `buying` is unavailable it contains the available `selling` activity only

This is marketplace supply-and-demand activity data. It is **not** official Adopt Me data, Petlio pet values, a census of the marketplace, or global completed-trade counts.

## Files

- [`current.json`](./current.json): complete normalized snapshot for the newest available FairStash day
- [`summary.json`](./summary.json): lightweight top-50 `mostActive` ranking
- [`history/`](./history): previous changed snapshots for future 24-hour, 7-day, and 30-day comparisons
- [`scripts/update.mjs`](./scripts/update.mjs): dependency-free downloader, CSV parser, validator, and snapshot writer

Stable raw URL for Petlio:

```text
https://raw.githubusercontent.com/petlioam/petlio-market-data/main/current.json
```

Lightweight ranking URL:

```text
https://raw.githubusercontent.com/petlioam/petlio-market-data/main/summary.json
```
