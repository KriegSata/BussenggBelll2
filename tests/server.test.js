const test = require("node:test");
const assert = require("node:assert/strict");
const { server } = require("../src/server");

let baseUrl;
let address;

test.before(async () => {
  await new Promise((resolve) => server.listen(0, resolve));
  address = server.address();
  baseUrl = `http://127.0.0.1:${address.port}`;
});

test.after(async () => {
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
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
