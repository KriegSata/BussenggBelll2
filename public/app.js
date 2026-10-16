const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const state = { user: null, bootstrap: null, task: null, undo: null, busy: false, correction: null, activityReceipts: [] };
const titles = { request: 'Request stock', delivery: 'Receive delivery', batch: 'Log cooking', service: 'Log service', activity: 'Recent activity', overview: 'Overview', override: 'Overide', payments: 'Payments' };
const tasks = { KITCHEN: ['request', 'batch', 'service'], WAITER: ['service'], ACCOUNTANT: ['delivery', 'request', 'payments'], MANAGER: ['request', 'delivery', 'batch', 'service', 'payments'], OWNER: ['request', 'delivery', 'batch', 'service', 'payments'] };
const oversightRoles = ['MANAGER', 'OWNER'];
const oversightTasks = tasks.MANAGER;
const forms = { request: 'request-form', delivery: 'delivery-form', batch: 'batch-form', service: 'service-form' };
const store = {
  memory: new Map(),
  get(key, fallback = null) { try { return JSON.parse(localStorage.getItem(`tong:${key}`)) ?? this.memory.get(key) ?? fallback; } catch { return this.memory.get(key) ?? fallback; } },
  set(key, value) { this.memory.set(key, value); try { localStorage.setItem(`tong:${key}`, JSON.stringify(value)); } catch { /* Keep drafts and retry keys in memory when device storage is unavailable. */ } }
};
const escapeHTML = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const kg = (value) => `${Number(value || 0).toLocaleString(undefined, { maximumFractionDigits: 1 })} kg`;
const key = (kind, task) => `${kind}:${state.user.id}:${task}`;
const id = () => crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
let deviceId = store.get('device');
if (!deviceId) { deviceId = id(); store.set('device', deviceId); }

async function api(path, options = {}) {
  let response;
  try {
    response = await fetch(path, { signal: AbortSignal.timeout(12000), ...options, headers: { 'content-type': 'application/json', 'x-user-id': state.user?.id || 'kitchen-1', ...options.headers } });
  } catch { throw Object.assign(new Error('Connection interrupted. Your entry is kept. Retry to check and save it safely.'), { uncertain: true }); }
  const body = await response.json().catch(() => null);
  if (!response.ok || !body) throw Object.assign(new Error(body?.error || 'Could not confirm the save. Retry safely.'), { status: response.status, uncertain: response.status >= 500 || !body });
  return body;
}
function feedback(message, error = false, undo = null) {
  $('#feedback').hidden = false;
  $('#feedback').classList.toggle('error', error);
  $('#feedback-message').textContent = message;
  state.undo = undo;
  $('#undo-button').hidden = !undo;
  if (undo) store.set(`last-undo:${state.user.id}`, undo);
}
function formError(form, message) {
  const error = $('.form-error', form);
  error.textContent = message;
  error.classList.toggle('hidden', !message);
}
function fieldValues(form) {
  const values = $$('input, select, textarea', form).filter((field) => field.id).reduce((values, field) => ({ ...values, [field.id]: field.value }), { eventKind: $('input[name="event-kind"]:checked', form)?.value });
  if (form.id === 'delivery-form') values.deliveryRows = deliveryRows();
  return values;
}
function deliveryRows() {
  return $$('#delivery-items .delivery-row').map((row) => ({ name: $('.delivery-food', row).value, kilos: $('.accepted-kilos', row).value }));
}
function renderDeliveryRows(rows = [{}]) {
  $('#delivery-items').innerHTML = rows.map((row, index) => `<div class="delivery-row"><label>Food<input class="delivery-food" list="food-options" maxlength="100" required placeholder="Choose or type food" value="${escapeHTML(row.name || '')}" aria-label="Food ${index + 1}"></label><label>Accepted kg<input class="accepted-kilos" type="number" min="0.1" step="0.1" inputmode="decimal" required placeholder="Kilos" value="${escapeHTML(row.kilos || '')}" aria-label="Accepted kilos for food ${index + 1}"></label><button type="button" class="text-button remove-delivery-item" aria-label="Remove food ${index + 1}">Remove</button></div>`).join('');
}
function populateStockOptions() {
  const options = '<option value="" disabled selected>Choose a dish</option>' + state.bootstrap.items.map((item) => `<option value="${item.id}">${escapeHTML(item.name)}</option>`).join('');
  $$('.item-select').forEach((select) => { const previous = select.value; select.innerHTML = options; if (previous) select.value = previous; });
  $('#food-options').innerHTML = state.bootstrap.items.map((item) => `<option value="${escapeHTML(item.name)}"></option>`).join('');
}
function saveDraft(form, task) { store.set(key('draft', task), fieldValues(form)); }
function restoreForm(task) {
  const form = document.getElementById(forms[task]);
  if (!form) return;
  form.reset();
  const draft = store.get(key('draft', task), {});
  if (task === 'delivery') renderDeliveryRows(draft.deliveryRows?.length ? draft.deliveryRows : [{}]);
  for (const [fieldId, value] of Object.entries(draft)) {
    const field = document.getElementById(fieldId);
    if (field && form.contains(field)) field.value = value;
  }
  const radio = $$('input[name="event-kind"]', form).find((field) => field.value === draft.eventKind);
  if (radio) radio.checked = true;
  $$('details', form).forEach((details) => { details.open = $$('input', details).some((field) => field.value); });
  formError(form, '');
  lockForm(task, false);
  updateSummary(task);
}
function lockForm(task, sending) {
  const form = document.getElementById(forms[task]);
  const pending = store.get(key('pending', task));
  $$('input, select, textarea, button', form).forEach((control) => { control.disabled = sending || Boolean(pending); });
  const submit = $('button[type="submit"]', form);
  submit.disabled = sending;
  submit.textContent = sending ? 'Saving…' : pending ? 'Retry save safely' : submit.dataset.label;
  form.setAttribute('aria-busy', String(sending));
  if (pending && !sending) formError(form, 'This entry is awaiting confirmation. Retry save safely before editing it.');
}
function availableHints() {
  $$('[data-stock-for]').forEach((hint) => {
    const item = state.bootstrap.items.find((entry) => entry.id === Number(document.getElementById(hint.dataset.stockFor).value));
    hint.textContent = item ? `Available raw stock: ${kg(item.onHand - item.reserved)} · Freezer: ${kg(item.freezer)}` : 'Choose a dish';
  });
}
function updateSummary(task) {
  availableHints();
  const form = document.getElementById(forms[task]);
  if (!form) return;
  if (task === 'service') {
    const leftover = $('input[name="event-kind"]:checked').value === 'LEFTOVER';
    $('#leftover-fields').hidden = !leftover;
    const discard = leftover && $('#service-decision').value === 'DISCARD';
    $('#reason-field').hidden = !discard;
    $('#service-reason').required = discard;
  }
  let text = '';
  const item = (selector) => state.bootstrap.items.find((entry) => entry.id === Number($(selector).value))?.name || '';
  if (task === 'request' && $('#request-kilos').value) text = `${item('#request-item')} · ${kg($('#request-kilos').value)}`;
  if (task === 'batch' && $('#raw-kilos').value) text = `${item('#batch-item')} · ${kg($('#raw-kilos').value)} raw → ${kg($('#cooked-kilos').value)} cooked`;
  if (task === 'service' && $('#service-kilos').value) text = `${$('input[name="event-kind"]:checked').nextElementSibling.textContent} · ${item('#service-item')} · ${kg($('#service-kilos').value)}`;
  if (task === 'delivery') text = deliveryRows().filter((row) => row.name.trim() && Number(row.kilos) > 0).map((row) => `${row.name.trim()} ${kg(row.kilos)}`).join(' · ');
  $('.entry-summary', form).textContent = text ? `${text} · ${$('#current-service').selectedOptions[0].textContent}` : 'Enter quantities to prepare this entry.';
}
async function setTask(task, focus = true) {
  if (state.busy) return;
  state.task = task;
  store.set(`task:${state.user.id}`, task);
  const inOversight = task === 'override' || oversightTasks.includes(task);
  $$('[data-task]').forEach((button) => {
    const active = button.dataset.task === task || (button.dataset.task === 'override' && inOversight);
    if (active) button.setAttribute('aria-current', 'page'); else button.removeAttribute('aria-current');
  });
  $$('[data-panel]').forEach((panel) => panel.classList.toggle('active', panel.dataset.panel === task));
  $('#task-title').textContent = titles[task];
  if (task === 'override') $('#override-task').value = '';
  $('#return-to-override').classList.toggle('hidden', !oversightRoles.includes(state.user.role) || !oversightTasks.includes(task));
  if (forms[task] && focus) $('select, input:not([type=radio])', document.getElementById(forms[task])).focus();
  try {
    if (task === 'activity') await loadActivity();
    if (task === 'request') await loadRequests();
    if (task === 'overview') await loadOverview();
    if (task === 'payments') await loadPayments();
  } catch (error) { feedback(`Could not refresh ${titles[task].toLowerCase()}. ${error.message}`, true); }
}
function confirmAction(message, label = 'Confirm') {
  const dialog = $('#confirm-dialog');
  $('#confirm-message').textContent = message;
  $('button[value=confirm]', dialog).textContent = label;
  dialog.returnValue = '';
  return new Promise((resolve) => {
    dialog.addEventListener('close', () => resolve(dialog.returnValue === 'confirm'), { once: true });
    dialog.showModal();
  });
}
function payload(task) {
  const service = $('#current-service').value;
  if (task === 'request') return { path: '/api/requests', body: { service, notes: $('#request-notes').value, items: [{ stockItemId: Number($('#request-item').value), kilos: Number($('#request-kilos').value) }] } };
  if (task === 'delivery') {
    const names = new Set();
    const items = deliveryRows().map((row) => {
      const name = row.name.trim().replace(/\s+/g, ' ');
      if (!name || !Number.isFinite(Number(row.kilos)) || Number(row.kilos) <= 0) throw new Error('Choose or type a food and enter positive accepted kilos for each row.');
      const normalized = name.toLocaleLowerCase();
      if (names.has(normalized)) throw new Error(`Combine ${name} into one row to avoid counting it twice.`);
      names.add(normalized);
      const stock = state.bootstrap.items.find((item) => item.name.toLocaleLowerCase() === normalized);
      return { ...(stock ? { stockItemId: stock.id } : { name }), kilos: Number(row.kilos), acceptedKilos: Number(row.kilos), rejectedKilos: 0 };
    });
    if (!items.length) throw new Error('Enter accepted kilos for at least one item.');
    return { path: '/api/deliveries', body: { supplierName: $('#supplier-name').value.trim(), photoPath: $('#delivery-photo').value, items } };
  }
  if (task === 'batch') {
    const rawKilos = Number($('#raw-kilos').value), cookedKilos = Number($('#cooked-kilos').value), freezerKilos = Number($('#freezer-kilos').value);
    if (freezerKilos > cookedKilos) throw new Error('Freezer kilos cannot exceed cooked kilos.');
    const stock = state.bootstrap.items.find((item) => item.id === Number($('#batch-item').value));
    if (rawKilos > stock.onHand - stock.reserved) throw new Error('Raw kilos exceed available stock. Adjust the quantity or refresh availability.');
    return { path: '/api/batches', body: { stockItemId: stock.id, rawKilos, cookedKilos, freezerKilos, service } };
  }
  const kind = $('input[name="event-kind"]:checked').value;
  const decision = kind === 'LEFTOVER' ? $('#service-decision').value : '';
  return { path: '/api/service-logs', body: { kind, stockItemId: Number($('#service-item').value), kilos: Number($('#service-kilos').value), service, decision, reason: decision === 'DISCARD' ? $('#service-reason').value.trim() : '' } };
}
async function refreshStock() {
  const { items } = await api('/api/inventory');
  state.bootstrap.items = items;
  populateStockOptions();
  availableHints();
}
async function submitEntry(event, task) {
  event.preventDefault();
  if (state.busy) return;
  const form = event.target;
  let pending = store.get(key('pending', task));
  state.busy = true;
  $('#station-select').disabled = true;
  $('#current-service').disabled = true;
  formError(form, '');
  try {
    if (!pending) {
      const entry = payload(task);
      const summary = $('.entry-summary', form).textContent;
      const quantities = [entry.body.kilos, entry.body.rawKilos, ...(entry.body.items || []).map((item) => item.kilos)].filter(Number.isFinite);
      if ((entry.body.decision === 'DISCARD' || quantities.some((quantity) => quantity >= 50)) && !await confirmAction(`${summary}${entry.body.decision === 'DISCARD' ? ' · Discard: ' + entry.body.reason : ''}. Save this entry?`, 'Save entry')) return;
      pending = { ...entry, key: id(), summary };
      store.set(key('pending', task), pending);
    }
    lockForm(task, true);
    const result = await api(pending.path, { method: 'POST', headers: { 'idempotency-key': pending.key }, body: JSON.stringify({ ...pending.body, deviceId }) });
    store.set(key('pending', task), null);
    let undo = result.receipt ? { path: `/api/custody/${result.receipt.id}/undo`, key: id() } : { path: `/api/requests/${result.request.id}/cancel`, key: id() };
    const previous = fieldValues(form);
    form.reset();
    // Keep context for rapid repeated entries; quantities and notes must be entered again.
    $$('.item-select', form).forEach((field) => { field.value = previous[field.id]; });
    if (task === 'service') $$('input[name="event-kind"]', form).find((field) => field.value === previous.eventKind).checked = true;
    if (task === 'delivery') { renderDeliveryRows(); $('#supplier-name').value = previous['supplier-name']; }
    saveDraft(form, task);
    updateSummary(task);
    feedback(`Saved: ${pending.summary}`, false, undo);
    const focusTarget = $('input[type=number]', form);
    lockForm(task, false);
    focusTarget?.focus();
    if (focusTarget && window.matchMedia('(max-width: 800px)').matches) focusTarget.scrollIntoView({ block: 'center' });
    try { await refreshStock(); if (task === 'request') await loadRequests(); } catch { feedback(`Saved: ${pending.summary}. Availability could not refresh.`, false, undo); }
  } catch (error) {
    if (!error.uncertain) store.set(key('pending', task), null);
    formError(form, error.message);
    if (error.status === 409) { try { await refreshStock(); } catch { /* Keep the form available for recovery. */ } }
  } finally {
    state.busy = false;
    $('#station-select').disabled = false;
    $('#current-service').disabled = false;
    lockForm(task, false);
  }
}
async function postAction(path, actionKey = id(), body = {}) {
  return api(path, { method: 'POST', headers: { 'idempotency-key': actionKey }, body: JSON.stringify(body) });
}
async function undoEntry(action, button) {
  if (state.busy) return;
  state.busy = true;
  button.disabled = true;
  $('#station-select').disabled = true;
  try {
    await postAction(action.path, action.key, { deviceId });
    store.set(`last-undo:${state.user.id}`, null);
    feedback(action.path.includes('/requests/') ? 'Draft request cancelled.' : 'Entry undone. The original receipt remains in history.');
    try { await refreshStock(); await loadActivity(); await loadRequests(); } catch { feedback('Entry undone. History could not refresh; reopen Recent activity to retry.'); }
  } catch (error) {
    if (!error.uncertain) store.set(`last-undo:${state.user.id}`, null);
    feedback(error.message, true, error.uncertain ? action : null);
  }
  finally { button.disabled = false; state.busy = false; $('#station-select').disabled = false; }
}
async function loadRequests() {
  const { requests } = await api('/api/requests');
  $('#requests').innerHTML = requests.length ? `<table><thead><tr><th>Request</th><th>Requested by</th><th>Service / kg</th><th>Status</th><th>Action</th></tr></thead><tbody>${requests.map((request) => {
    const actions = [];
    if (request.status === 'DRAFT' && ['MANAGER', 'OWNER'].includes(state.user.role)) actions.push(`<button class="secondary" data-request="${request.id}" data-action="approve">Approve</button>`);
    if (request.status === 'APPROVED' && ['MANAGER', 'OWNER', 'ACCOUNTANT'].includes(state.user.role)) actions.push(`<button class="secondary" data-request="${request.id}" data-action="reserve">Reserve stock</button>`);
    if (request.requested_by === state.user.id) {
      const ready = request.status === 'PENDING_FULFILLMENT';
      const explanation = request.status === 'DRAFT' ? 'Awaiting approval' : request.status === 'APPROVED' ? 'Awaiting stock reservation' : '';
      actions.push(`<button class="secondary" data-request="${request.id}" data-action="received" ${ready ? '' : 'disabled'} title="${escapeHTML(explanation)}">Mark received</button>`);
    }
    if (request.status === 'DRAFT' && (request.requested_by === state.user.id || ['MANAGER', 'OWNER', 'ACCOUNTANT'].includes(state.user.role))) actions.push(`<button class="text-button" data-request="${request.id}" data-action="cancel">Cancel request</button>`);
    return `<tr><td>${escapeHTML(request.reference)}</td><td>${escapeHTML(request.requested_by_name)}</td><td>${escapeHTML(request.service)} · ${kg(request.kilos)}</td><td>${escapeHTML(request.status.replaceAll('_', ' '))}</td><td>${actions.join(' ')}</td></tr>`;
  }).join('')}</tbody></table>` : '<p class="muted">No requests yet.</p>';
  $$('[data-request]').forEach((button) => button.addEventListener('click', async () => {
    if (state.busy) return;
    if (button.disabled) return;
    state.busy = true;
    button.disabled = true;
    $('#station-select').disabled = true;
    try {
      if (button.dataset.action === 'cancel' && !await confirmAction('Cancel this draft request?', 'Cancel request')) return;
      button.dataset.key ||= id();
      await postAction(`/api/requests/${button.dataset.request}/${button.dataset.action}`, button.dataset.key);
      const messages = { cancel: 'cancelled', approve: 'approved', reserve: 'stock reserved', received: 'marked received' };
      feedback(`Request ${messages[button.dataset.action] || button.dataset.action}.`);
      await loadRequests(); await refreshStock();
    } catch (error) { feedback(error.message, true); }
    finally { button.disabled = false; state.busy = false; $('#station-select').disabled = false; }
  }));
}
async function loadPayments() {
  const [{ payments }, { purchases }] = await Promise.all([api('/api/payments'), api('/api/purchases')]);
  const approvedPurchases = purchases.filter((purchase) => purchase.status === 'APPROVED');
  $('#payment-form').hidden = state.user.role !== 'ACCOUNTANT';
  $('#payment-purchase').innerHTML = '<option value="" disabled selected>Choose an approved purchase</option>' +
    approvedPurchases.map((purchase) => `<option value="${purchase.id}">${escapeHTML(purchase.reference)} · Authorized up to ${Number(purchase.authorization_limit || purchase.total_estimate || 0).toFixed(2)}</option>`).join('');
  if (state.user.role === 'ACCOUNTANT') {
    $('#payment-form h3').textContent = `Record payment (5% allowance included)`;
  }
  $('#payments').innerHTML = payments.length ? `<table><thead><tr><th>Payment</th><th>Purchase</th><th>Amount</th><th>Method</th><th>Status</th><th>Action</th></tr></thead><tbody>${payments.map((payment) => {
    const action = payment.status === 'PENDING_APPROVAL' && ['MANAGER', 'OWNER'].includes(state.user.role)
      ? `<button class="secondary" data-payment="${payment.id}" data-action="approve">Approve payment</button>`
      : payment.status === 'APPROVED' && state.user.role === 'ACCOUNTANT'
        ? `<button class="secondary" data-payment="${payment.id}" data-action="release">Release money</button>`
        : '';
    const remaining = Math.max(0, Number(payment.authorization_limit || 0) - Number(payment.payment_total || 0));
    return `<tr><td>${escapeHTML(payment.reference)}</td><td>${escapeHTML(payment.purchase_reference)}</td><td>${Number(payment.amount).toFixed(2)}</td><td>${escapeHTML(payment.method)}</td><td>${escapeHTML(payment.status.replaceAll('_', ' '))}<br><small>Remaining: ${remaining.toFixed(2)}</small></td><td>${action}</td></tr>`;
  }).join('')}</tbody></table>` : '<p class="muted">No payments recorded yet.</p>';
  $$('[data-payment]').forEach((button) => button.addEventListener('click', async () => {
    if (state.busy) return;
    state.busy = true;
    button.disabled = true;
    try {
      await postAction(`/api/payments/${button.dataset.payment}/${button.dataset.action}`, button.dataset.key ||= id());
      feedback(button.dataset.action === 'approve' ? 'Payment approved.' : 'Payment released.');
      await loadPayments();
    } catch (error) { feedback(error.message, true); }
    finally { state.busy = false; }
  }));
}
$('#payment-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  if (state.busy) return;
  const error = $('#payment-error');
  error.classList.add('hidden');
  state.busy = true;
  const button = $('button[type="submit"]', event.target);
  button.disabled = true;
  try {
    await api('/api/payments', {
      method: 'POST',
      body: JSON.stringify({
        purchaseRequestId: Number($('#payment-purchase').value),
        amount: Number($('#payment-amount').value),
        method: $('#payment-method').value,
        proofPhoto: $('#payment-proof').value.trim()
      })
    });
    event.target.reset();
    feedback('Payment recorded and sent for approval.');
    await loadPayments();
  } catch (apiError) {
    error.textContent = apiError.message;
    error.classList.remove('hidden');
  } finally {
    state.busy = false;
    button.disabled = false;
  }
});
function renderActivity() {
  const from = $('#activity-from').value ? new Date($('#activity-from').value).getTime() : -Infinity;
  const to = $('#activity-to').value ? new Date($('#activity-to').value).getTime() : Infinity;
  const filtered = state.activityReceipts.filter((receipt) => {
    const timestamp = new Date(receipt.created_at).getTime();
    return timestamp >= from && timestamp <= to;
  });
  const reversed = new Set(state.activityReceipts.filter((receipt) => receipt.reversed).map((receipt) => receipt.id));
  $('#activity-filter-status').textContent = `${filtered.length} of ${state.activityReceipts.length} receipt${state.activityReceipts.length === 1 ? '' : 's'} shown.`;
  $('#activity').innerHTML = filtered.length ? filtered.map((receipt) => {
    const eligible = receipt.reversible && !reversed.has(receipt.id) && (receipt.actor_id === state.user.id || ['OWNER', 'MANAGER'].includes(state.user.role));
    return `<article class="receipt ${reversed.has(receipt.id) ? 'reversed' : ''}"><h3>${escapeHTML(receipt.action.replaceAll('_', ' '))} · ${kg(receipt.kilos)}${reversed.has(receipt.id) ? ' · Undone' : ''}</h3><p>${escapeHTML(receipt.source_reference)} · ${escapeHTML(receipt.station)}</p><p class="small">${escapeHTML(new Date(receipt.created_at).toLocaleString())} · ${escapeHTML(receipt.receipt_number)}${receipt.correction_of ? ` · Linked to receipt #${receipt.correction_of}` : ''}</p>${receipt.condition ? `<p>${escapeHTML(receipt.condition)}</p>` : ''}<div class="actions">${eligible ? `<button class="secondary" data-undo="${receipt.id}">Undo entry</button>` : ''}${!receipt.correction_of ? `<button class="text-button" data-correct="${receipt.id}">Add correction note</button>` : ''}</div></article>`;
  }).join('') : `<p class="card muted">${state.activityReceipts.length ? 'No receipts match this time range.' : 'No activity yet. Saved handoffs will appear here.'}</p>`;
  $$('[data-undo]').forEach((button) => button.addEventListener('click', async () => {
    if (state.busy) return;
    if (await confirmAction('Undo this entry? Its original receipt will stay in history.', 'Undo entry')) { button.dataset.key ||= id(); await undoEntry({ path: `/api/custody/${button.dataset.undo}/undo`, key: button.dataset.key }, button); }
  }));
  $$('[data-correct]').forEach((button) => button.addEventListener('click', () => {
    state.correction = { receiptId: button.dataset.correct, key: id() };
    $('#correction-form').reset();
    $('#correction-note').readOnly = false;
    $('#cancel-correction').disabled = false;
    formError($('#correction-form'), '');
    $('#correction-dialog').showModal();
  }));
}
async function loadActivity() {
  const { receipts } = await api('/api/custody');
  state.activityReceipts = receipts;
  renderActivity();
}
async function loadOverview() {
  const data = await api('/api/dashboard');
  $('#metrics').innerHTML = [['Available stock', kg(data.onHand - data.reserved)], ['Freezer', kg(data.freezer)], ['Cooked today', kg(data.cooked)]].map(([label, value]) => `<div class="metric"><strong>${value}</strong><span>${label}</span></div>`).join('');
  const { alerts } = await api('/api/alerts');
  $('#alerts').innerHTML = alerts.filter((alert) => alert.status === 'OPEN').map((alert) => `<article class="alert"><h3>${escapeHTML(alert.type)}</h3><p>${escapeHTML(alert.message)}</p><button class="secondary" data-alert="${alert.id}">Acknowledge</button></article>`).join('') || '<p class="muted">All clear. No open alerts for this station.</p>';
  $$('[data-alert]').forEach((button) => button.addEventListener('click', async () => {
    if (state.busy) return;
    button.disabled = true;
    try { button.dataset.key ||= id(); await postAction(`/api/alerts/${button.dataset.alert}/acknowledge`, button.dataset.key); await loadOverview(); feedback('Alert acknowledged.'); } catch (error) { feedback(error.message, true); } finally { button.disabled = false; }
  }));
}
function useStation(user, initial = false) {
  state.user = user;
  store.set('station', user.id);
  $('#station-select').value = user.id;
  const hasOversightTab = oversightRoles.includes(user.role);
  const allowed = [...tasks[user.role], 'activity', 'overview', ...(hasOversightTab ? ['override'] : [])];
  document.querySelector('.tabs').classList.toggle('owner-nav', ['OWNER', 'MANAGER'].includes(user.role));
  $$('nav.tabs > [data-task]').forEach((button) => {
    button.hidden = button.dataset.task === 'override' ? !hasOversightTab : hasOversightTab && oversightTasks.includes(button.dataset.task) ? true : !allowed.includes(button.dataset.task);
  });
  $('[data-task="request"]').textContent = user.role === 'ACCOUNTANT' ? 'Requests' : 'Request stock';
  $('#request-form').hidden = user.role === 'ACCOUNTANT';
  $('#requests').parentElement.open = ['ACCOUNTANT', 'MANAGER', 'OWNER'].includes(user.role);
  Object.keys(forms).forEach(restoreForm);
  $('#feedback').hidden = true;
  const lastUndo = store.get(`last-undo:${user.id}`);
  if (lastUndo) feedback('Your last saved entry can be undone or reviewed in Recent activity.', false, lastUndo);
  const last = store.get(`task:${user.id}`);
  const startingTask = ['OWNER', 'MANAGER'].includes(user.role) ? 'overview' : (allowed.includes(last) ? last : tasks[user.role][0]);
  setTask(startingTask, !initial);
}
async function start() {
  $('#retry-start').disabled = true;
  try {
    state.bootstrap = await api('/api/bootstrap');
    $('#station-select').innerHTML = state.bootstrap.users.map((user) => `<option value="${escapeHTML(user.id)}">${escapeHTML(user.station.replace(' PC', ''))}</option>`).join('');
    populateStockOptions();
    $('#suppliers').innerHTML = state.bootstrap.suppliers.map((supplier) => `<option value="${escapeHTML(supplier.name)}"></option>`).join('');
    $('#current-service').value = store.get('service', new Date().getHours() >= 15 ? 'DINNER' : 'LUNCH');
    $('#workspace-content').hidden = false;
    $('#startup-error').classList.add('hidden');
    useStation(state.bootstrap.users.find((user) => user.id === store.get('station')) || state.bootstrap.users.find((user) => user.role === 'KITCHEN'), true);
    await checkConnection();
  } catch { $('#startup-error').classList.remove('hidden'); }
  finally { $('#retry-start').disabled = false; }
}
async function checkConnection() {
  let connected = false;
  try { const response = await fetch('/api/health', { cache: 'no-store', signal: AbortSignal.timeout(5000) }); connected = response.ok; } catch { /* Report server reachability, not just browser connectivity. */ }
  $('#connection').textContent = connected ? '● Connected' : '○ Offline · drafts kept';
  $('#connection').classList.toggle('offline', !connected);
}
for (const [task, formId] of Object.entries(forms)) {
  const form = document.getElementById(formId);
  $('button[type=submit]', form).dataset.label = $('button[type=submit]', form).textContent;
  form.addEventListener('submit', (event) => submitEntry(event, task));
  ['input', 'change'].forEach((eventName) => form.addEventListener(eventName, () => { if (!state.user) return; saveDraft(form, task); updateSummary(task); }));
  $('.clear-draft', form).addEventListener('click', async () => {
    if (!await confirmAction('Clear this unsaved entry?', 'Clear entry')) return;
    store.set(key('draft', task), null); restoreForm(task); $('select, input', form)?.focus();
  });
}
$$('[data-task]').forEach((button) => button.addEventListener('click', () => {
  if (button.dataset.task === 'override') return setTask('override');
  setTask(button.dataset.task);
}));
$('#override-task').addEventListener('change', (event) => setTask(event.target.value));
$('#return-to-override').addEventListener('click', () => setTask('override'));
$('#station-select').addEventListener('change', (event) => useStation(state.bootstrap.users.find((user) => user.id === event.target.value)));
$('#current-service').addEventListener('change', () => { store.set('service', $('#current-service').value); Object.keys(forms).forEach(updateSummary); });
$('#undo-button').addEventListener('click', () => state.undo && undoEntry(state.undo, $('#undo-button')));
$('#print-custody').addEventListener('click', () => window.print());
$('#activity-filter').addEventListener('submit', (event) => {
  event.preventDefault();
  const from = $('#activity-from').value;
  const to = $('#activity-to').value;
  if (from && to && new Date(from) > new Date(to)) {
    $('#activity-filter-status').textContent = 'The From time must be earlier than or equal to the To time.';
    return;
  }
  renderActivity();
});
$('#clear-activity-filter').addEventListener('click', () => {
  $('#activity-filter').reset();
  renderActivity();
});
$('#refresh-alerts').addEventListener('click', () => loadOverview().catch((error) => feedback(error.message, true)));
$('#refresh-stock').addEventListener('click', async () => {
  const button = $('#refresh-stock');
  button.disabled = true;
  try { await refreshStock(); feedback('Stock availability updated.'); }
  catch (error) { feedback(error.message, true); }
  finally { button.disabled = false; }
});
$('#retry-start').addEventListener('click', start);
$('#add-delivery-item').addEventListener('click', () => {
  if (state.busy || store.get(key('pending', 'delivery'))) return;
  renderDeliveryRows([...deliveryRows(), {}]);
  saveDraft($('#delivery-form'), 'delivery');
  updateSummary('delivery');
  $$('#delivery-items .delivery-food').at(-1).focus();
});
$('#delivery-items').addEventListener('click', (event) => {
  const button = event.target.closest('.remove-delivery-item');
  if (!button || state.busy || store.get(key('pending', 'delivery'))) return;
  const rows = deliveryRows();
  rows.splice($$('#delivery-items .delivery-row').indexOf(button.closest('.delivery-row')), 1);
  renderDeliveryRows(rows.length ? rows : [{}]);
  saveDraft($('#delivery-form'), 'delivery');
  updateSummary('delivery');
  $('#delivery-items .delivery-food').focus();
});
$('#cancel-correction').addEventListener('click', () => { if (!state.busy) $('#correction-dialog').close(); });
$('#correction-dialog').addEventListener('cancel', (event) => { if (state.busy || $('#correction-note').readOnly) event.preventDefault(); });
$('#correction-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.target;
  if (state.busy) return;
  const condition = $('#correction-note').value.trim();
  if (!condition) return formError(form, 'Enter a correction note.');
  state.busy = true;
  const button = $('button.primary', form); button.disabled = true;
  try {
    // Preserve the same note and key after an uncertain response.
    state.correction.condition ||= condition;
    await postAction(`/api/custody/${state.correction.receiptId}/correct`, state.correction.key, { condition: state.correction.condition, deviceId });
    $('#correction-dialog').close(); feedback('Correction note saved. Stock quantities are unchanged.');
    try { await loadActivity(); } catch { /* Saved note remains recorded. */ }
  } catch (error) {
    if (!error.uncertain) { state.correction.key = id(); state.correction.condition = null; }
    else { $('#correction-note').readOnly = true; $('#cancel-correction').disabled = true; }
    formError(form, error.message);
  } finally { button.disabled = false; state.busy = false; }
});
window.addEventListener('online', checkConnection);
window.addEventListener('offline', checkConnection);
window.setInterval(checkConnection, 30000);
let installPrompt;
window.addEventListener('beforeinstallprompt', (event) => { event.preventDefault(); installPrompt = event; $('#install-button').classList.remove('hidden'); });
$('#install-button').addEventListener('click', async () => { if (installPrompt) { await installPrompt.prompt(); installPrompt = null; $('#install-button').classList.add('hidden'); } });
if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
start();
