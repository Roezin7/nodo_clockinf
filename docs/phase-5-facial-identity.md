# Phase 5 — Facial identity and human review

Phase 5 removes the PIN from the normal kiosk flow. Identity is evidence for a
time event; it is never permission to withhold an employee's punch. Every
accepted event is either safely verified or routed to an authorized human
review without changing its payable time.

## Operational contract

1. The kiosk creates one permanent `client_event_id`, captures a photograph,
   and encrypts both in IndexedDB before it contacts the API.
2. An online identity session is bound immutably to the organization, plant,
   device, employee, event UUID, installation UUID, sequence, punch type and
   capture timestamp. The server session start is the payable time, so facial
   attempts never make the employee lose minutes.
3. A biometric mismatch, no face, multiple faces, insufficient image quality
   or failed liveness consumes one attempt. The third counted failure routes
   the punch to human review. There is no fourth attempt.
4. Provider outages, timeouts, missing enrollment, a broken camera and offline
   operation do not consume an employee attempt. The time event is accepted and
   marked for review immediately.
5. The same event/session/attempt UUID and encrypted photograph are reused
   after a lost response. A retry can return the original result but cannot
   create a second punch or a second attempt.
6. A semantic double tap may have two event and identity sessions, but it has
   one canonical punch. The second session is retained through an append-only
   alias, while the receipt preserves both the submitted and canonical links.
   Every event keeps its own photo and review waits for all captured evidence
   to finish synchronizing.
7. A reviewer may approve or reject identity once, with a mandatory reason.
   Rejection changes only the identity projection. It never voids a punch or
   changes its employee, type, timestamp, plant or calculated hours.

## Provider safety

`FACE_PROVIDER=review_only` is the safe default. It captures evidence and sends
every punch to human review.

`FACE_PROVIDER=aws_rekognition` performs one-to-one `CompareFaces` assistance.
AWS documents `CompareFaces` as a probabilistic comparison; it is not a
liveness check. ClockAI therefore records similarity for the reviewer but does
not automatically verify an AWS match without a separate passed liveness
result. See the official [CompareFaces API reference](https://docs.aws.amazon.com/rekognition/latest/APIReference/API_CompareFaces.html).

`FACE_PROVIDER=fake` exists only for deterministic tests and local development.
Startup fails closed if it is selected in any other environment. The database
also rejects `verified` identity unless the session used a managed,
liveness-capable provider and stored `liveness_status=passed`.

Amazon Rekognition Face Liveness is a separate video-selfie flow using
`CreateFaceLivenessSession`, the Amplify detector and
`GetFaceLivenessSessionResults`; it is not silently approximated by a still
image. See AWS's [Face Liveness flow](https://docs.aws.amazon.com/rekognition/latest/dg/face-liveness.html).

## Evidence and privacy

- Enrollment photographs are immutable, hashed versions. Re-enrollment changes
  the employee's current pointer without rewriting historical bytes.
- Attempt evidence stores SHA-256, MIME type, byte length, capture timestamp,
  provider result and liveness status. JPEG, PNG and WebP signatures must agree
  with the declared MIME type.
- Employee deactivation clears the current enrollment pointer but does not
  destroy evidence referenced by historical sessions.
- Attempt photographs follow the configured photo-retention period. Online
  evidence ages from the authoritative server start; offline evidence ages
  from the session capture time, even if its upload arrives later. Object
  deletion is represented by an append-only purge row; attempt hashes and
  decision history remain. Enrollment retention and legal holds are finalized
  in the privacy/operations phase.
- Local development URLs and S3/R2 URLs expire after 15 minutes and review
  responses use `Cache-Control: private, no-store`. Production must use durable
  object storage.
- Biometric information is treated as sensitive personal information. Access
  is limited to admins and a foreman assigned to the affected plant. An
  accountant cannot access employee administration, photos, biometric state,
  identity scores or the operational attendance API.

California's CCPA materials identify biometric information used to establish
identity as sensitive personal information; production rollout still requires
a reviewed notice-at-collection, retention policy and incident process. See the
[California Attorney General CCPA guidance](https://oag.ca.gov/privacy/ccpa).

## Role matrix

| Capability | Admin | Foreman | Accountant |
|---|---:|---:|---:|
| Create a new enrollment version | Yes | No | No |
| Review identity evidence | All plants | Assigned plants | No |
| Record final identity decision | All plants | Assigned plants | No |
| See similarity/liveness metadata | Yes | Assigned plants | No |
| See names and classified report hours | Yes | Operational views | Yes |
| Change hours from identity decision | Never | Never | Never |

## Configuration

```dotenv
# Safe default: photographs + human review
FACE_PROVIDER=review_only

# Optional still-image comparison assistance (not liveness)
FACE_AWS_REGION=us-west-2
FACE_SIMILARITY_THRESHOLD=95
FACE_SESSION_TTL_SECONDS=600
```

The initial threshold is deliberately conservative and must be calibrated in a
field pilot with the actual tablets, lighting, hats, glasses and workforce. A
similarity score is never presented as certainty.

## Acceptance matrix

| Scenario | Required result |
|---|---|
| First/second counted failure | Session remains pending; remaining attempts are visible |
| Third counted failure | Punch accepted once and queued for review |
| Provider timeout/outage | Punch accepted once; zero attempts charged to employee |
| AWS still-image match without liveness | Review required; never auto-verified |
| Passed liveness-capable match | Verified, subject to the database invariant |
| Camera unavailable | Diagnostic evidence state, accepted time, human review |
| Fully offline | Encrypted queue, normalized captured time, synthetic review session on sync |
| Session response lost | Exact binding is recovered by event fields and linked to receipt/punch |
| Attempt response lost | Same UUID/photo returns the original attempt |
| Two modern events within the duplicate window | One punch, two receipts, append-only alias evidence |
| Reused UUID with different payload/photo metadata | Conflict; original record unchanged |
| Concurrent third/fourth requests | At most three counted attempts; deterministic review state |
| Concurrent reviewer decisions | One final decision; identical retry is idempotent, different retry conflicts |
| Identity rejection | Every payroll-bearing field and calculated hour remains unchanged |
| Foreman requests another plant | Denied |
| Accountant requests identity/attendance data | Denied |
| Evidence exceeds retention | Object removed once; purge/hash/history remain auditable |

## Physical rollout gate

Software tests cannot certify the camera, lighting, Wi-Fi or presentation-attack
performance of a real tablet. Before production, test the three installed
kiosks with enrolled employees representative of the workforce. Each
device must pass online, airplane-mode, response-loss, three-failure, camera
blocked, low-light and restart recovery scenarios. Automatic liveness cannot be
enabled until its real provider flow and thresholds pass that field gate.
