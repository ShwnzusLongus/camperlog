CREATE TABLE IF NOT EXISTS touren (
  id TEXT PRIMARY KEY,
  ort TEXT NOT NULL,
  typ TEXT NOT NULL DEFAULT 'Stellplatz',
  datum_von TEXT NOT NULL,
  datum_bis TEXT,
  fahrzeug TEXT,
  kosten REAL,
  wetter TEXT DEFAULT 'sonnig',
  bewertung INTEGER DEFAULT 4,
  notizen TEXT,
  favorit INTEGER NOT NULL DEFAULT 0,
  erstellt_am TEXT NOT NULL DEFAULT (datetime('now')),
  strom INTEGER DEFAULT 0,
  boden TEXT,
  sanitaer INTEGER DEFAULT 0,
  bezahlung TEXT,
  broetchenservice INTEGER DEFAULT 0,
  umgebung TEXT,
  nachttemperatur REAL
);
-- Hinweis: das Feld "fahrzeug" ist inzwischen aus dem Formular entfernt
-- (es ist ja immer Iva), die Spalte bleibt aus Kompatibilitätsgründen bestehen.

CREATE TABLE IF NOT EXISTS favoriten (
  id TEXT PRIMARY KEY,
  ort TEXT NOT NULL,
  notiz TEXT,
  lat REAL,
  lon REAL,
  erstellt_am TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_touren_datum ON touren(datum_von);
