# Tong Seafood Buffet Operations

A fast, installable PWA for the Owner, Manager, Accountant, Kitchen, and
Waiter stations. The first release uses Node.js and the built-in SQLite driver
so it can run locally with no dependency installation.

## Run locally

```powershell
npm run build
npm start
```

Open <http://localhost:3000>. Demo users can be selected from the station
switcher. The application stores its database in `data/tong.db`.

## Included workflows

- Kitchen requests in kilos and Manager approval.
- Available, reserved, catering-held, freezer, and reorder-point inventory.
- Shortage-driven purchase requests and delivery recording.
- Accepted-only receiving and payment/three-way-match status tracking.
- Cooking, freezer, display, leftover, and catering event logs.
- Immutable one-tap custody acknowledgement receipts.
- Audit trail, alert acknowledgement, dashboard summaries, and a printable
  custody history.

The local demo authentication uses a selected seeded user and an
`x-user-id` request header. Production deployment must replace this with the
organization's identity provider and secure media storage.

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
- `POST /api/custody` and `/api/custody/:id/correct`
- `POST /api/payments`, `/api/payments/:id/approve`, `/api/payments/:id/release`
- `POST /api/batches`, `/api/service-logs`, and `/api/bookings`
