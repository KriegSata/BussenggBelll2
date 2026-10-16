const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { db, now } = require("./db");

const PORT = Number(process.env.PORT || 3000);
const root = path.join(__dirname, "..");
const staticRoot = fs.existsSync(path.join(root, "dist")) ? path.join(root, "dist") : path.join(root, "public");
const PAYMENT_ALLOWANCE_RATE = 0.05;

const roleNames = {
  OWNER: "Owner / SuperAdmin",
  MANAGER: "Manager / Admin",
  ACCOUNTANT: "Accountant",
  KITCHEN: "Kitchen",
  WAITER: "Waiter"
};

function json(res, status, body) {
  if (res.submission && status < 300) {
    db.prepare("INSERT INTO saved_submissions (key, fingerprint, status, response) VALUES (?, ?, ?, ?)")
      .run(res.submission.key, res.submission.fingerprint, status, JSON.stringify(body));
    db.exec("COMMIT");
  } else if (res.submission) {
    db.exec("ROLLBACK");
  }
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}

function text(res, status, body, type = "text/plain; charset=utf-8") {
  res.writeHead(status, { "content-type": type });
  res.end(body);
}

function parseJson(req) {
  if (req.parsedBody) return Promise.resolve(req.parsedBody);
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 2_000_000) req.destroy();
    });
    req.on("end", () => {
      if (!body) return resolve({});
      try {
        resolve(JSON.parse(body));
      } catch {
        reject(new Error("Request body must be valid JSON."));
      }
    });
    req.on("error", reject);
  });
}

function getUser(req) {
  const id = req.headers["x-user-id"] || "owner-1";
  return db.prepare("SELECT id, name, role, station FROM users WHERE id = ?").get(id);
}

function requireUser(req, res, allowedRoles = []) {
  const user = getUser(req);
  if (!user) {
    json(res, 401, { error: "Sign-in required." });
    return null;
  }
  if (allowedRoles.length && !allowedRoles.includes(user.role)) {
    json(res, 403, { error: `This action is not available to ${roleNames[user.role]}.` });
    return null;
  }
  return user;
}

function audit(user, action, entityType, entityId, details = {}) {
  db.prepare(`
    INSERT INTO audit_log (actor_id, action, entity_type, entity_id, details_json, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(user.id, action, entityType, String(entityId), JSON.stringify(details), now());
}

function nextReference(prefix) {
  return `${prefix}-${new Date().toISOString().slice(0, 10).replaceAll("-", "")}-${crypto.randomBytes(3).toString("hex").toUpperCase()}`;
}

function safeItems(items) {
  if (!Array.isArray(items) || !items.length) throw new Error("At least one item is required.");
  return items.map((item) => {
    const stockItemId = Number(item.stockItemId);
    const kilos = Number(item.kilos);
    const estimatedPrice = Number(item.estimatedPrice || 0);
    if (!Number.isInteger(stockItemId) || !Number.isFinite(kilos) || kilos <= 0) {
      throw new Error("Each item needs a valid stock item and positive kilos.");
    }
    if (!Number.isFinite(estimatedPrice) || estimatedPrice < 0) throw new Error("Each item needs a valid estimated price.");
    return { stockItemId, kilos, estimatedPrice };
  });
}

function createCustodyReceipt(user, input) {
  const items = input.items || [];
  const kilos = Number(input.kilos || items.reduce((sum, item) => sum + Number(item.kilos || 0), 0));
  const receiptNumber = nextReference("ACK");
  const result = db.prepare(`
    INSERT INTO custody_receipts
      (receipt_number, source_type, source_reference, action, actor_id, actor_role,
       station, device_id, items_json, kilos, condition, photo_path, correction_of, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    receiptNumber,
    input.sourceType || "HANDOFF",
    input.sourceReference || "UNREFERENCED",
    input.action || "ACKNOWLEDGED",
    user.id,
    user.role,
    user.station,
    input.deviceId || "browser-station",
    JSON.stringify(items),
    kilos,
    input.condition || null,
    input.photoPath || null,
    input.correctionOf ? Number(input.correctionOf) : null,
    now()
  );
  audit(user, "CUSTODY_ACKNOWLEDGED", "custody_receipt", result.lastInsertRowid, {
    receiptNumber,
    sourceReference: input.sourceReference,
    action: input.action,
    kilos
  });
  return db.prepare("SELECT * FROM custody_receipts WHERE id = ?").get(result.lastInsertRowid);
}

function createAlert(type, message, role, sourceReference, user) {
  const existing = db.prepare(`
    SELECT id FROM alerts
    WHERE type = ? AND source_reference IS ? AND status = 'OPEN'
  `).get(type, sourceReference || null);
  if (existing) return existing.id;
  const result = db.prepare(`
    INSERT INTO alerts (type, message, target_role, source_reference, created_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(type, message, role, sourceReference || null, now());
  audit(user || { id: "owner-1" }, "ALERT_CREATED", "alert", result.lastInsertRowid, { type, message });
  notifyTelegram(type, message);
  return result.lastInsertRowid;
}

function notifyTelegram(type, message) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) return;
  fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text: `[${type}] ${message}` })
  }).catch((error) => console.error("Telegram notification failed:", error.message));
}

function listBootstrap() {
  return {
    users: db.prepare("SELECT id, name, role, station FROM users ORDER BY CASE role WHEN 'OWNER' THEN 1 WHEN 'MANAGER' THEN 2 WHEN 'ACCOUNTANT' THEN 3 WHEN 'KITCHEN' THEN 4 ELSE 5 END").all(),
    settings: Object.fromEntries(db.prepare("SELECT key, value FROM settings").all().map((row) => [row.key, row.value])),
    suppliers: db.prepare("SELECT id, name, source_type AS sourceType FROM suppliers WHERE active = 1 ORDER BY name").all(),
    items: db.prepare("SELECT id, name, category, on_hand AS onHand, reserved, freezer, reorder_point AS reorderPoint, usual_price AS usualPrice FROM stock_items ORDER BY name").all()
  };
}

function dashboard() {
  const totals = db.prepare(`
    SELECT
      COALESCE(SUM(on_hand), 0) AS onHand,
      COALESCE(SUM(reserved), 0) AS reserved,
      COALESCE(SUM(freezer), 0) AS freezer
    FROM stock_items
  `).get();
  const cooked = db.prepare("SELECT COALESCE(SUM(cooked_kilos), 0) AS kilos FROM batches b WHERE date(created_at) = date('now') AND NOT EXISTS (SELECT 1 FROM custody_receipts c JOIN reversals r ON r.receipt_id = c.id WHERE c.source_type = 'BATCH' AND c.source_reference = b.reference)").get().kilos;
  const waste = db.prepare("SELECT COALESCE(SUM(kilos), 0) AS kilos FROM service_logs s WHERE kind = 'LEFTOVER' AND decision = 'DISCARD' AND date(created_at) = date('now') AND NOT EXISTS (SELECT 1 FROM custody_receipts c JOIN reversals r ON r.receipt_id = c.id WHERE c.source_type = 'SERVICE_LOG' AND c.source_reference = 'SERVICE-' || s.id)").get().kilos;
  return {
    ...totals,
    cooked,
    waste,
    openAlerts: db.prepare("SELECT COUNT(*) AS count FROM alerts WHERE status = 'OPEN'").get().count,
    pendingRequests: db.prepare("SELECT COUNT(*) AS count FROM requests WHERE status IN ('DRAFT', 'PENDING_FULFILLMENT')").get().count,
    pendingApprovals: db.prepare("SELECT COUNT(*) AS count FROM purchase_requests WHERE status = 'PENDING_APPROVAL'").get().count,
    recentCustody: db.prepare(`
      SELECT c.*, u.name AS actor_name
      FROM custody_receipts c JOIN users u ON u.id = c.actor_id
      ORDER BY c.id DESC LIMIT 8
    `).all()
  };
}

async function route(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  const pathname = url.pathname;
  if (pathname === "/api/health") return json(res, 200, { ok: true, service: "tong-seafood-buffet" });
  if (!pathname.startsWith("/api/")) return serveStatic(req, res, pathname);

  try {
    if (req.method === "POST") {
      req.parsedBody = await parseJson(req);
      const key = req.headers["idempotency-key"];
      if (key) {
        if (key.length > 100) return json(res, 400, { error: "Invalid submission key." });
        const fingerprint = JSON.stringify([getUser(req)?.id, pathname, req.parsedBody]);
        const previous = db.prepare("SELECT * FROM saved_submissions WHERE key = ?").get(key);
        if (previous) {
          if (previous.fingerprint !== fingerprint) return json(res, 409, { error: "Submission key already used for another entry." });
          return json(res, previous.status, JSON.parse(previous.response));
        }
        db.exec("BEGIN IMMEDIATE");
        res.submission = { key, fingerprint };
      }
    }
    const undo = pathname.match(/^\/api\/custody\/(\d+)\/undo$/);
    if (req.method === "POST" && undo) {
      const user = requireUser(req, res);
      if (!user) return;
      const original = db.prepare("SELECT * FROM custody_receipts WHERE id = ?").get(Number(undo[1]));
      if (!original) return json(res, 404, { error: "Receipt not found." });
      if (!db.prepare("SELECT 1 FROM reversible_entries WHERE receipt_id = ?").get(original.id)) return json(res, 409, { error: "This receipt has no reversible transaction. Add a correction note instead." });
      if (original.actor_id !== user.id && !["OWNER", "MANAGER"].includes(user.role)) return json(res, 403, { error: "Switch to the station that recorded this entry." });
      if (!["DELIVERY", "BATCH", "SERVICE_LOG"].includes(original.source_type) || original.correction_of || original.action === "CORRECTION") return json(res, 409, { error: "This receipt cannot be undone. Record a correction note instead." });
      if (db.prepare("SELECT 1 FROM reversals WHERE receipt_id = ?").get(original.id)) return json(res, 409, { error: "This entry has already been undone." });
      // Conservatively refuse inventory reversal after any later handoff or stock reservation.
      if (original.source_type !== "SERVICE_LOG" && (
        db.prepare("SELECT 1 FROM custody_receipts WHERE id > ? LIMIT 1").get(original.id) ||
        db.prepare("SELECT 1 FROM audit_log WHERE action = 'REQUEST_RESERVED' AND created_at >= ? LIMIT 1").get(original.created_at)
      )) return json(res, 409, { error: "Later activity may depend on this stock. Record a correction note and ask inventory staff to reconcile it." });
      db.exec(res.submission ? "SAVEPOINT operation" : "BEGIN IMMEDIATE");
      try {
        const items = JSON.parse(original.items_json);
        if (original.source_type === "DELIVERY") {
          for (const item of items) {
            const stock = db.prepare("SELECT * FROM stock_items WHERE id = ?").get(item.stockItemId);
            if (stock.on_hand - stock.reserved < item.acceptedKilos) throw new Error("Available stock is insufficient for reversal.");
            db.prepare("UPDATE stock_items SET on_hand = on_hand - ? WHERE id = ?").run(item.acceptedKilos, item.stockItemId);
            db.prepare("INSERT INTO inventory_ledger (stock_item_id, action, kilos, reference, actor_id, created_at) VALUES (?, 'RECEIPT_REVERSED', ?, ?, ?, ?)").run(item.stockItemId, -item.acceptedKilos, original.source_reference, user.id, now());
          }
          db.prepare("UPDATE deliveries SET status = 'REVERSED' WHERE reference = ?").run(original.source_reference);
          db.prepare("UPDATE alerts SET status = 'ACKNOWLEDGED', acknowledged_by = ?, acknowledged_at = ? WHERE source_reference = ? AND status = 'OPEN'").run(user.id, now(), original.source_reference);
        }
        if (original.source_type === "BATCH") {
          for (const item of items) {
            const stock = db.prepare("SELECT * FROM stock_items WHERE id = ?").get(item.stockItemId);
            if (stock.freezer < item.freezerKilos) throw new Error("Freezer stock is insufficient for reversal.");
            db.prepare("UPDATE stock_items SET on_hand = on_hand + ?, freezer = freezer - ? WHERE id = ?").run(item.rawKilos, item.freezerKilos, item.stockItemId);
          }
        }
        db.prepare("INSERT INTO reversals (receipt_id, created_at) VALUES (?, ?)").run(original.id, now());
        const receipt = createCustodyReceipt(user, { sourceType: original.source_type, sourceReference: original.source_reference, action: "REVERSED", correctionOf: original.id, kilos: original.kilos, items, deviceId: req.parsedBody.deviceId, condition: "Entry undone; original receipt retained" });
        audit(user, "ENTRY_REVERSED", "custody_receipt", original.id);
        db.exec(res.submission ? "RELEASE operation" : "COMMIT");
        return json(res, 200, { receipt });
      } catch (error) { db.exec(res.submission ? "ROLLBACK TO operation; RELEASE operation" : "ROLLBACK"); return json(res, 409, { error: error.message }); }
    }
    if (req.method === "GET" && pathname === "/api/bootstrap") {
      const user = requireUser(req, res);
      if (!user) return;
      return json(res, 200, { ...listBootstrap(), currentUser: user });
    }
    if (req.method === "GET" && pathname === "/api/dashboard") {
      const user = requireUser(req, res);
      if (!user) return;
      return json(res, 200, dashboard());
    }
    if (req.method === "GET" && pathname === "/api/inventory") {
      const user = requireUser(req, res);
      if (!user) return;
      return json(res, 200, { items: listBootstrap().items });
    }
    if (req.method === "GET" && pathname === "/api/custody") {
      const user = requireUser(req, res);
      if (!user) return;
      const clauses = [];
      const params = [];
      if (url.searchParams.get("sourceReference")) {
        clauses.push("c.source_reference = ?");
        params.push(url.searchParams.get("sourceReference"));
      }
      if (url.searchParams.get("actorId")) {
        clauses.push("c.actor_id = ?");
        params.push(url.searchParams.get("actorId"));
      }
      const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
      return json(res, 200, {
        receipts: db.prepare(`
          SELECT c.*, u.name AS actor_name, u.role AS actor_role_name,
            EXISTS (SELECT 1 FROM reversible_entries e WHERE e.receipt_id = c.id) AS reversible,
            EXISTS (SELECT 1 FROM reversals r WHERE r.receipt_id = c.id) AS reversed
          FROM custody_receipts c JOIN users u ON u.id = c.actor_id
          ${where} ORDER BY c.id DESC LIMIT 200
        `).all(...params)
      });
    }
    if (req.method === "GET" && pathname === "/api/alerts") {
      const user = requireUser(req, res);
      if (!user) return;
      return json(res, 200, { alerts: db.prepare(`
        SELECT a.*, u.name AS acknowledged_name
        FROM alerts a LEFT JOIN users u ON u.id = a.acknowledged_by
        WHERE a.target_role IN (?, 'OWNER') ORDER BY a.id DESC LIMIT 100
      `).all(user.role) });
    }
    if (req.method === "POST" && pathname === "/api/requests") {
      const user = requireUser(req, res, ["KITCHEN", "MANAGER", "OWNER"]);
      if (!user) return;
      const body = req.parsedBody;
      const items = safeItems(body.items);
      const reference = nextReference("RF");
      const createdAt = now();
      db.exec(res.submission ? "SAVEPOINT operation" : "BEGIN IMMEDIATE");
      try {
        const result = db.prepare(`
          INSERT INTO requests (reference, service, requested_by, status, notes, created_at)
          VALUES (?, ?, ?, 'DRAFT', ?, ?)
        `).run(reference, body.service || "LUNCH", user.id, body.notes || null, createdAt);
        const addItem = db.prepare("INSERT INTO request_items (request_id, stock_item_id, kilos) VALUES (?, ?, ?)");
        for (const item of items) addItem.run(result.lastInsertRowid, item.stockItemId, item.kilos);
        audit(user, "REQUEST_CREATED", "request", result.lastInsertRowid, { reference });
        db.exec(res.submission ? "RELEASE operation" : "COMMIT");
        return json(res, 201, { request: db.prepare("SELECT * FROM requests WHERE id = ?").get(result.lastInsertRowid) });
      } catch (error) {
        db.exec(res.submission ? "ROLLBACK TO operation; RELEASE operation" : "ROLLBACK");
        throw error;
      }
    }
    if (req.method === "GET" && pathname === "/api/requests") {
      const user = requireUser(req, res);
      if (!user) return;
      return json(res, 200, { requests: db.prepare(`
        SELECT r.*, u.name AS requested_by_name,
          (SELECT COALESCE(SUM(kilos), 0) FROM request_items ri WHERE ri.request_id = r.id) AS kilos
        FROM requests r JOIN users u ON u.id = r.requested_by
        ORDER BY r.id DESC LIMIT 100
      `).all() });
    }
    if (req.method === "POST" && pathname === "/api/purchases") {
      const user = requireUser(req, res, ["ACCOUNTANT", "MANAGER", "OWNER"]);
      if (!user) return;
      const body = req.parsedBody;
      const items = safeItems(body.items);
      const reference = nextReference("PR");
      const totalEstimate = items.reduce((sum, item) => sum + item.kilos * Number(item.estimatedPrice || 0), 0);
      db.exec(res.submission ? "SAVEPOINT operation" : "BEGIN IMMEDIATE");
      try {
        const purchase = db.prepare(`
          INSERT INTO purchase_requests
            (reference, request_id, supplier_id, status, total_estimate, prepared_by, created_at)
          VALUES (?, ?, ?, 'PENDING_APPROVAL', ?, ?, ?)
        `).run(reference, body.requestId ? Number(body.requestId) : null, body.supplierId ? Number(body.supplierId) : null, totalEstimate, user.id, now());
        const addItem = db.prepare(`
          INSERT INTO purchase_items (purchase_request_id, stock_item_id, kilos, estimated_price)
          VALUES (?, ?, ?, ?)
        `);
        for (const item of items) addItem.run(purchase.lastInsertRowid, item.stockItemId, item.kilos, Number(item.estimatedPrice || 0));
        audit(user, "PURCHASE_REQUEST_CREATED", "purchase_request", purchase.lastInsertRowid, { reference, totalEstimate });
        createAlert("PENDING APPROVAL", `Purchase ${reference} is waiting for Manager approval.`, "MANAGER", reference, user);
        db.exec(res.submission ? "RELEASE operation" : "COMMIT");
        return json(res, 201, { purchase: db.prepare("SELECT * FROM purchase_requests WHERE id = ?").get(purchase.lastInsertRowid) });
      } catch (error) {
        db.exec(res.submission ? "ROLLBACK TO operation; RELEASE operation" : "ROLLBACK");
        throw error;
      }
    }
    if (req.method === "GET" && pathname === "/api/purchases") {
      const user = requireUser(req, res);
      if (!user) return;
      return json(res, 200, { purchases: db.prepare(`
        SELECT p.*, u.name AS prepared_by_name, a.name AS approved_by_name, s.name AS supplier_name,
          ROUND(p.total_estimate * (1 + ?), 2) AS authorization_limit,
          ROUND(COALESCE((SELECT SUM(amount) FROM payments WHERE purchase_request_id = p.id), 0), 2) AS payment_total
        FROM purchase_requests p
        JOIN users u ON u.id = p.prepared_by
        LEFT JOIN users a ON a.id = p.approved_by
        LEFT JOIN suppliers s ON s.id = p.supplier_id
        ORDER BY p.id DESC LIMIT 100
      `).all(PAYMENT_ALLOWANCE_RATE) });
    }
    if (req.method === "GET" && pathname === "/api/payments") {
      const user = requireUser(req, res, ["ACCOUNTANT", "MANAGER", "OWNER"]);
      if (!user) return;
      return json(res, 200, { payments: db.prepare(`
        SELECT p.*, pr.reference AS purchase_reference, u.name AS prepared_by_name,
          a.name AS approved_by_name, r.name AS released_by_name,
          pr.total_estimate, ROUND(pr.total_estimate * (1 + ?), 2) AS authorization_limit,
          ROUND((SELECT COALESCE(SUM(amount), 0) FROM payments WHERE purchase_request_id = p.purchase_request_id), 2) AS payment_total
        FROM payments p
        JOIN purchase_requests pr ON pr.id = p.purchase_request_id
        JOIN users u ON u.id = p.prepared_by
        LEFT JOIN users a ON a.id = p.approved_by
        LEFT JOIN users r ON r.id = p.released_by
        ORDER BY p.id DESC LIMIT 100
      `).all(PAYMENT_ALLOWANCE_RATE) });
    }
    const purchaseAction = pathname.match(/^\/api\/purchases\/(\d+)\/(approve|hold)$/);
    if (req.method === "POST" && purchaseAction) {
      const user = requireUser(req, res, ["MANAGER", "OWNER"]);
      if (!user) return;
      const purchaseId = Number(purchaseAction[1]);
      const purchase = db.prepare("SELECT * FROM purchase_requests WHERE id = ?").get(purchaseId);
      if (!purchase) return json(res, 404, { error: "Purchase request not found." });
      if (purchase.prepared_by === user.id) return json(res, 403, { error: "Maker-checker rule: the preparer cannot approve this purchase." });
      const status = purchaseAction[2] === "approve" ? "APPROVED" : "HELD";
      db.prepare("UPDATE purchase_requests SET status = ?, approved_by = ?, approved_at = ? WHERE id = ?").run(status, user.id, status === "APPROVED" ? now() : null, purchaseId);
      audit(user, `PURCHASE_${purchaseAction[2].toUpperCase()}`, "purchase_request", purchaseId, { reference: purchase.reference });
      if (status === "APPROVED") createCustodyReceipt(user, { sourceType: "PURCHASE_REQUEST", sourceReference: purchase.reference, action: "PURCHASE_APPROVED", kilos: 0, condition: "APPROVED" });
      return json(res, 200, { purchase: db.prepare("SELECT * FROM purchase_requests WHERE id = ?").get(purchaseId) });
    }
    if (req.method === "POST" && pathname === "/api/payments") {
      const user = requireUser(req, res, ["ACCOUNTANT"]);
      if (!user) return;
      const body = req.parsedBody;
      const purchase = db.prepare("SELECT * FROM purchase_requests WHERE id = ?").get(Number(body.purchaseRequestId));
      const amount = Number(body.amount);
      if (!purchase || !Number.isFinite(amount) || amount < 0 || !["CASH", "BANK", "GCASH"].includes(body.method)) return json(res, 400, { error: "Valid purchase, amount, and payment method are required." });
      if (purchase.status !== "APPROVED") return json(res, 409, { error: "The purchase must be approved before a payment can be recorded." });
      const paidTotal = db.prepare("SELECT COALESCE(SUM(amount), 0) AS total FROM payments WHERE purchase_request_id = ?").get(purchase.id).total;
      const authorizationLimit = Number((purchase.total_estimate * (1 + PAYMENT_ALLOWANCE_RATE)).toFixed(2));
      if (paidTotal + amount > authorizationLimit + 0.005) return json(res, 409, { error: `Payment exceeds the authorized purchase amount, including the 5% allowance of ${authorizationLimit.toFixed(2)}.` });
      const reference = nextReference("PAY");
      const result = db.prepare(`
        INSERT INTO payments (reference, purchase_request_id, amount, method, status, prepared_by, proof_photo, created_at)
        VALUES (?, ?, ?, ?, 'APPROVED', ?, ?, ?)
      `).run(reference, purchase.id, amount, body.method, user.id, body.proofPhoto || null, now());
      audit(user, "PAYMENT_PREPARED", "payment", result.lastInsertRowid, { reference, amount, method: body.method });
      return json(res, 201, { payment: db.prepare("SELECT * FROM payments WHERE id = ?").get(result.lastInsertRowid) });
    }
    const paymentAction = pathname.match(/^\/api\/payments\/(\d+)\/(approve|release)$/);
    if (req.method === "POST" && paymentAction) {
      const user = requireUser(req, res, ["MANAGER", "OWNER", "ACCOUNTANT"]);
      if (!user) return;
      const paymentId = Number(paymentAction[1]);
      const payment = db.prepare("SELECT * FROM payments WHERE id = ?").get(paymentId);
      if (!payment) return json(res, 404, { error: "Payment not found." });
      if (paymentAction[2] === "approve") {
        if (!["MANAGER", "OWNER"].includes(user.role)) return json(res, 403, { error: "Only Manager or Owner can approve payments." });
        if (payment.prepared_by === user.id) return json(res, 403, { error: "Maker-checker rule: the preparer cannot approve this payment." });
        db.prepare("UPDATE payments SET status = 'APPROVED', approved_by = ?, approved_at = ? WHERE id = ?").run(user.id, now(), paymentId);
        audit(user, "PAYMENT_APPROVED", "payment", paymentId, { reference: payment.reference });
      } else {
        if (user.role !== "ACCOUNTANT") return json(res, 403, { error: "Only the Accountant can release an approved payment." });
        if (payment.status !== "APPROVED") return json(res, 409, { error: "Payment must be approved before release." });
        db.prepare("UPDATE payments SET status = 'RELEASED', released_by = ?, released_at = ? WHERE id = ?").run(user.id, now(), paymentId);
        audit(user, "PAYMENT_RELEASED", "payment", paymentId, { reference: payment.reference });
        createCustodyReceipt(user, { sourceType: "PAYMENT", sourceReference: payment.reference, action: "PAYMENT_RELEASED", kilos: 0, condition: payment.method });
      }
      return json(res, 200, { payment: db.prepare("SELECT * FROM payments WHERE id = ?").get(paymentId) });
    }
    if (req.method === "POST" && pathname === "/api/bookings") {
      const user = requireUser(req, res, ["MANAGER", "OWNER"]);
      if (!user) return;
      const body = req.parsedBody;
      const headcount = Number(body.headcount);
      const discount = Number(body.discount || 0);
      if (!body.customerName || !body.serviceDate || !Number.isInteger(headcount) || headcount <= 0 || discount < 0) return json(res, 400, { error: "Customer, service date, headcount, and valid discount are required." });
      const reference = nextReference("BOOK");
      const result = db.prepare(`
        INSERT INTO bookings (reference, customer_name, headcount, service_date, discount, created_by, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(reference, body.customerName, headcount, body.serviceDate, discount, user.id, now());
      audit(user, "BOOKING_CREATED", "booking", result.lastInsertRowid, { reference, headcount, discount });
      return json(res, 201, { booking: db.prepare("SELECT * FROM bookings WHERE id = ?").get(result.lastInsertRowid) });
    }
    if (req.method === "GET" && pathname === "/api/bookings") {
      const user = requireUser(req, res);
      if (!user) return;
      return json(res, 200, { bookings: db.prepare(`
        SELECT b.*, u.name AS created_by_name
        FROM bookings b JOIN users u ON u.id = b.created_by
        ORDER BY b.service_date, b.id DESC LIMIT 100
      `).all() });
    }
    const requestApproval = pathname.match(/^\/api\/requests\/(\d+)\/(approve|return|cancel|reserve|received)$/);
    if (req.method === "POST" && requestApproval) {
      const user = requireUser(req, res, ["MANAGER", "OWNER", "ACCOUNTANT", "KITCHEN"]);
      if (!user) return;
      const requestId = Number(requestApproval[1]);
      const action = requestApproval[2];
      const request = db.prepare("SELECT * FROM requests WHERE id = ?").get(requestId);
      if (!request) return json(res, 404, { error: "Request not found." });
      if (action === "received") {
        if (request.requested_by !== user.id) return json(res, 403, { error: "Only the person who requested this product can mark it received." });
        if (request.status !== "PENDING_FULFILLMENT") return json(res, 409, { error: "Only fulfilled requests can be marked received." });
        db.prepare("UPDATE requests SET status = 'RECEIVED', received_by = ?, received_at = ? WHERE id = ?").run(user.id, now(), requestId);
        audit(user, "REQUEST_RECEIVED", "request", requestId, { reference: request.reference });
        return json(res, 200, { request: db.prepare("SELECT * FROM requests WHERE id = ?").get(requestId) });
      }
      if (user.role === "KITCHEN" && (action !== "cancel" || request.requested_by !== user.id)) return json(res, 403, { error: "Kitchen can only cancel its own draft requests." });
      if (["cancel", "return", "approve"].includes(action) && request.status !== "DRAFT") return json(res, 409, { error: "This request has progressed. Refresh to see its current status." });
      if (action === "reserve" && request.status !== "APPROVED") return json(res, 409, { error: "Only approved requests can be reserved once." });
      if (action === "approve" && !["MANAGER", "OWNER"].includes(user.role)) return json(res, 403, { error: "Only Manager or Owner can approve requests." });
      if (action === "reserve") {
        if (!["ACCOUNTANT", "MANAGER", "OWNER"].includes(user.role)) return json(res, 403, { error: "Only inventory staff can reserve stock." });
        const items = db.prepare("SELECT * FROM request_items WHERE request_id = ?").all(requestId);
        db.exec(res.submission ? "SAVEPOINT operation" : "BEGIN IMMEDIATE");
        try {
          for (const item of items) {
            const stock = db.prepare("SELECT * FROM stock_items WHERE id = ?").get(item.stock_item_id);
            const available = stock.on_hand - stock.reserved;
            const reserved = Math.min(available, item.kilos);
            if (reserved > 0) db.prepare("UPDATE stock_items SET reserved = reserved + ? WHERE id = ?").run(reserved, stock.id);
            if (reserved < item.kilos) createAlert("LOW / OUT OF STOCK", `${stock.name}: ${item.kilos - reserved} kg shortage for ${request.reference}`, "MANAGER", request.reference, user);
          }
          db.prepare("UPDATE requests SET status = 'PENDING_FULFILLMENT' WHERE id = ?").run(requestId);
          audit(user, "REQUEST_RESERVED", "request", requestId, { reference: request.reference });
          db.exec(res.submission ? "RELEASE operation" : "COMMIT");
        } catch (error) {
          db.exec(res.submission ? "ROLLBACK TO operation; RELEASE operation" : "ROLLBACK");
          throw error;
        }
        return json(res, 200, { request: db.prepare("SELECT * FROM requests WHERE id = ?").get(requestId) });
      }
      const nextStatus = action === "approve" ? "APPROVED" : action === "return" ? "RETURNED" : "CANCELLED";
      db.prepare("UPDATE requests SET status = ?, approved_by = ?, approved_at = ? WHERE id = ?").run(nextStatus, action === "approve" ? user.id : null, action === "approve" ? now() : null, requestId);
      audit(user, `REQUEST_${action.toUpperCase()}`, "request", requestId, { reference: request.reference });
      return json(res, 200, { request: db.prepare("SELECT * FROM requests WHERE id = ?").get(requestId) });
    }
    if (req.method === "POST" && pathname === "/api/deliveries") {
      const user = requireUser(req, res, ["ACCOUNTANT", "MANAGER", "OWNER"]);
      if (!user) return;
      const body = req.parsedBody;
      if (!Array.isArray(body.items) || !body.items.length) return json(res, 400, { error: "At least one food item is required." });
      const entries = body.items.map((entry) => ({
        stockItemId: Number(entry.stockItemId),
        name: typeof entry.name === "string" ? entry.name.trim().replace(/\s+/g, " ") : "",
        kilos: Number(entry.kilos),
        acceptedKilos: Number(entry.acceptedKilos ?? entry.kilos),
        rejectedKilos: Number(entry.rejectedKilos ?? 0)
      }));
      if (!entries.every((item) => (Number.isInteger(item.stockItemId) && item.stockItemId > 0 || item.name.length > 0 && item.name.length <= 100) && [item.kilos, item.acceptedKilos, item.rejectedKilos].every(Number.isFinite) && item.kilos > 0 && item.acceptedKilos >= 0 && item.rejectedKilos >= 0 && item.acceptedKilos + item.rejectedKilos <= item.kilos)) return json(res, 400, { error: "A valid food and positive ordered kilos are required; accepted and rejected totals cannot exceed ordered kilos." });
      const reference = nextReference("DR");
      db.exec(res.submission ? "SAVEPOINT operation" : "BEGIN IMMEDIATE");
      try {
        const seen = new Set();
        const items = entries.map((entry) => {
          let stock = entry.stockItemId > 0
            ? db.prepare("SELECT id, name FROM stock_items WHERE id = ?").get(entry.stockItemId)
            : db.prepare("SELECT id, name FROM stock_items WHERE name = ? COLLATE NOCASE").get(entry.name);
          if (!stock && entry.stockItemId > 0) throw new Error("A valid stock item is required. Refresh the food list.");
          if (!stock) {
            const added = db.prepare("INSERT INTO stock_items (name, category) VALUES (?, 'Other')").run(entry.name);
            stock = { id: Number(added.lastInsertRowid), name: entry.name };
            audit(user, "FOOD_ADDED", "stock_item", stock.id, { name: stock.name });
          }
          if (seen.has(stock.id)) throw new Error("A valid delivery must list each food once. Combine duplicate rows.");
          seen.add(stock.id);
          return { ...entry, stockItemId: stock.id, name: stock.name };
        });
        const delivery = db.prepare(`
          INSERT INTO deliveries (reference, supplier_name, status, eta, receipt_photo, notes, received_by, created_at)
          VALUES (?, ?, 'RECEIVED', ?, ?, ?, ?, ?)
        `).run(reference, body.supplierName || "Unspecified supplier", body.eta || null, body.photoPath || null, body.notes || null, user.id, now());
        const addItem = db.prepare(`
          INSERT INTO delivery_items (delivery_id, stock_item_id, ordered_kilos, accepted_kilos, rejected_kilos, condition)
          VALUES (?, ?, ?, ?, ?, ?)
        `);
        for (const item of items) {
          const condition = item.rejectedKilos > 0 ? "PARTIAL / REJECTED" : "ACCEPTED";
          addItem.run(delivery.lastInsertRowid, item.stockItemId, item.kilos, item.acceptedKilos, item.rejectedKilos, condition);
          if (item.acceptedKilos > 0) {
            db.prepare("UPDATE stock_items SET on_hand = on_hand + ? WHERE id = ?").run(item.acceptedKilos, item.stockItemId);
            db.prepare(`
              INSERT INTO inventory_ledger (stock_item_id, action, kilos, reference, actor_id, created_at)
              VALUES (?, 'RECEIPT_ACCEPTED', ?, ?, ?, ?)
            `).run(item.stockItemId, item.acceptedKilos, reference, user.id, now());
          }
        }
        const receipt = createCustodyReceipt(user, {
          sourceType: "DELIVERY",
          deviceId: body.deviceId,
          sourceReference: reference,
          action: "DELIVERY_RECEIVED",
          items: items.map((item) => ({ stockItemId: item.stockItemId, name: item.name, orderedKilos: item.kilos, acceptedKilos: item.acceptedKilos, rejectedKilos: item.rejectedKilos })),
          kilos: items.reduce((sum, item) => sum + item.acceptedKilos, 0),
          condition: items.some((item) => item.rejectedKilos > 0) ? "PARTIAL / REJECTED" : "ACCEPTED",
          photoPath: body.photoPath || null
        });
        if (items.some((item) => item.rejectedKilos > 0)) createAlert("PARTIAL / REJECTED", `Delivery ${reference} has rejected or missing kilos.`, "MANAGER", reference, user);
        db.prepare("INSERT INTO reversible_entries (receipt_id, source_type, source_reference) VALUES (?, ?, ?)").run(receipt.id, receipt.source_type, receipt.source_reference);
        audit(user, "DELIVERY_RECEIVED", "delivery", delivery.lastInsertRowid, { reference });
        db.exec(res.submission ? "RELEASE operation" : "COMMIT");
        return json(res, 201, { delivery: db.prepare("SELECT * FROM deliveries WHERE id = ?").get(delivery.lastInsertRowid), receipt });
      } catch (error) {
        db.exec(res.submission ? "ROLLBACK TO operation; RELEASE operation" : "ROLLBACK");
        throw error;
      }
    }
    if (req.method === "POST" && pathname === "/api/custody") {
      const user = requireUser(req, res, ["OWNER", "MANAGER", "ACCOUNTANT", "KITCHEN", "WAITER"]);
      if (!user) return;
      const body = req.parsedBody;
      if (!body.sourceReference || !body.action) return json(res, 400, { error: "sourceReference and action are required." });
      return json(res, 201, { receipt: createCustodyReceipt(user, body) });
    }
    const custodyCorrection = pathname.match(/^\/api\/custody\/(\d+)\/correct$/);
    if (req.method === "POST" && custodyCorrection) {
      const user = requireUser(req, res, ["OWNER", "MANAGER", "ACCOUNTANT", "KITCHEN", "WAITER"]);
      if (!user) return;
      const original = db.prepare("SELECT * FROM custody_receipts WHERE id = ?").get(Number(custodyCorrection[1]));
      if (!original) return json(res, 404, { error: "Receipt not found." });
      const body = req.parsedBody;
      return json(res, 201, { receipt: createCustodyReceipt(user, {
        ...body,
        sourceType: original.source_type,
        sourceReference: original.source_reference,
        action: "CORRECTION",
        correctionOf: original.id
      }) });
    }
    if (req.method === "POST" && pathname === "/api/batches") {
      const user = requireUser(req, res, ["KITCHEN", "MANAGER", "OWNER"]);
      if (!user) return;
      const body = req.parsedBody;
      const rawKilos = Number(body.rawKilos);
      const cookedKilos = Number(body.cookedKilos);
      const stockItemId = Number(body.stockItemId);
      const freezerKilos = Number(body.freezerKilos || 0);
      if (!stockItemId || ![rawKilos, cookedKilos, freezerKilos].every(Number.isFinite) || rawKilos <= 0 || cookedKilos < 0 || freezerKilos < 0 || freezerKilos > cookedKilos) return json(res, 400, { error: "Valid raw, cooked and freezer kilos are required. Freezer kilos cannot exceed cooked kilos." });
      const stock = db.prepare("SELECT * FROM stock_items WHERE id = ?").get(stockItemId);
      if (!stock || stock.on_hand - stock.reserved < rawKilos) return json(res, 409, { error: "Available stock changed or is insufficient. Refresh availability and adjust raw kilos." });
      const reference = nextReference("BATCH");
      db.exec(res.submission ? "SAVEPOINT operation" : "BEGIN IMMEDIATE");
      try {
        const result = db.prepare(`
          INSERT INTO batches (reference, stock_item_id, raw_kilos, cooked_kilos, freezer_kilos, service, created_by, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `).run(reference, stockItemId, rawKilos, cookedKilos, Number(body.freezerKilos || 0), body.service || "LUNCH", user.id, now());
        db.prepare("UPDATE stock_items SET on_hand = MAX(0, on_hand - ?), freezer = freezer + ? WHERE id = ?").run(rawKilos, Number(body.freezerKilos || 0), stockItemId);
        const receipt = createCustodyReceipt(user, {
          sourceType: "BATCH",
          deviceId: body.deviceId,
          sourceReference: reference,
          action: "RAW_RELEASED_TO_COOK",
          items: [{ stockItemId, rawKilos, cookedKilos, freezerKilos: Number(body.freezerKilos || 0) }],
          kilos: rawKilos,
          condition: "COOKING_STARTED"
        });
        audit(user, "BATCH_CREATED", "batch", result.lastInsertRowid, { reference });
        db.prepare("INSERT INTO reversible_entries (receipt_id, source_type, source_reference) VALUES (?, ?, ?)").run(receipt.id, receipt.source_type, receipt.source_reference);
        db.exec(res.submission ? "RELEASE operation" : "COMMIT");
        return json(res, 201, { batch: db.prepare("SELECT * FROM batches WHERE id = ?").get(result.lastInsertRowid), receipt });
      } catch (error) {
        db.exec(res.submission ? "ROLLBACK TO operation; RELEASE operation" : "ROLLBACK");
        throw error;
      }
    }
    if (req.method === "POST" && pathname === "/api/service-logs") {
      const user = requireUser(req, res, ["KITCHEN", "WAITER", "MANAGER", "OWNER"]);
      if (!user) return;
      const body = req.parsedBody;
      const kilos = Number(body.kilos || 0);
      if (!Number.isFinite(kilos) || kilos <= 0 || !["DISPLAY", "REFILL", "FREEZER_OUT", "LEFTOVER"].includes(body.kind) || !db.prepare("SELECT 1 FROM stock_items WHERE id = ?").get(Number(body.stockItemId)) || !["", "REUSE", "REFREEZE", "DISCARD"].includes(body.decision || "")) return json(res, 400, { error: "A valid event, dish, decision and positive kilos are required." });
      if (body.decision && body.kind !== "LEFTOVER") return json(res, 400, { error: "Decisions apply only to leftover counts." });
      if (body.decision === "DISCARD" && !String(body.reason || "").trim()) return json(res, 400, { error: "A discard reason is required." });
      const result = db.prepare(`
        INSERT INTO service_logs (kind, stock_item_id, kilos, service, decision, reason, actor_id, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(body.kind || "DISPLAY", body.stockItemId ? Number(body.stockItemId) : null, kilos, body.service || null, body.decision || null, body.reason || null, user.id, now());
      const receipt = createCustodyReceipt(user, {
        sourceType: "SERVICE_LOG",
        deviceId: body.deviceId,
        sourceReference: `SERVICE-${result.lastInsertRowid}`,
        action: body.kind || "SERVICE_LOGGED",
        items: body.stockItemId ? [{ stockItemId: Number(body.stockItemId), kilos }] : [],
        kilos,
        condition: body.decision || "RECORDED"
      });
      db.prepare("INSERT INTO reversible_entries (receipt_id, source_type, source_reference) VALUES (?, ?, ?)").run(receipt.id, receipt.source_type, receipt.source_reference);
      return json(res, 201, { log: { id: result.lastInsertRowid }, receipt });
    }
    if (req.method === "POST" && pathname.startsWith("/api/alerts/")) {
      const match = pathname.match(/^\/api\/alerts\/(\d+)\/acknowledge$/);
      if (!match) return json(res, 404, { error: "Alert route not found." });
      const user = requireUser(req, res, ["OWNER", "MANAGER", "ACCOUNTANT", "KITCHEN", "WAITER"]);
      if (!user) return;
      db.prepare("UPDATE alerts SET status = 'ACKNOWLEDGED', acknowledged_by = ?, acknowledged_at = ? WHERE id = ?").run(user.id, now(), Number(match[1]));
      audit(user, "ALERT_ACKNOWLEDGED", "alert", match[1]);
      return json(res, 200, { ok: true });
    }
    return json(res, 404, { error: "API route not found." });
  } catch (error) {
    console.error(error);
    return json(res, error.message.includes("required") || error.message.includes("valid") ? 400 : 500, { error: error.message });
  }
}

function serveStatic(req, res, pathname) {
  const requested = pathname === "/" ? "/index.html" : pathname;
  const filePath = path.normalize(path.join(staticRoot, requested));
  if (!filePath.startsWith(staticRoot)) return text(res, 403, "Forbidden");
  fs.stat(filePath, (error, stats) => {
    if (error || !stats.isFile()) return text(res, 404, "Not found");
    const types = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".json": "application/json", ".svg": "image/svg+xml" };
    res.writeHead(200, { "content-type": types[path.extname(filePath)] || "application/octet-stream" });
    fs.createReadStream(filePath).pipe(res);
  });
}

const server = http.createServer((req, res) => {
  route(req, res).catch((error) => {
    console.error(error);
    json(res, 500, { error: "Unexpected server error." });
  });
});

if (require.main === module) {
  server.listen(PORT, () => console.log(`Tong Seafood Buffet running at http://localhost:${PORT}`));
}

module.exports = { server, dashboard, createCustodyReceipt };
