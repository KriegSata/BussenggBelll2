const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { db, now } = require("./db");

const PORT = Number(process.env.PORT || 3000);
const root = path.join(__dirname, "..");
const staticRoot = fs.existsSync(path.join(root, "dist")) ? path.join(root, "dist") : path.join(root, "public");

const roleNames = {
  OWNER: "Owner / SuperAdmin",
  MANAGER: "Manager / Admin",
  ACCOUNTANT: "Accountant",
  KITCHEN: "Kitchen",
  WAITER: "Waiter"
};

function json(res, status, body) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}

function text(res, status, body, type = "text/plain; charset=utf-8") {
  res.writeHead(status, { "content-type": type });
  res.end(body);
}

function parseJson(req) {
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
    if (!Number.isInteger(stockItemId) || !Number.isFinite(kilos) || kilos <= 0) {
      throw new Error("Each item needs a valid stock item and positive kilos.");
    }
    return { stockItemId, kilos };
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
  const cooked = db.prepare("SELECT COALESCE(SUM(cooked_kilos), 0) AS kilos FROM batches WHERE date(created_at) = date('now')").get().kilos;
  const waste = db.prepare("SELECT COALESCE(SUM(kilos), 0) AS kilos FROM service_logs WHERE kind = 'LEFTOVER' AND decision = 'DISCARD' AND date(created_at) = date('now')").get().kilos;
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
          SELECT c.*, u.name AS actor_name, u.role AS actor_role_name
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
      const user = requireUser(req, res, ["KITCHEN", "MANAGER"]);
      if (!user) return;
      const body = await parseJson(req);
      const items = safeItems(body.items);
      const reference = nextReference("RF");
      const createdAt = now();
      db.exec("BEGIN IMMEDIATE");
      try {
        const result = db.prepare(`
          INSERT INTO requests (reference, service, requested_by, status, notes, created_at)
          VALUES (?, ?, ?, 'DRAFT', ?, ?)
        `).run(reference, body.service || "LUNCH", user.id, body.notes || null, createdAt);
        const addItem = db.prepare("INSERT INTO request_items (request_id, stock_item_id, kilos) VALUES (?, ?, ?)");
        for (const item of items) addItem.run(result.lastInsertRowid, item.stockItemId, item.kilos);
        audit(user, "REQUEST_CREATED", "request", result.lastInsertRowid, { reference });
        db.exec("COMMIT");
        return json(res, 201, { request: db.prepare("SELECT * FROM requests WHERE id = ?").get(result.lastInsertRowid) });
      } catch (error) {
        db.exec("ROLLBACK");
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
      const body = await parseJson(req);
      const items = safeItems(body.items);
      const reference = nextReference("PR");
      const totalEstimate = items.reduce((sum, item) => sum + item.kilos * Number(item.estimatedPrice || 0), 0);
      db.exec("BEGIN IMMEDIATE");
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
        db.exec("COMMIT");
        return json(res, 201, { purchase: db.prepare("SELECT * FROM purchase_requests WHERE id = ?").get(purchase.lastInsertRowid) });
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    }
    if (req.method === "GET" && pathname === "/api/purchases") {
      const user = requireUser(req, res);
      if (!user) return;
      return json(res, 200, { purchases: db.prepare(`
        SELECT p.*, u.name AS prepared_by_name, a.name AS approved_by_name, s.name AS supplier_name
        FROM purchase_requests p
        JOIN users u ON u.id = p.prepared_by
        LEFT JOIN users a ON a.id = p.approved_by
        LEFT JOIN suppliers s ON s.id = p.supplier_id
        ORDER BY p.id DESC LIMIT 100
      `).all() });
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
      const user = requireUser(req, res, ["ACCOUNTANT", "MANAGER", "OWNER"]);
      if (!user) return;
      const body = await parseJson(req);
      const purchase = db.prepare("SELECT * FROM purchase_requests WHERE id = ?").get(Number(body.purchaseRequestId));
      const amount = Number(body.amount);
      if (!purchase || !Number.isFinite(amount) || amount < 0 || !["CASH", "BANK", "GCASH"].includes(body.method)) return json(res, 400, { error: "Valid purchase, amount, and payment method are required." });
      const reference = nextReference("PAY");
      const result = db.prepare(`
        INSERT INTO payments (reference, purchase_request_id, amount, method, prepared_by, proof_photo, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(reference, purchase.id, amount, body.method, user.id, body.proofPhoto || null, now());
      audit(user, "PAYMENT_PREPARED", "payment", result.lastInsertRowid, { reference, amount, method: body.method });
      createAlert("PENDING APPROVAL", `Payment ${reference} is waiting for approval.`, "MANAGER", reference, user);
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
      const body = await parseJson(req);
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
    const requestApproval = pathname.match(/^\/api\/requests\/(\d+)\/(approve|return|cancel|reserve)$/);
    if (req.method === "POST" && requestApproval) {
      const user = requireUser(req, res, ["MANAGER", "OWNER", "ACCOUNTANT"]);
      if (!user) return;
      const requestId = Number(requestApproval[1]);
      const action = requestApproval[2];
      const request = db.prepare("SELECT * FROM requests WHERE id = ?").get(requestId);
      if (!request) return json(res, 404, { error: "Request not found." });
      if (action === "approve" && !["MANAGER", "OWNER"].includes(user.role)) return json(res, 403, { error: "Only Manager or Owner can approve requests." });
      if (action === "reserve") {
        if (!["ACCOUNTANT", "MANAGER", "OWNER"].includes(user.role)) return json(res, 403, { error: "Only inventory staff can reserve stock." });
        const items = db.prepare("SELECT * FROM request_items WHERE request_id = ?").all(requestId);
        db.exec("BEGIN IMMEDIATE");
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
          db.exec("COMMIT");
        } catch (error) {
          db.exec("ROLLBACK");
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
      const body = await parseJson(req);
      const items = safeItems(body.items).map((item) => ({
        ...item,
        acceptedKilos: Math.max(0, Number(body.items.find((entry) => Number(entry.stockItemId) === item.stockItemId)?.acceptedKilos ?? item.kilos)),
        rejectedKilos: Math.max(0, Number(body.items.find((entry) => Number(entry.stockItemId) === item.stockItemId)?.rejectedKilos ?? 0))
      }));
      const reference = nextReference("DR");
      db.exec("BEGIN IMMEDIATE");
      try {
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
          sourceReference: reference,
          action: "DELIVERY_RECEIVED",
          items: items.map((item) => ({ stockItemId: item.stockItemId, orderedKilos: item.kilos, acceptedKilos: item.acceptedKilos, rejectedKilos: item.rejectedKilos })),
          kilos: items.reduce((sum, item) => sum + item.acceptedKilos, 0),
          condition: items.some((item) => item.rejectedKilos > 0) ? "PARTIAL / REJECTED" : "ACCEPTED",
          photoPath: body.photoPath || null
        });
        if (items.some((item) => item.rejectedKilos > 0)) createAlert("PARTIAL / REJECTED", `Delivery ${reference} has rejected or missing kilos.`, "MANAGER", reference, user);
        audit(user, "DELIVERY_RECEIVED", "delivery", delivery.lastInsertRowid, { reference });
        db.exec("COMMIT");
        return json(res, 201, { delivery: db.prepare("SELECT * FROM deliveries WHERE id = ?").get(delivery.lastInsertRowid), receipt });
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    }
    if (req.method === "POST" && pathname === "/api/custody") {
      const user = requireUser(req, res, ["OWNER", "MANAGER", "ACCOUNTANT", "KITCHEN", "WAITER"]);
      if (!user) return;
      const body = await parseJson(req);
      if (!body.sourceReference || !body.action) return json(res, 400, { error: "sourceReference and action are required." });
      return json(res, 201, { receipt: createCustodyReceipt(user, body) });
    }
    const custodyCorrection = pathname.match(/^\/api\/custody\/(\d+)\/correct$/);
    if (req.method === "POST" && custodyCorrection) {
      const user = requireUser(req, res, ["OWNER", "MANAGER", "ACCOUNTANT", "KITCHEN", "WAITER"]);
      if (!user) return;
      const original = db.prepare("SELECT * FROM custody_receipts WHERE id = ?").get(Number(custodyCorrection[1]));
      if (!original) return json(res, 404, { error: "Receipt not found." });
      const body = await parseJson(req);
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
      const body = await parseJson(req);
      const rawKilos = Number(body.rawKilos);
      const cookedKilos = Number(body.cookedKilos);
      const stockItemId = Number(body.stockItemId);
      if (!stockItemId || rawKilos <= 0 || cookedKilos < 0) return json(res, 400, { error: "Valid raw and cooked kilos are required." });
      const reference = nextReference("BATCH");
      db.exec("BEGIN IMMEDIATE");
      try {
        const result = db.prepare(`
          INSERT INTO batches (reference, stock_item_id, raw_kilos, cooked_kilos, freezer_kilos, service, created_by, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `).run(reference, stockItemId, rawKilos, cookedKilos, Number(body.freezerKilos || 0), body.service || "LUNCH", user.id, now());
        db.prepare("UPDATE stock_items SET on_hand = MAX(0, on_hand - ?), freezer = freezer + ? WHERE id = ?").run(rawKilos, Number(body.freezerKilos || 0), stockItemId);
        createCustodyReceipt(user, {
          sourceType: "BATCH",
          sourceReference: reference,
          action: "RAW_RELEASED_TO_COOK",
          items: [{ stockItemId, rawKilos, cookedKilos, freezerKilos: Number(body.freezerKilos || 0) }],
          kilos: rawKilos,
          condition: "COOKING_STARTED"
        });
        audit(user, "BATCH_CREATED", "batch", result.lastInsertRowid, { reference });
        db.exec("COMMIT");
        return json(res, 201, { batch: db.prepare("SELECT * FROM batches WHERE id = ?").get(result.lastInsertRowid) });
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    }
    if (req.method === "POST" && pathname === "/api/service-logs") {
      const user = requireUser(req, res, ["KITCHEN", "WAITER", "MANAGER", "OWNER"]);
      if (!user) return;
      const body = await parseJson(req);
      const kilos = Number(body.kilos || 0);
      const result = db.prepare(`
        INSERT INTO service_logs (kind, stock_item_id, kilos, service, decision, reason, actor_id, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(body.kind || "DISPLAY", body.stockItemId ? Number(body.stockItemId) : null, kilos, body.service || null, body.decision || null, body.reason || null, user.id, now());
      const receipt = createCustodyReceipt(user, {
        sourceType: "SERVICE_LOG",
        sourceReference: `SERVICE-${result.lastInsertRowid}`,
        action: body.kind || "SERVICE_LOGGED",
        items: body.stockItemId ? [{ stockItemId: Number(body.stockItemId), kilos }] : [],
        kilos,
        condition: body.decision || "RECORDED"
      });
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
