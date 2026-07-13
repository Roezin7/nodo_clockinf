# Phase 0 wireframes

These low-fidelity contracts define information hierarchy, not final styling.

## Kiosk — action selection

```text
+--------------------------------------------------+
| CLOCKAI                         Plant 1     ONLINE |
|                                                    |
|              Employee number                       |
|              [     1042       ]                     |
|                                                    |
|  [ CLOCK IN ]                [ MEAL OUT ]           |
|  [ MEAL IN  ]                [ CLOCK OUT ]          |
|                                                    |
|          English                  Español           |
+--------------------------------------------------+
```

## Kiosk — identity review fallback

```text
+--------------------------------------------------+
| We could not verify your face (3/3)                |
| Your time was recorded and sent for review.        |
|                                                    |
| Recorded at: 05:01:04                              |
|                                                    |
|                   [ FINISH ]                       |
|                                                    |
| Photo evidence: SAVED                              |
+--------------------------------------------------+
```

## Foreman — exception inbox

```text
+----------------------------------------------------------------+
| Plant 2 / Exceptions                             4 unresolved   |
|----------------------------------------------------------------|
| [Identity] 1042 Ana Ruiz       05:01   [Review photos]          |
| [Missing]  1031 Luis Mora      no out  [Correct]                |
| [Meal]     1067 Jose Diaz      open    [Correct]                |
| [Offline]  Kiosk P2-B          3 queued [Details]               |
+----------------------------------------------------------------+
```

## Foreman — manual hours

```text
+--------------------------------------------------------------+
| Add manual hours                                             |
| Employee      [1042 - Ana Ruiz                       v]       |
| Work date     [2026-07-11]                                   |
| Plant         [Plant 2                              v]        |
| Hours         [ 2.00 ]                                       |
| Reason *      [________________________________________]      |
|                                                              |
| [Cancel]                                      [Add hours]     |
| Classification is calculated automatically under CA rules.   |
+--------------------------------------------------------------+
```

## Admin — weekly close

```text
+----------------------------------------------------------------+
| Week Jul 5–11                         READY FOR REVIEW           |
|----------------------------------------------------------------|
| Regular  2,431.00 | OT 1.5  184.50 | Double  11.25             |
| Manual      18.00 | Estimated cost  $XX,XXX                     |
|----------------------------------------------------------------|
| Blocking exceptions  0 | Warnings  3 | Identity review  1      |
|                                                                |
| [View exceptions]                         [Finalize version 1]   |
+----------------------------------------------------------------+
```

## Accountant — final report

```text
+------------------------------------------------------------------------+
| Payroll hours / Week Jul 5–11 / FINAL v1                 [Export Excel]|
|------------------------------------------------------------------------|
| #    Employee          Regular   OT 1.5   Double  Manual   Total       |
| 1042 Ana Ruiz            40.00     6.00     0.00    2.00    48.00      |
| 1067 Jose Diaz           40.00    13.50     1.00    0.00    54.50      |
|------------------------------------------------------------------------|
| Read-only. Finalized Sunday 11:42 AM by Admin.                         |
+------------------------------------------------------------------------+
```

## Admin — operations dashboard

```text
+-----------------------------------------------------------------------+
| Today: 68 inside | 3 open sequences | 1 identity review | 6/6 online |
|-----------------------------------------------------------------------|
| This week             | By plant       | Compared with last week      |
| Regular    2,431 h    | P1  921 h      | Total hours        +4.2%     |
| OT 1.5       184 h    | P2  847 h      | OT proportion     -1.1 pt    |
| Double         11 h   | P3  858 h      | Estimated cost     +2.8%     |
| Manual          18 h  |                |                              |
|-----------------------------------------------------------------------|
| Approaching thresholds | Manual changes | Device / identity health    |
+-----------------------------------------------------------------------+
```
