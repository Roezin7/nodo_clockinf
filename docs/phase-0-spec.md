# ClockAI — Phase 0 product specification

Status: approved baseline for implementation  
Market: agricultural packing facilities in Modesto, California  
Timezone: `America/Los_Angeles`

## 1. Product boundary

ClockAI is the system of record for timekeeping. It captures punches, classifies
California regular/overtime/double-time hours, records auditable manual time,
provides an accountant-ready weekly report, and estimates direct wage cost.

ClockAI does **not** run payroll, calculate taxes/deductions/benefits, manage
production or products, or initiate payments.

## 2. Initial operating model

- One customer organization.
- Three plants.
- Two dedicated kiosks per plant (six total).
- 50–80 active hourly, non-exempt employees.
- One foreman per plant.
- One or more admins and accountants.
- Employees may work at different plants on different days. Overtime is always
  consolidated across the whole organization.
- Default workweek: Sunday 00:00 through Saturday 23:59 in plant time.
- Default workday: calendar day, 00:00 through 23:59 in plant time.
- Weekly report is finalized by an admin no later than Sunday noon.

## 3. Reference shift

The shift is informational and supports missing-punch warnings. Version 1 does
not calculate tardiness, absence, or schedule adherence.

- Clock in: 05:00
- Meal out: 09:00
- Meal in: 09:30
- Clock out: 13:30
- Expected paid duration: 8 hours

Paid rest breaks are not punched. Meal punches are captured and meal compliance
is reported as a warning, not converted automatically to a pay premium.

## 4. Roles and least privilege

### Platform operator

Manages organizations, deployments, devices, releases, backups and support.
Customer-data access is exceptional and audited.

### Admin

Has organization-wide access, manages employees/rates/users/devices, reviews
identity evidence, sees estimated cost, finalizes/reopens weeks and views the
complete audit trail.

### Foreman

Has operational access only to assigned plants. Can review punches, resolve
identity alerts, correct/void punches and add manual hours during an open week.
Every mutation requires a reason. Foremen do not see wage rates or costs.

### Accountant

Has read-only organization-wide access to employee names/numbers and finalized
hour categories. Can view weekly/daily detail and export Excel. Cannot see
photos, biometrics, PINs, rates, costs or administrative settings.

## 5. Punch flow

Available actions are explicit:

1. Clock In
2. Meal Out
3. Meal In
4. Clock Out

Every punch records organization, plant, device, employee, action, capture time,
server receive time, online/offline state, identity status and an evidence photo.
The server accepts a client-generated idempotency key so retries never create a
second punch.

### Identity flow

1. Employee enters employee number (or badge identifier in a later hardware
   integration).
2. Kiosk performs one-to-one facial verification with liveness.
3. An evidence photo is captured for every attempt that becomes a punch.
4. After three failed facial attempts, the employee enters a backup PIN.
5. A valid fallback punch is accepted and marked `identity_review`.
6. The assigned foreman and admins are notified.
7. A foreman/admin compares enrollment and punch evidence and records approval
   or rejection with a reason.

Identity failure or loss of connectivity must never prevent a punch from being
captured.

### Offline flow

The kiosk stores an encrypted, durable event in IndexedDB and confirms capture
to the employee. Events sync in order when connectivity returns. Clock drift,
duplicate requests and server-side validation failures become visible
exceptions; they are never silently discarded.

## 6. California time classification

Only California rules are implemented. There is no company-specific weekly
double-time threshold.

For the configured workday/workweek and employees covered by the standard rule:

1. Time over 8 through 12 hours in a workday is 1.5x.
2. Time over 12 hours in a workday is 2.0x.
3. On the seventh consecutive worked day in one workweek, the first 8 hours are
   1.5x and time over 8 hours is 2.0x.
4. After daily/seventh-day classification, otherwise-regular time over 40 hours
   in the workweek is reclassified to 1.5x.
5. An hour is assigned exactly one category; premiums never pyramid.
6. Calculations are minute-precise. Presentation may show two decimal hours,
   but stored punches and calculations are not rounded to a punch interval.

Required invariant:

`regular_minutes + overtime_minutes + double_time_minutes = payable_minutes`

## 7. Corrections and manual hours

Raw punches are immutable. A correction voids the original through an audited
record and creates a replacement. Foremen can make changes freely while a week
is open; a reason is mandatory.

Manual hours require employee, work date, plant, amount and reason. They have no
hard cap. They are appended after clock-derived time for that date and the rules
engine decides regular/1.5x/2.0. Reports always expose manual minutes separately
from clock-derived minutes even though both contribute to payable categories.

Unusual quantities produce a warning but do not block saving.

## 8. Weekly lifecycle

States:

`open -> ready_for_review -> final -> reopened -> final (new version)`

Blocking exceptions include open shift/meal segments, overlapping segments,
negative duration and invalid manual entries. Identity/meal/device warnings are
non-blocking. Admin may override a blocking close only with an explicit reason.

Finalization creates an immutable snapshot and version. Reopening never edits a
previous snapshot; it produces the next version and notifies the accountant.

## 9. Accountant report contract

Summary columns:

- Employee Number
- Name
- Plants Worked
- Regular Hours
- OT 1.5 Hours
- Double-Time Hours
- Manual Hours
- Total Hours
- Report Version
- Status

Detail adds work date, plant, punch times, meal duration, clock-derived minutes,
manual minutes and exception indicators. Wage rates and estimated costs are not
part of accountant exports.

## 10. Admin dashboard contract

### Current operation

- Employees currently clocked in by plant
- Open punch/meal sequences
- Pending identity reviews
- Device connectivity and pending offline events

### Current week

- Regular, 1.5x, 2.0x and manual hours
- Estimated direct wage cost, organization and plant
- Employees approaching daily 8/12 and weekly 40 hour boundaries
- Manual changes by foreman
- Week-over-week comparison and projected close

### Historical

- Weekly/monthly hour and estimated cost trends
- Overtime/double-time proportions
- Manual-to-clocked time ratio
- Device and facial-verification reliability

Estimated cost uses effective-dated employee rates and statutory multipliers. It
excludes payroll taxes, deductions, benefits, insurance and other burden.

## 11. Notifications

- Foreman: plant identity review, open sequence, device outage and closing work.
- Admin: all operational warnings, manual mutations and weekly lifecycle events.
- Accountant: report finalized, reopened or replaced by a new version.
- Platform operator: service/storage/database/device-health failures.

Version 1 uses in-app and installable PWA notifications. Delivery failure never
changes the underlying timecard state.

## 12. Non-functional acceptance criteria

- No accepted punch is lost during connectivity or process failure.
- Retries are idempotent.
- Every mutation has actor, timestamp and reason.
- Cross-organization and unauthorized cross-plant access is impossible.
- Six kiosks can ingest the start-of-shift burst concurrently.
- A finalized export can be regenerated byte-for-byte from its snapshot.
- Backups are automatic and a restore is tested before production launch.
- Three parallel weekly cycles reconcile without unexplained differences.

## 13. Deferred scope

- Payroll/tax/payment processing
- PTO, sick and holiday accruals
- Product, lot, production or productivity tracking
- Employee scheduling, tardiness and absence policies
- Native iOS/Android apps
- Badge/RFID hardware integration
- Multi-rate regular-rate payroll calculations

