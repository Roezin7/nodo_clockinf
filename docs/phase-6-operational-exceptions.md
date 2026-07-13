# Phase 6 — Operational exceptions and notifications

Phase 6 replaces verbal corrections with a durable operational queue. The
queue observes the authoritative punch, identity, manual-time and device
records; it never becomes a second time source. Acknowledging or resolving an
exception cannot create, edit, void or reclassify an hour.

## Reconciliation contract

1. The server reconciles the current and previous workweeks plus every
   historical week explicitly reopened by an admin. A per-organization
   advisory lock makes the job safe on several server instances. Finalization
   also derives blockers directly from source records under the same weekly
   lock, so a stale projection cannot allow a bad close.
2. With the assigned 05:00–13:30 shift, a still-open shift becomes
   `missing_shift_out` one hour after its scheduled end. The conservative
   fallback for an employee without a shift is 16 elapsed hours. An open meal
   becomes `missing_meal_in` after two elapsed hours. Finalization disables
   these live-work graces and treats every open sequence as a detailed blocker.
3. Structural blockers include missing ends, invalid ordering, negative
   duration, cross-plant overlap and invalid legacy manual time. Identity,
   device, split-shift and meal observations are warnings that require human
   review but do not alter payable time.
4. Reconciliation is idempotent. Each source/code pair has a stable SHA-256
   key. A changed source refreshes the projection; a source that disappears
   resolves it; and an automatically resolved source that returns reopens it.
   A human resolution of a warning remains valid for the exact reviewed
   fingerprint and reopens only when its facts change. A structural blocker
   always reopens while its source persists, so it cannot disappear from the
   active queue or bypass the close gate. Every lifecycle change is stored in
   an append-only, paginated event history.
5. A foreman may see an exception only if the foreman has access to every
   linked plant. An admin sees the organization. The accountant has no access
   to operational exceptions, employee evidence, devices or notifications.
6. Recognize and resolve actions require a reason. They record actor, time,
   prior state and new state. They do not hide the immutable history.

## California meal-period screening

The engine screens actual clock-work intervals only. Duration-only manual
credits are intentionally excluded. It checks a first 30-minute meal when more
than five hours are worked, a second meal when more than ten hours are worked,
the five/ten-hour start deadlines, exact 30-minute duration boundaries, waiver
review bands, unexplained split-shift gaps, overnight work and daylight-saving
transitions. An overnight shift remains one continuous meal-review period even
though its payable work is split at civil midnight for California daily OT.

California Labor Code section 512 sets the five/ten-hour and 30-minute rules
and the limited six/twelve-hour waiver bands. The DLSE says the first meal is
generally due no later than the end of the fifth hour and the second no later
than the end of the tenth hour. It also explains that an employer must provide
a real opportunity for an uninterrupted, duty-free meal. See the official
[Labor Code §512](https://leginfo.legislature.ca.gov/faces/codes_displaySection.xhtml?lawCode=LAB&sectionNum=512.)
and [DLSE meal-period FAQ](https://www.dir.ca.gov/dlse/FAQ_mealperiods.htm).

ClockAI deliberately emits review warnings only. It does not infer a valid
waiver, whether an employee was relieved of all duty, or whether a premium is
owed. Those facts are outside punch timestamps. The customer must have
California employment counsel confirm the applicable IWC order and operating
policy before production. The DLSE classification guide indicates that
commercial post-harvest packing commonly falls under Order 8, while on-farm
preparation can fall under Order 13; classification is fact-specific. See the
official [IWC classification guide](https://www.dir.ca.gov/dlse/whichiwcorderclassifications.pdf).

This deployment is fixed to `America/Los_Angeles` in the API, service layer and
database because all three contracted plants are in Modesto and the screening
policy is California-specific. A timezone change cannot silently disable the
worker or reinterpret a historical workday.

## Weekly close behavior

- Any unresolved structural blocker returns HTTP 409 and a sanitized blocker
  list. No weekly version is created.
- An admin may explicitly override operational blockers only with a reason.
  The blocked attempt and the override are both audited.
- Device synchronization health remains an independent close gate. If both
  gates apply, the UI accumulates both explicit approvals instead of silently
  replacing one with the other.
- Meal, identity, device-condition and split-shift warnings remain visible but
  do not add hours, premiums or other pay categories.

## In-app and Web Push notifications

Every exception lifecycle event writes a notification intent in the same
database transaction. Workers materialize one inbox item per eligible user and
one delivery per active browser subscription using unique constraints and
`FOR UPDATE SKIP LOCKED`; retries therefore remain idempotent across multiple
instances.

The in-app inbox includes the operational title and routes the authorized user
to `/exceptions`. Web Push is optional and always uses fixed generic text; it
never sends employee names, photos, biometric results, exception identifiers
or evidence. HTTP 404/410 from the push provider deactivates the endpoint.
Transient failures use bounded exponential retries and cannot affect the
exception or its source time.

Subscription endpoints are accepted only for the supported Apple, Google,
Mozilla and Microsoft browser push services. This prevents an API caller from
turning the worker into an arbitrary server-side request client. Each user is
limited to five active browser subscriptions, concurrent claims are serialized
in PostgreSQL, ownership conflicts cannot overwrite another tenant, and the
creation API is rate-limited. A foreman who loses plant access immediately
loses inbox/read access and queued push delivery for that exception.

Push permission is requested only from an explicit user action. Generate one
VAPID identity and keep the private key secret:

```bash
npx web-push generate-vapid-keys
```

```dotenv
VAPID_SUBJECT=mailto:alerts@example.com
VAPID_PUBLIC_KEY=...
VAPID_PRIVATE_KEY=...
```

Leaving all three values empty disables only Web Push; the in-app inbox still
works. A partial or mismatched configuration fails at startup. Production push
also requires HTTPS and a registered service worker.

## Acceptance matrix

| Scenario | Required result |
|---|---|
| Employee without an assigned shift is still working | No missing-out exception during the 16-hour fallback grace |
| Employee has normal assigned shift | Missing-out alert at 14:30, one hour after scheduled end |
| Missing/invalid punch sequence | Stable blocker with source evidence and plant scope |
| Employee moves between plants | One workday; overlap detected; complete-scope foreman rule |
| Normal 05:00–13:30 shift, 09:00–09:30 meal | No meal warning |
| Meal exactly 30 minutes / starts at hour five | Accepted at the boundary |
| Meal 29:59 / starts one second late | Short/late review warning |
| Meal or waiver fact is ambiguous | Review warning; zero automatic premium hours |
| Reconciliation repeats or races | One projection and one lifecycle event per real transition |
| Device heartbeat changes but health reason does not | Projection refresh only; no event flood |
| Historical period is reopened | Its incidents continue reconciling automatically |
| Source is fixed and later breaks again | Automatic resolve followed by append-only reopen |
| Foreman lacks one linked plant | List, detail, action and notification are denied |
| Accountant calls an operational API | Denied before any data is returned |
| Close has structural blockers | 409; no weekly version |
| Admin overrides with reason | Version created once and override audit retained |
| Push payload is inspected | Generic text and route only; no operational evidence |
| Push endpoint expires | Subscription disabled; inbox item retained |
| Two tenants race on the same push endpoint | One owner; losing keys cannot overwrite it |
| User races for a sixth push subscription | Exactly five active; other claim rejected |

## Field gate

Software tests cannot prove that supervisors will resolve the queue before the
Sunday close or that mobile operating systems will deliver Web Push promptly.
The three-plant pilot must exercise missing punches, cross-plant transfers,
offline devices, concurrent reviewers, Sunday close and notification delivery
on the actual admin/foreman phones. In-app notifications remain the source of
truth; Web Push is a best-effort prompt.
