# Tong Seafood Buffet Operations

A fast, installable PWA for the Owner, Manager, Accountant, Kitchen, and
Waiter stations. The first release uses Node.js and the built-in SQLite driver
so it can run locally with no dependency installation.

## Run locally

```powershell
npm run build
npm start
```

Open <http://localhost:3000>. No login is required. The workspace starts at the
Kitchen station and remembers the selected station, task, and service on this
device. The application stores its database in `data/tong.db`.

## Station workspace

- One task at a time, large touch targets, decimal quantity entry, and visible
  keyboard focus. Use Tab to move between fields and Enter to submit the form.
- Quantities start blank. Dish selection and service context stay ready for the
  next entry; unsaved drafts are kept separately for each station and task.
- Receiving uses a food field with dropdown suggestions and manual typing. Add
  rows for mixed deliveries. Unlisted names create stock items in the Other
  category when the delivery is saved; existing names are matched without case
  sensitivity. Duplicate food rows must be combined before saving.
- Save feedback stays visible with Undo. Recent activity offers undo for eligible
  entries and linked correction notes for records that need explanation.
- Undo reverses accepted delivery stock or a cooking batch atomically and retains
  the original receipt. Service undo excludes the event from waste totals. Stock
  reversals are conservatively blocked after later handoffs or reservations.
  Draft requests can be cancelled until they progress to approval.
- Correction notes do not change stock; inventory staff must reconcile quantity
  changes when a safe reversal is unavailable.
- A disconnected or uncertain save keeps its payload and submission key. Retry
  checks the same submission, preventing duplicate stock movements even if the
  original response was lost. Pending entries are locked until resolved. Offline
  drafts are not automatically submitted.
- Device storage preserves drafts across reloads. If browser storage is disabled,
  drafts and retry keys survive only while the page remains open.

The open station picker selects a seeded workflow role using `x-user-id`; it is
not authentication. Entries identify the selected station and device, not a
verified staff member. Existing seeded names in historical API records are demo
labels. All stations are freely selectable in this kiosk model.

Run `npm test` for isolated API tests, including duplicate submissions, reversal
integrity, validation, and request status conflicts. Tests use a temporary
database and leave `data/tong.db` untouched. `TONG_DATA_DIR` can also point a local
server at a separate data directory for demonstrations.

## Included workflows

- Kitchen requests in kilos and Manager approval.
- Available, reserved, catering-held, freezer, and reorder-point inventory.
- Shortage-driven purchase requests and delivery recording.
- Accepted-only receiving and payment/three-way-match status tracking.
- Cooking, freezer, display, leftover, and catering event logs.
- Immutable one-tap custody acknowledgement receipts.
- Audit trail, alert acknowledgement, dashboard summaries, and a printable
  custody history.

## Optional Telegram alerts

Set both variables before starting the server to forward newly-created
exception alerts to Telegram:

```powershell
$env:TELEGRAM_BOT_TOKEN = "replace-with-bot-token"
$env:TELEGRAM_CHAT_ID = "replace-with-chat-id"
npm start
```

Without these variables, alerts remain visible in the application and are
still recorded in SQLite. Never commit the token to the repository.

## Key API routes

- `GET /api/dashboard`, `/api/inventory`, `/api/alerts`, `/api/custody`
- `POST /api/requests`, `/api/requests/:id/approve`, `/api/requests/:id/reserve`
- `POST /api/purchases`, `/api/purchases/:id/approve`
- `POST /api/deliveries` — records accepted kilos and creates a custody receipt
- `POST /api/custody`, `/api/custody/:id/correct`, `/api/custody/:id/undo`
- `POST /api/payments`, `/api/payments/:id/approve`, `/api/payments/:id/release`
- `POST /api/batches`, `/api/service-logs`, and `/api/bookings`

Send an `Idempotency-Key` header on POST requests to persist the response together
with the transaction. Repeating the same key and payload returns the saved
response; reusing a key with different data returns a conflict.
