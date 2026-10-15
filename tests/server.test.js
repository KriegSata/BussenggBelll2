const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const testDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "tong-tests-"));
process.env.TONG_DATA_DIR = testDataDir;
const { server } = require("../src/server");
const { db } = require("../src/db");

let baseUrl;
let address;

test.before(async () => {
  await new Promise((resolve) => server.listen(0, resolve));
  address = server.address();
  baseUrl = `http://127.0.0.1:${address.port}`;
});

test.after(async () => {
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  db.close();
  assert.ok(path.resolve(testDataDir).startsWith(path.resolve(os.tmpdir()) + path.sep));
  fs.rmSync(testDataDir, { recursive: true, force: true });
});

async function request(path, options = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    ...options,
    headers: { "content-type": "application/json", "x-user-id": "owner-1", ...(options.headers || {}) }
  });
  return { response, body: await response.json() };
}

test("health endpoint responds", async () => {
  const { response, body } = await request("/api/health");
  assert.equal(response.status, 200);
  assert.equal(body.ok, true);
});

test("bootstrap provides all station users and inventory", async () => {
  const { response, body } = await request("/api/bootstrap");
  assert.equal(response.status, 200);
  assert.equal(body.users.length, 5);
  assert.ok(body.items.some((item) => item.name === "Shrimp"));
});

test("delivery creates immutable acknowledgement receipt and accepted stock", async () => {
  const before = (await request("/api/inventory")).body.items.find((item) => item.name === "Ice").onHand;
  const delivery = await request("/api/deliveries", {
    method: "POST",
    headers: { "x-user-id": "accountant-1" },
    body: JSON.stringify({ supplierName: "Pasil Seafood Market", photoPath: "receipt.jpg", items: [{ stockItemId: 5, kilos: 4, acceptedKilos: 4, rejectedKilos: 0 }] })
  });
  assert.equal(delivery.response.status, 201);
  assert.equal(delivery.body.receipt.action, "DELIVERY_RECEIVED");
  assert.equal(delivery.body.receipt.actor_id, "accountant-1");
  const after = (await request("/api/inventory")).body.items.find((item) => item.name === "Ice").onHand;
  assert.equal(after, before + 4);
  const custody = await request(`/api/custody?sourceReference=${encodeURIComponent(delivery.body.delivery.reference)}`);
  assert.equal(custody.body.receipts.length, 1);
  assert.equal(custody.body.receipts[0].actor_name, "Receiving Accountant");
});

test("maker-checker blocks accountant from approving a purchase request", async () => {
  const created = await request("/api/requests", {
    method: "POST",
    headers: { "x-user-id": "kitchen-1" },
    body: JSON.stringify({ service: "DINNER", items: [{ stockItemId: 1, kilos: 2 }] })
  });
  assert.equal(created.response.status, 201);
  const response = await request(`/api/requests/${created.body.request.id}/approve`, { method: "POST", headers: { "x-user-id": "accountant-1" } });
  assert.equal(response.response.status, 403);
});

test("purchase approval and payment release preserve maker-checker custody", async () => {
  const purchase = await request("/api/purchases", {
    method: "POST",
    headers: { "x-user-id": "accountant-1" },
    body: JSON.stringify({ supplierId: 1, items: [{ stockItemId: 1, kilos: 3, estimatedPrice: 350 }] })
  });
  assert.equal(purchase.response.status, 201);
  const approved = await request(`/api/purchases/${purchase.body.purchase.id}/approve`, {
    method: "POST",
    headers: { "x-user-id": "manager-1" }
  });
  assert.equal(approved.response.status, 200);
  const payment = await request("/api/payments", {
    method: "POST",
    headers: { "x-user-id": "accountant-1" },
    body: JSON.stringify({ purchaseRequestId: purchase.body.purchase.id, amount: 1050, method: "GCASH" })
  });
  assert.equal(payment.response.status, 201);
  const paid = await request(`/api/payments/${payment.body.payment.id}/approve`, {
    method: "POST",
    headers: { "x-user-id": "manager-1" }
  });
  assert.equal(paid.response.status, 200);
  const released = await request(`/api/payments/${payment.body.payment.id}/release`, {
    method: "POST",
    headers: { "x-user-id": "accountant-1" }
  });
  assert.equal(released.response.status, 200);
  assert.equal(released.body.payment.status, "RELEASED");
  const custody = await request(`/api/custody?sourceReference=${encodeURIComponent(payment.body.payment.reference)}`);
  assert.ok(custody.body.receipts.some((receipt) => receipt.action === "PAYMENT_RELEASED"));
});

test("kiosk opens without authentication headers", async () => {
  const response = await fetch(`${baseUrl}/api/bootstrap`);
  assert.equal(response.status, 200);
  assert.equal((await response.json()).users.length, 5);
});

test("simultaneous keyed deliveries save once and replay the same receipt", async () => {
  const before = (await request('/api/inventory')).body.items.find((item) => item.id === 5).onHand;
  const options = { method: 'POST', headers: { 'idempotency-key': 'duplicate-delivery', 'x-user-id': 'accountant-1' }, body: JSON.stringify({ supplierName: 'Test supplier', items: [{ stockItemId: 5, kilos: 3 }] }) };
  const results = await Promise.all(Array.from({ length: 6 }, () => request('/api/deliveries', options)));
  assert.ok(results.every((result) => result.response.status === 201));
  assert.equal(new Set(results.map((result) => result.body.receipt.id)).size, 1);
  const after = (await request('/api/inventory')).body.items.find((item) => item.id === 5).onHand;
  assert.equal(after, before + 3);
  const conflict = await request('/api/deliveries', { ...options, body: JSON.stringify({ supplierName: 'Different supplier', items: [{ stockItemId: 5, kilos: 3 }] }) });
  assert.equal(conflict.response.status, 409);
});

test("delivery undo restores stock once and retains a linked receipt", async () => {
  const before = (await request('/api/inventory')).body.items.find((item) => item.id === 5).onHand;
  const created = await request('/api/deliveries', { method: 'POST', body: JSON.stringify({ supplierName: 'Undo supplier', deviceId: 'test-device', items: [{ stockItemId: 5, kilos: 2 }] }) });
  assert.equal(created.body.receipt.device_id, 'test-device');
  const undoPath = `/api/custody/${created.body.receipt.id}/undo`;
  const reversed = await request(undoPath, { method: 'POST', headers: { 'idempotency-key': 'undo-delivery' } });
  assert.equal(reversed.response.status, 200);
  assert.equal(reversed.body.receipt.correction_of, created.body.receipt.id);
  assert.equal((await request(undoPath, { method: 'POST', headers: { 'idempotency-key': 'undo-delivery' } })).response.status, 200);
  assert.equal((await request(undoPath, { method: 'POST' })).response.status, 409);
  assert.equal((await request('/api/inventory')).body.items.find((item) => item.id === 5).onHand, before);
  assert.equal((await request(`/api/custody?sourceReference=${created.body.delivery.reference}`)).body.receipts.length, 2);
});

test("batch undo restores raw and freezer inventory and cooked totals", async () => {
  const before = (await request('/api/inventory')).body.items.find((item) => item.id === 1);
  const cooked = (await request('/api/dashboard')).body.cooked;
  const created = await request('/api/batches', { method: 'POST', headers: { 'idempotency-key': 'batch-create' }, body: JSON.stringify({ stockItemId: 1, rawKilos: 2, cookedKilos: 1.5, freezerKilos: 0.5 }) });
  assert.equal(created.response.status, 201);
  assert.equal((await request('/api/dashboard')).body.cooked, cooked + 1.5);
  const reversed = await request(`/api/custody/${created.body.receipt.id}/undo`, { method: 'POST', headers: { 'idempotency-key': 'batch-undo' } });
  assert.equal(reversed.response.status, 200);
  const after = (await request('/api/inventory')).body.items.find((item) => item.id === 1);
  assert.equal(after.onHand, before.onHand);
  assert.equal(after.freezer, before.freezer);
  assert.equal((await request('/api/dashboard')).body.cooked, cooked);
});

test("inventory undo refuses later dependent handoffs", async () => {
  const delivery = await request('/api/deliveries', { method: 'POST', body: JSON.stringify({ items: [{ stockItemId: 1, kilos: 1 }] }) });
  await request('/api/batches', { method: 'POST', body: JSON.stringify({ stockItemId: 1, rawKilos: 1, cookedKilos: 0.8 }) });
  assert.equal((await request(`/api/custody/${delivery.body.receipt.id}/undo`, { method: 'POST' })).response.status, 409);
});

test("stock conflicts and invalid freezer allocation do not write batches", async () => {
  const before = (await request('/api/inventory')).body.items.find((item) => item.id === 1);
  const conflict = await request('/api/batches', { method: 'POST', headers: { 'idempotency-key': 'invalid-batch' }, body: JSON.stringify({ stockItemId: 1, rawKilos: before.onHand + 10, cookedKilos: 1 }) });
  assert.equal(conflict.response.status, 409);
  const invalid = await request('/api/batches', { method: 'POST', body: JSON.stringify({ stockItemId: 1, rawKilos: 1, cookedKilos: 0.5, freezerKilos: 1 }) });
  assert.equal(invalid.response.status, 400);
  assert.deepEqual((await request('/api/inventory')).body.items.find((item) => item.id === 1), before);
  const retry = await request('/api/batches', { method: 'POST', headers: { 'idempotency-key': 'invalid-batch' }, body: JSON.stringify({ stockItemId: 1, rawKilos: 1, cookedKilos: 0.5 }) });
  assert.equal(retry.response.status, 201);
});

test("service validation and undo keep waste totals consistent", async () => {
  const before = (await request('/api/dashboard')).body.waste;
  const input = { stockItemId: 1, kind: 'LEFTOVER', kilos: 1, decision: 'DISCARD' };
  assert.equal((await request('/api/service-logs', { method: 'POST', body: JSON.stringify(input) })).response.status, 400);
  const created = await request('/api/service-logs', { method: 'POST', headers: { 'idempotency-key': 'service-create' }, body: JSON.stringify({ ...input, reason: 'Test correction' }) });
  assert.equal(created.response.status, 201);
  assert.equal((await request('/api/dashboard')).body.waste, before + 1);
  const reversed = await request(`/api/custody/${created.body.receipt.id}/undo`, { method: 'POST' });
  assert.equal(reversed.response.status, 200);
  assert.equal((await request('/api/dashboard')).body.waste, before);
  assert.equal((await request(`/api/custody/${reversed.body.receipt.id}/undo`, { method: 'POST' })).response.status, 409);
});

test("kitchen can cancel its own draft but cannot cancel approved requests", async () => {
  const headers = { 'x-user-id': 'kitchen-1' };
  const create = () => request('/api/requests', { method: 'POST', headers, body: JSON.stringify({ items: [{ stockItemId: 1, kilos: 1 }] }) });
  const draft = await create();
  assert.equal((await request(`/api/requests/${draft.body.request.id}/cancel`, { method: 'POST', headers })).response.status, 200);
  const progressed = await create();
  await request(`/api/requests/${progressed.body.request.id}/approve`, { method: 'POST' });
  assert.equal((await request(`/api/requests/${progressed.body.request.id}/cancel`, { method: 'POST', headers })).response.status, 409);
  assert.equal((await request(`/api/requests/${progressed.body.request.id}/reserve`, { method: 'POST' })).response.status, 200);
  assert.equal((await request(`/api/requests/${progressed.body.request.id}/reserve`, { method: 'POST' })).response.status, 409);
});

test("a manually recorded receipt cannot manufacture an inventory reversal", async () => {
  const before = (await request('/api/inventory')).body.items;
  const manual = await request('/api/custody', { method: 'POST', body: JSON.stringify({ sourceType: 'BATCH', sourceReference: 'MANUAL-BATCH', action: 'RAW_RELEASED_TO_COOK', kilos: 100, items: [{ stockItemId: 1, rawKilos: 100, freezerKilos: 0 }] }) });
  assert.equal(manual.response.status, 201);
  assert.equal((await request(`/api/custody/${manual.body.receipt.id}/undo`, { method: 'POST' })).response.status, 409);
  assert.deepEqual((await request('/api/inventory')).body.items, before);
});
