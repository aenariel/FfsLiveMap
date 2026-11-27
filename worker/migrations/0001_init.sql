-- Editors: R4s (and the admin) who may change the assignments of some maps.
CREATE TABLE editors (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT NOT NULL,
  code_hash  TEXT NOT NULL UNIQUE,   -- SHA-256 of the editor's code (the code itself is never stored)
  maps       TEXT NOT NULL DEFAULT '', -- comma list of map ids, e.g. "ffs,var"
  admin      INTEGER NOT NULL DEFAULT 0,
  active     INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);

-- One row per map: the version goes up by one on every saved submission.
CREATE TABLE maps (
  id         TEXT PRIMARY KEY,
  version    INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT,
  updated_by TEXT,
  token      TEXT                    -- random per save: the other statements of a save only run if it is still theirs
);

-- Current assignment of each spot ("BT1-012" -> player name).
CREATE TABLE assignments (
  map        TEXT NOT NULL,
  spot       TEXT NOT NULL,
  player     TEXT NOT NULL,
  updated_by TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (map, spot)
);

-- Every saved submission, with each change as before -> after.
CREATE TABLE history (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  map       TEXT NOT NULL,
  version   INTEGER NOT NULL,
  editor    TEXT NOT NULL,
  editor_id INTEGER,              -- NULL for the bootstrap admin code
  at        TEXT NOT NULL,
  changes   TEXT NOT NULL         -- JSON [{spot, before, after}]
);
CREATE INDEX history_map ON history (map, id);
CREATE INDEX history_editor_day ON history (editor_id, at);
