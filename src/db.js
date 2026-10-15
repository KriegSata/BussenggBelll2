const fs = require("node:fs");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");

const dataDir = path.join(__dirname, "..", "data");
fs.mkdirSync(dataDir, { recursive: true });

const db = new DatabaseSync(path.join(dataDir, "tong.db"));
db.exec("PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;");

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('OWNER', 'MANAGER', 'ACCOUNTANT', 'KITCHEN', 'WAITER')),
    station TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS suppliers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    source_type TEXT NOT NULL DEFAULT 'SUPPLIER',
    active INTEGER NOT NULL DEFAULT 1
  );
  CREATE TABLE IF NOT EXISTS stock_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    category TEXT NOT NULL,
    unit TEXT NOT NULL DEFAULT 'kg',
    on_hand REAL NOT NULL DEFAULT 0,
    reserved REAL NOT NULL DEFAULT 0,
    freezer REAL NOT NULL DEFAULT 0,
    reorder_point REAL NOT NULL DEFAULT 0,
    usual_price REAL NOT NULL DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS requests (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    reference TEXT NOT NULL UNIQUE,
    service TEXT NOT NULL,
    requested_by TEXT NOT NULL REFERENCES users(id),
    approved_by TEXT REFERENCES users(id),
    status TEXT NOT NULL DEFAULT 'DRAFT',
    notes TEXT,
    created_at TEXT NOT NULL,
    approved_at TEXT
  );
  CREATE TABLE IF NOT EXISTS request_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    request_id INTEGER NOT NULL REFERENCES requests(id) ON DELETE CASCADE,
    stock_item_id INTEGER NOT NULL REFERENCES stock_items(id),
    kilos REAL NOT NULL CHECK (kilos > 0)
  );
  CREATE TABLE IF NOT EXISTS purchase_requests (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    reference TEXT NOT NULL UNIQUE,
    request_id INTEGER REFERENCES requests(id),
    supplier_id INTEGER REFERENCES suppliers(id),
    status TEXT NOT NULL DEFAULT 'PENDING_APPROVAL',
    total_estimate REAL NOT NULL DEFAULT 0,
    prepared_by TEXT NOT NULL REFERENCES users(id),
    approved_by TEXT REFERENCES users(id),
    created_at TEXT NOT NULL,
    approved_at TEXT
  );
  CREATE TABLE IF NOT EXISTS purchase_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    purchase_request_id INTEGER NOT NULL REFERENCES purchase_requests(id) ON DELETE CASCADE,
    stock_item_id INTEGER NOT NULL REFERENCES stock_items(id),
    kilos REAL NOT NULL CHECK (kilos > 0),
    estimated_price REAL NOT NULL DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS payments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    reference TEXT NOT NULL UNIQUE,
    purchase_request_id INTEGER NOT NULL REFERENCES purchase_requests(id),
    amount REAL NOT NULL CHECK (amount >= 0),
    method TEXT NOT NULL CHECK (method IN ('CASH', 'BANK', 'GCASH')),
    status TEXT NOT NULL DEFAULT 'PENDING_APPROVAL',
    prepared_by TEXT NOT NULL REFERENCES users(id),
    approved_by TEXT REFERENCES users(id),
    released_by TEXT REFERENCES users(id),
    proof_photo TEXT,
    created_at TEXT NOT NULL,
    approved_at TEXT,
    released_at TEXT
  );
  CREATE TABLE IF NOT EXISTS deliveries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    reference TEXT NOT NULL UNIQUE,
    purchase_request_id INTEGER REFERENCES purchase_requests(id),
    supplier_name TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'EXPECTED',
    eta TEXT,
    receipt_photo TEXT,
    notes TEXT,
    received_by TEXT REFERENCES users(id),
    quality_confirmed_by TEXT REFERENCES users(id),
    created_at TEXT NOT NULL,
    received_at TEXT
  );
  CREATE TABLE IF NOT EXISTS delivery_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    delivery_id INTEGER NOT NULL REFERENCES deliveries(id) ON DELETE CASCADE,
    stock_item_id INTEGER NOT NULL REFERENCES stock_items(id),
    ordered_kilos REAL NOT NULL,
    accepted_kilos REAL NOT NULL DEFAULT 0,
    rejected_kilos REAL NOT NULL DEFAULT 0,
    condition TEXT NOT NULL DEFAULT 'PENDING'
  );
  CREATE TABLE IF NOT EXISTS inventory_ledger (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    stock_item_id INTEGER NOT NULL REFERENCES stock_items(id),
    action TEXT NOT NULL,
    kilos REAL NOT NULL,
    reference TEXT NOT NULL,
    actor_id TEXT NOT NULL REFERENCES users(id),
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS batches (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    reference TEXT NOT NULL UNIQUE,
    stock_item_id INTEGER NOT NULL REFERENCES stock_items(id),
    raw_kilos REAL NOT NULL,
    cooked_kilos REAL NOT NULL,
    freezer_kilos REAL NOT NULL DEFAULT 0,
    service TEXT NOT NULL,
    created_by TEXT NOT NULL REFERENCES users(id),
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS service_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    kind TEXT NOT NULL,
    stock_item_id INTEGER REFERENCES stock_items(id),
    kilos REAL NOT NULL DEFAULT 0,
    service TEXT,
    decision TEXT,
    reason TEXT,
    actor_id TEXT NOT NULL REFERENCES users(id),
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS bookings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    reference TEXT NOT NULL UNIQUE,
    customer_name TEXT NOT NULL,
    headcount INTEGER NOT NULL,
    service_date TEXT NOT NULL,
    discount REAL NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'BOOKED',
    created_by TEXT NOT NULL REFERENCES users(id),
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS custody_receipts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    receipt_number TEXT NOT NULL UNIQUE,
    source_type TEXT NOT NULL,
    source_reference TEXT NOT NULL,
    action TEXT NOT NULL,
    actor_id TEXT NOT NULL REFERENCES users(id),
    actor_role TEXT NOT NULL,
    station TEXT NOT NULL,
    device_id TEXT NOT NULL,
    items_json TEXT NOT NULL DEFAULT '[]',
    kilos REAL NOT NULL DEFAULT 0,
    condition TEXT,
    photo_path TEXT,
    correction_of INTEGER REFERENCES custody_receipts(id),
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS alerts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    type TEXT NOT NULL,
    message TEXT NOT NULL,
    target_role TEXT NOT NULL,
    source_reference TEXT,
    status TEXT NOT NULL DEFAULT 'OPEN',
    created_at TEXT NOT NULL,
    acknowledged_by TEXT REFERENCES users(id),
    acknowledged_at TEXT
  );
  CREATE TABLE IF NOT EXISTS audit_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    actor_id TEXT NOT NULL REFERENCES users(id),
    action TEXT NOT NULL,
    entity_type TEXT NOT NULL,
    entity_id TEXT NOT NULL,
    details_json TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL
  );
`);

function now() {
  return new Date().toISOString();
}

function seed() {
  const users = [
    ["owner-1", "Tong Owner", "OWNER", "Owner PC"],
    ["manager-1", "Operations Manager", "MANAGER", "Manager PC"],
    ["accountant-1", "Receiving Accountant", "ACCOUNTANT", "Accountant PC"],
    ["kitchen-1", "Kitchen Lead", "KITCHEN", "Kitchen PC"],
    ["waiter-1", "Service Waiter", "WAITER", "Waiter PC"]
  ];
  const addUser = db.prepare("INSERT OR IGNORE INTO users (id, name, role, station) VALUES (?, ?, ?, ?)");
  for (const user of users) addUser.run(...user);

  const addSetting = db.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)");
  [
    ["purchase_limit", "5000"],
    ["discount_limit", "10"],
    ["cutoff_time", "20:00"],
    ["approval_wait_minutes", "30"],
    ["escalation_minutes", "30"]
  ].forEach((setting) => addSetting.run(...setting));

  const addSupplier = db.prepare("INSERT OR IGNORE INTO suppliers (id, name, source_type) VALUES (?, ?, ?)");
  [
    [1, "Pasil Seafood Market", "MARKET"],
    [2, "Carbon Vegetable Market", "MARKET"],
    [3, "Main Grocery Supplier", "SUPPLIER"],
    [4, "Backup Supplier", "SUPPLIER"]
  ].forEach((supplier) => addSupplier.run(...supplier));

  const addItem = db.prepare(`
    INSERT OR IGNORE INTO stock_items
      (id, name, category, on_hand, reserved, freezer, reorder_point, usual_price)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  [
    [1, "Shrimp", "Seafood", 30, 0, 0, 10, 350],
    [2, "Fish", "Seafood", 22, 0, 0, 8, 280],
    [3, "Vegetables", "Produce", 25, 0, 0, 8, 120],
    [4, "Humba Prepared", "Prepared", 18, 0, 12, 5, 240],
    [5, "Ice", "Other", 40, 0, 0, 10, 25]
  ].forEach((item) => addItem.run(...item));
}

seed();

module.exports = { db, now };
