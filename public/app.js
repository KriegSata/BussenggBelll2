const state = { user: null, bootstrap: null, dashboard: null };
const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: { "content-type": "application/json", "x-user-id": state.user?.id || "owner-1", ...(options.headers || {}) }
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || `Request failed (${response.status})`);
  return body;
}

function showNotice(message, error = false) {
  const notice = $("#notice");
  notice.textContent = message;
  notice.className = `notice${error ? " error" : ""}`;
  window.setTimeout(() => notice.classList.add("hidden"), 5000);
}

function kg(value) {
  return `${Number(value || 0).toLocaleString(undefined, { maximumFractionDigits: 1 })} kg`;
}

function setView(view) {
  $$(".tab").forEach((button) => button.classList.toggle("active", button.dataset.view === view));
  $$(".view").forEach((section) => section.classList.toggle("active", section.id === `${view}-view`));
  if (view === "custody") loadCustody();
  if (view === "requests") loadRequests();
}

function itemOptions() {
  return state.bootstrap.items.map((item) => `<option value="${item.id}">${item.name} (${kg(item.onHand - item.reserved)} available)</option>`).join("");
}

function renderMetrics() {
  const data = state.dashboard;
  $("#metrics").innerHTML = [
    ["Available stock", kg(data.onHand - data.reserved), "usable kg"],
    ["Reserved", kg(data.reserved), "held for requests"],
    ["Freezer", kg(data.freezer), "prepared kg"],
    ["Cooked today", kg(data.cooked), "production output"],
    ["Open alerts", data.openAlerts, "needs attention"]
  ].map(([label, value, detail]) => `<div class="metric"><strong>${value}</strong><span>${label} · ${detail}</span></div>`).join("");
}

async function loadDashboard() {
  state.dashboard = await api("/api/dashboard");
  renderMetrics();
  $("#recent-custody").innerHTML = state.dashboard.recentCustody.length
    ? state.dashboard.recentCustody.map(receiptLine).join("")
    : `<div class="empty small">No handoffs recorded yet.</div>`;
  await loadAlerts();
}

async function loadAlerts() {
  const { alerts } = await api("/api/alerts");
  $("#alerts").innerHTML = alerts.length ? alerts.map((alert) => `
    <div class="alert">
      <strong>${alert.type}</strong>
      <div>${alert.message}</div>
      <div class="small">${new Date(alert.created_at).toLocaleString()} · ${alert.status}</div>
      ${alert.status === "OPEN" ? `<button class="text-button" data-alert-id="${alert.id}">Acknowledge</button>` : ""}
    </div>
  `).join("") : `<div class="empty small">Everything is clear.</div>`;
  $$("[data-alert-id]").forEach((button) => button.addEventListener("click", async () => {
    try { await api(`/api/alerts/${button.dataset.alertId}/acknowledge`, { method: "POST" }); showNotice("Alert acknowledged."); await loadAlerts(); } catch (error) { showNotice(error.message, true); }
  }));
}

function receiptLine(receipt) {
  const actor = receipt.actor_name || receipt.actor_role_name || receipt.actor_role;
  return `<div class="receipt-line"><strong>${receipt.action.replaceAll("_", " ")} · ${receipt.kilos ? kg(receipt.kilos) : "recorded"}</strong><div>${receipt.source_reference} · ${actor}</div><div class="small">${receipt.station} · ${new Date(receipt.created_at).toLocaleString()} · ${receipt.receipt_number}</div></div>`;
}

async function loadRequests() {
  const { requests } = await api("/api/requests");
  $("#requests").innerHTML = requests.length ? `<table><thead><tr><th>Reference</th><th>Service</th><th>Kilos</th><th>Status</th><th>Requested by</th><th>Actions</th></tr></thead><tbody>${requests.map((request) => `<tr><td><strong>${request.reference}</strong></td><td>${request.service}</td><td>${kg(request.kilos)}</td><td><span class="pill">${request.status.replaceAll("_", " ")}</span></td><td>${request.requested_by_name}</td><td>${request.status === "DRAFT" && ["MANAGER", "OWNER"].includes(state.user.role) ? `<button class="text-button" data-request-action="approve" data-request-id="${request.id}">Approve</button>` : ""}${request.status === "APPROVED" && ["ACCOUNTANT", "MANAGER", "OWNER"].includes(state.user.role) ? `<button class="text-button" data-request-action="reserve" data-request-id="${request.id}">Reserve stock</button>` : ""}</td></tr>`).join("")}</tbody></table>` : `<div class="empty small">No requests yet.</div>`;
  $$("[data-request-action]").forEach((button) => button.addEventListener("click", async () => {
    try { await api(`/api/requests/${button.dataset.requestId}/${button.dataset.requestAction}`, { method: "POST" }); showNotice("Request updated."); await loadRequests(); await loadDashboard(); } catch (error) { showNotice(error.message, true); }
  }));
}

function buildForms() {
  $("#request-items").innerHTML = `<div class="item-row"><label>Dish / stock item<select class="request-item">${itemOptions()}</select></label><label>Kilos<input class="request-kilos" type="number" min="0.1" step="0.1" value="1"></label></div>`;
  $("#delivery-items").innerHTML = state.bootstrap.items.slice(0, 4).map((item) => `<div class="item-row"><label>${item.name}<select class="delivery-item" data-stock-id="${item.id}"><option value="0">Not delivered</option><option value="${item.onHand}">Use expected amount</option></select></label><label>Accepted kg<input class="accepted-kilos" data-stock-id="${item.id}" type="number" min="0" step="0.1" value="0"></label></div>`).join("");
  $$(".item-select").forEach((select) => { select.innerHTML = itemOptions(); });
}

async function submitRequest(event) {
  event.preventDefault();
  try {
    const items = $$(".request-item").map((select, index) => ({ stockItemId: Number(select.value), kilos: Number($$(".request-kilos")[index].value) }));
    await api("/api/requests", { method: "POST", body: JSON.stringify({ service: $("#request-service").value, notes: $("#request-notes").value, items }) });
    $("#request-form").classList.add("hidden"); showNotice("Request submitted."); await loadRequests(); await loadDashboard();
  } catch (error) { showNotice(error.message, true); }
}

async function submitDelivery(event) {
  event.preventDefault();
  try {
    const items = $$(".accepted-kilos").map((input) => {
      const stockItemId = Number(input.dataset.stockId);
      const acceptedKilos = Number(input.value);
      return { stockItemId, kilos: acceptedKilos, acceptedKilos, rejectedKilos: 0 };
    }).filter((item) => item.acceptedKilos > 0);
    if (!items.length) throw new Error("Enter accepted kilos for at least one item.");
    await api("/api/deliveries", { method: "POST", body: JSON.stringify({ supplierName: $("#supplier-name").value, photoPath: $("#delivery-photo").value, items }) });
    event.target.reset(); showNotice("Delivery recorded. Digital acknowledgement receipt created."); await loadDashboard();
  } catch (error) { showNotice(error.message, true); }
}

async function submitBatch(event) {
  event.preventDefault();
  try {
    await api("/api/batches", { method: "POST", body: JSON.stringify({ stockItemId: Number($("#batch-item").value), rawKilos: Number($("#raw-kilos").value), cookedKilos: Number($("#cooked-kilos").value), freezerKilos: Number($("#freezer-kilos").value), service: $("#batch-service").value }) });
    event.target.reset(); showNotice("Batch logged and raw-stock handoff acknowledged."); await loadDashboard();
  } catch (error) { showNotice(error.message, true); }
}

async function submitService(event) {
  event.preventDefault();
  try {
    const decision = $("#service-decision").value;
    if (decision === "DISCARD" && !$("#service-reason").value.trim()) throw new Error("Add a reason before recording discard.");
    await api("/api/service-logs", { method: "POST", body: JSON.stringify({ kind: $("#service-kind").value, stockItemId: Number($("#service-item").value), kilos: Number($("#service-kilos").value), decision, reason: $("#service-reason").value }) });
    event.target.reset(); showNotice("Service event logged and acknowledged."); await loadDashboard();
  } catch (error) { showNotice(error.message, true); }
}

async function loadCustody() {
  const { receipts } = await api("/api/custody");
  $("#custody-table").innerHTML = receipts.length ? `<table><thead><tr><th>Receipt</th><th>Event</th><th>Reference</th><th>Person / station</th><th>Kilos</th><th>When</th></tr></thead><tbody>${receipts.map((receipt) => `<tr><td><strong>${receipt.receipt_number}</strong></td><td>${receipt.action.replaceAll("_", " ")}<br><span class="small">${receipt.condition || ""}</span></td><td>${receipt.source_reference}</td><td>${receipt.actor_name}<br><span class="small">${receipt.actor_role} · ${receipt.station} · ${receipt.device_id}</span></td><td>${kg(receipt.kilos)}</td><td>${new Date(receipt.created_at).toLocaleString()}</td></tr>`).join("")}</tbody></table>` : `<div class="empty small">No custody receipts yet.</div>`;
}

async function start() {
  state.bootstrap = await api("/api/bootstrap");
  state.user = state.bootstrap.currentUser;
  $("#user-select").innerHTML = state.bootstrap.users.map((user) => `<option value="${user.id}">${user.name} · ${user.station}</option>`).join("");
  $("#user-select").value = state.user.id;
  $("#welcome").textContent = `${state.user.station} · ${state.user.name}`;
  buildForms();
  await loadDashboard();
}

$$(".tab").forEach((button) => button.addEventListener("click", () => setView(button.dataset.view)));
$$("[data-view-target]").forEach((button) => button.addEventListener("click", () => setView(button.dataset.viewTarget)));
$("#new-request-button").addEventListener("click", () => $("#request-form").classList.remove("hidden"));
$("#cancel-request").addEventListener("click", () => $("#request-form").classList.add("hidden"));
$("#refresh-alerts").addEventListener("click", loadAlerts);
$("#request-form-element").addEventListener("submit", submitRequest);
$("#delivery-form").addEventListener("submit", submitDelivery);
$("#batch-form").addEventListener("submit", submitBatch);
$("#service-form").addEventListener("submit", submitService);
$("#print-custody").addEventListener("click", () => window.print());
$("#user-select").addEventListener("change", async (event) => {
  state.user = state.bootstrap.users.find((user) => user.id === event.target.value);
  $("#welcome").textContent = `${state.user.station} · ${state.user.name}`;
  buildForms();
  await loadDashboard();
});
let deferredInstall;
window.addEventListener("beforeinstallprompt", (event) => { event.preventDefault(); deferredInstall = event; $("#install-button").classList.remove("hidden"); });
$("#install-button").addEventListener("click", async () => { if (!deferredInstall) return; deferredInstall.prompt(); deferredInstall = null; $("#install-button").classList.add("hidden"); });
if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js").catch(() => {});
start().catch((error) => showNotice(error.message, true));
