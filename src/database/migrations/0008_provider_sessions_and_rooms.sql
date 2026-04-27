CREATE TABLE IF NOT EXISTS rooms (
  id TEXT PRIMARY KEY,
  root_session_id TEXT NOT NULL UNIQUE,
  title TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  metadata TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_rooms_updated_at ON rooms(updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_rooms_status_updated ON rooms(status, updated_at DESC);

CREATE TABLE IF NOT EXISTS room_participants (
  id TEXT PRIMARY KEY,
  room_id TEXT NOT NULL,
  adapter TEXT NOT NULL,
  display_name TEXT,
  model TEXT,
  system_prompt TEXT,
  work_dir TEXT,
  provider_session_id TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  last_message_at INTEGER,
  imported_from_provider_session_id TEXT,
  metadata TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_room_participants_room_status ON room_participants(room_id, status, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_room_participants_provider_session ON room_participants(provider_session_id);
CREATE INDEX IF NOT EXISTS idx_room_participants_room_last_message ON room_participants(room_id, last_message_at DESC);

CREATE TABLE IF NOT EXISTS room_turns (
  id TEXT PRIMARY KEY,
  room_id TEXT NOT NULL,
  sequence_no INTEGER NOT NULL,
  request_id TEXT,
  initiator_role TEXT NOT NULL,
  initiator_name TEXT,
  content TEXT NOT NULL,
  mentions_json TEXT,
  status TEXT NOT NULL,
  error TEXT,
  metadata TEXT,
  created_at INTEGER NOT NULL,
  started_at INTEGER,
  completed_at INTEGER,
  updated_at INTEGER NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_room_turns_room_sequence ON room_turns(room_id, sequence_no);
CREATE UNIQUE INDEX IF NOT EXISTS idx_room_turns_room_request_id ON room_turns(room_id, request_id) WHERE request_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_room_turns_room_status ON room_turns(room_id, status, updated_at DESC);

CREATE TABLE IF NOT EXISTS room_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  room_id TEXT NOT NULL,
  turn_id TEXT,
  sequence_no INTEGER NOT NULL,
  participant_id TEXT,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  metadata TEXT,
  created_at INTEGER NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_room_messages_room_sequence ON room_messages(room_id, sequence_no);
CREATE INDEX IF NOT EXISTS idx_room_messages_room_created ON room_messages(room_id, created_at);
CREATE INDEX IF NOT EXISTS idx_room_messages_room_turn ON room_messages(room_id, turn_id, id);
