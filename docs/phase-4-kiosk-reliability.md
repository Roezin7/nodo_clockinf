# Phase 4 — Kiosk reliability and offline acceptance

This phase makes a kiosk event durable before it attempts the network. A punch
has one client-generated UUID for its entire lifetime; retries reuse that UUID.
The device credential determines organization and plant, so a kiosk never sends
or chooses its own tenant boundary.

## Event lifecycle

```text
capturing -> durable locally -> sending -> event acknowledged -> photo acknowledged -> removed locally
                         \-> pending offline -> retry in sequence ---------/
```

The browser must never persist the employee PIN. A connectivity failure keeps
the event and evidence photo and creates an identity-review warning when it
eventually syncs. Authentication rejection while online removes the provisional
event because no punch was accepted.

## Server invariants

- Device tokens are random, returned only at enrollment, and stored by the
  server only as SHA-256 hashes.
- An active device is permanently scoped to one organization and one plant.
- `(device_id, client_event_id)` is unique.
- `(device_id, client_installation_id, client_sequence)` is unique. Deleting
  browser storage creates a new installation UUID, so a reset sequence cannot
  collide with a previous tablet installation.
- Activation codes are one-time credentials. An admin may reissue a lost code
  only before enrollment, with a mandatory audited reason; an enrolled device
  must instead be revoked and replaced.
- Online punches use server time as payable punch time and retain device capture
  time as evidence.
- Offline punches use the capture time, are marked `offline`, and require
  identity review.
- Every event carries the clock-skew snapshot known when it was captured.
  Synchronization never applies a newer clock measurement retroactively; an
  event without a trusted snapshot keeps its raw time and remains reviewable.
- An offline time more than five minutes in the future or fourteen days in the
  past is rejected into the durable client queue; it is never silently dropped.
- Each event in a sync batch commits independently. One invalid event cannot
  roll back other valid events.
- Corrections and late sync use the same pay-period advisory lock as weekly
  finalization.
- A device may upload evidence only for its own punch.
- Closing a week is blocked while an enrolled active device reports pending or
  rejected events, has never sent a heartbeat, or has been silent for more than
  24 hours. The confirming heartbeat must be strictly later than Saturday
  23:59:59 in plant time, must report readable local storage, and must show a
  drained queue. An admin override requires an explicit confirmation and
  reason and is written to the audit trail.
- Every kiosk network request has a bounded timeout. A stuck connection returns
  control to the employee and leaves the encrypted event queued for an
  idempotent retry.
- A generic API rate-limit response never deletes an event. Only the explicit
  `pin_locked` code may discard an unauthenticated provisional attempt.

## Acceptance matrix

| Scenario | Expected result |
|---|---|
| Online event | One server punch, local event removed after photo upload |
| Connection fails before request | Local confirmation, one queued event |
| Server commits but response is lost | Retry returns the original punch |
| Same batch is sent twice | Same punch IDs, no duplicate rows |
| Browser database is reset | New installation UUID; sequence may safely restart at 1 |
| Enrollment response is lost | Retrying with the proposed permanent token recovers the same device |
| Activation link is lost before use | Admin reissues it with a reason; old link becomes invalid |
| Browser reloads while offline | Queue and photo remain in IndexedDB |
| Connectivity returns | Events sync in client sequence without employee action |
| One event is invalid | Other events commit; invalid event remains visible locally |
| Revoked device token | `401`, no cross-device or cross-plant access |
| Device A requests Device B photo | Rejected |
| Closed week receives late event | Event remains queued with `period_final` for admin action |
| Device clock is too far ahead/old | Rejected with an explicit reason, not discarded |
| Clock changes before delayed sync | Event uses its capture-time skew snapshot, not the new skew |
| HTTP connection remains half-open | Request times out; UI unlocks and event remains queued |
| Shared-IP rate limit returns generic `429` | Event and photo remain queued |
| API request is cached by service worker | Never; only the application shell is cached |
| Device has pending/rejected events at close | Close is blocked with device details |
| Last heartbeat predates the end of Saturday | Close is blocked until a post-period sync |
| Local queue cannot be read | Counts are not overwritten; unavailable storage blocks close |
| Admin overrides device-health block | Close succeeds only with confirmation/reason and audit |

## Operational rollout

Create exactly two named devices per plant, open each one-time enrollment link
on the assigned tablet, verify its plant label, take one online test punch and
one forced-offline test punch, then revoke the temporary test device/token. A
production kiosk is accepted only after reload, airplane-mode and duplicate
retry tests pass on the actual tablet and Wi-Fi network.
