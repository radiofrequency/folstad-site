-- Sales Desk catalog. Product truth lives here, not in chat memory.

CREATE TABLE IF NOT EXISTS products (
  id INTEGER PRIMARY KEY,
  source_url TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  price_adult INTEGER,
  price_child INTEGER,
  currency TEXT NOT NULL DEFAULT 'THB',
  duration TEXT,
  pickup_window TEXT,
  pickup_areas TEXT,
  includes TEXT,
  excludes TEXT,
  bring TEXT,
  notes TEXT,
  min_pax INTEGER,
  days TEXT,
  category TEXT,
  buy_url TEXT,
  buy_channel TEXT,
  buy_label TEXT,
  raw_text TEXT,
  content_hash TEXT,
  scraped_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS products_name ON products(name);

CREATE VIRTUAL TABLE IF NOT EXISTS products_fts USING fts5(
  name, includes, excludes, notes, raw_text,
  content='products',
  content_rowid='id'
);

CREATE TRIGGER IF NOT EXISTS products_ai AFTER INSERT ON products BEGIN
  INSERT INTO products_fts(rowid, name, includes, excludes, notes, raw_text)
  VALUES (new.id, new.name, new.includes, new.excludes, new.notes, new.raw_text);
END;

CREATE TRIGGER IF NOT EXISTS products_ad AFTER DELETE ON products BEGIN
  INSERT INTO products_fts(products_fts, rowid, name, includes, excludes, notes, raw_text)
  VALUES ('delete', old.id, old.name, old.includes, old.excludes, old.notes, old.raw_text);
END;

CREATE TRIGGER IF NOT EXISTS products_au AFTER UPDATE ON products BEGIN
  INSERT INTO products_fts(products_fts, rowid, name, includes, excludes, notes, raw_text)
  VALUES ('delete', old.id, old.name, old.includes, old.excludes, old.notes, old.raw_text);
  INSERT INTO products_fts(rowid, name, includes, excludes, notes, raw_text)
  VALUES (new.id, new.name, new.includes, new.excludes, new.notes, new.raw_text);
END;

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS inquiries (
  id INTEGER PRIMARY KEY,
  channel TEXT NOT NULL,
  sender TEXT,
  language TEXT,
  body TEXT NOT NULL,
  received_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'new'
);

CREATE TABLE IF NOT EXISTS answers (
  id INTEGER PRIMARY KEY,
  inquiry_id INTEGER NOT NULL REFERENCES inquiries(id),
  product_ids TEXT,
  draft TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS bookings (
  id INTEGER PRIMARY KEY,
  product_id INTEGER REFERENCES products(id),
  tour_name TEXT NOT NULL,
  date TEXT NOT NULL,
  pax INTEGER NOT NULL,
  hotel TEXT,
  guest TEXT,
  phone TEXT,
  language TEXT,
  amount_thb INTEGER,
  payment TEXT NOT NULL DEFAULT 'unpaid',
  status TEXT NOT NULL DEFAULT 'pending',
  pickup_window TEXT,
  need_confirm TEXT,
  notes TEXT,
  created_at TEXT NOT NULL
);
