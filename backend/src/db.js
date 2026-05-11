const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

async function init() {
  const sql = `
  CREATE TABLE IF NOT EXISTS sessions (
    pseudoid TEXT PRIMARY KEY,
    ciphertext bytea,
    nonce bytea,
    tag bytea,
    created_at timestamptz DEFAULT now()
  );

  CREATE TABLE IF NOT EXISTS survey_responses (
    pseudoid TEXT PRIMARY KEY,
    session_pseudoid TEXT REFERENCES sessions(pseudoid),
    ciphertext bytea,
    nonce bytea,
    tag bytea,
    schema_version text,
    created_at timestamptz DEFAULT now(),
    metadata jsonb
  );

  CREATE TABLE IF NOT EXISTS messages (
    pseudoid TEXT PRIMARY KEY,
    session_pseudoid TEXT REFERENCES sessions(pseudoid),
    ciphertext bytea,
    nonce bytea,
    tag bytea,
    created_at timestamptz DEFAULT now()
  );
  `;
  await pool.query(sql);
  // Ensure new columns exist when schema was created earlier without them
  const alter1 = `
    ALTER TABLE sessions
      ADD COLUMN IF NOT EXISTS ciphertext bytea,
      ADD COLUMN IF NOT EXISTS nonce bytea,
      ADD COLUMN IF NOT EXISTS tag bytea;
  `;
  await pool.query(alter1);

  const alter2 = `
    ALTER TABLE messages
      ADD COLUMN IF NOT EXISTS ciphertext bytea,
      ADD COLUMN IF NOT EXISTS nonce bytea,
      ADD COLUMN IF NOT EXISTS tag bytea;
  `;
  await pool.query(alter2);

  const alter3 = `
    ALTER TABLE survey_responses
      ADD COLUMN IF NOT EXISTS ciphertext bytea,
      ADD COLUMN IF NOT EXISTS nonce bytea,
      ADD COLUMN IF NOT EXISTS tag bytea,
      ADD COLUMN IF NOT EXISTS messages_snapshot jsonb;
  `;
  await pool.query(alter3);
  // Table to persist small server-side state like the agent rotation pointer
  const stateSql = `
    CREATE TABLE IF NOT EXISTS server_state (
      key TEXT PRIMARY KEY,
      value jsonb
    );
  `;
  await pool.query(stateSql);

  // Initialize agent rotation index if missing (-1 so first becomes 0)
  await pool.query(
    "INSERT INTO server_state(key, value) VALUES($1, $2) ON CONFLICT (key) DO NOTHING",
    ['agent_rotation_index', JSON.stringify({ idx: -1 })]
  );
}

module.exports = { pool, init };
