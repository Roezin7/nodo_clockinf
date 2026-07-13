# Phase 7 — Accountant portal and immutable exports

Phase 7 removes the spreadsheet handoff from the weekly workflow. The
accountant reads only published hours in ClockAI; the accountant cannot see or
change live timecards, operational reasons, photos, biometric evidence, wage
rates or estimated cost.

## Weekly lifecycle

The enforced lifecycle is:

`open/reopened -> ready_for_review -> final`

- Only an admin can move a completed Sunday–Saturday period to review.
- Moving to review re-derives structural blockers and freezes ordinary time
  mutations. An explicit admin override requires a reason and is audited.
- A final close is possible only from `ready_for_review`, after the California
  workweek has ended. Device synchronization and operational blockers are
  checked again inside the close transaction.
- `resume` returns a period to `open` or `reopened` according to whether a
  prior version exists.
- Reopening never edits a published version. The next close creates the next
  version and keeps every previous version available.

## Accountant contract

New closes use snapshot schema 2 and contract `clockai-accountant-v1`. The
allowlisted response contains:

- week, timezone, California policy, version, final status and close time;
- employee number, frozen name, plants worked, days, regular, overtime,
  double-time, clock, manual and total seconds;
- day/plant detail with safe punch types and times, meal duration, clock and
  manual seconds, and a fixed set of exception indicators;
- aggregate hour totals.

Operational IDs, actors, override reasons, rates, cost, photos, biometric
results and exception evidence are deliberately absent. Legacy snapshots are
projected through a summary-only allowlist and never returned verbatim.

The accountant endpoints return final versions only. The mutable computation
is a separate admin-only preview endpoint. Lists are bounded and paginated,
responses are `private, no-store`, and immutable versions have an ETag.

## Exact export artifacts

Closing creates and stores one XLSX, one summary CSV and one detail CSV in the
same database transaction as the immutable report version. Each artifact has
its own SHA-256, byte length, MIME type, filename and template version. Reads
serve those stored bytes; they never rebuild a historical workbook.

CSV and workbook cells neutralize values that spreadsheet programs could
interpret as formulas, including values with leading whitespace. Export
downloads are audited. PostgreSQL triggers reject update or delete of stored
artifacts.

## Acceptance evidence

Automated coverage includes:

- accountant/admin authorization and cross-organization isolation;
- final-only reads and explicit version selection;
- open, review, resume, final and reopen transitions;
- multi-plant clock and manual detail with California hour categories;
- frozen employee/plant labels after later source edits;
- exact repeated artifact bytes and SHA-256 values;
- spreadsheet-formula neutralization and export audit records;
- bounded pagination and safe legacy fallback;
- migration up, down and re-application on a clean PostgreSQL database.

