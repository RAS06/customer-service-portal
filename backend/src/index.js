require('dotenv').config();
const express = require('express');
const { init, pool } = require('./db');
const { genPseudoId, encryptObject, decryptRecord } = require('./encryption');

const app = express();
app.use(express.json());
// Pretty-print JSON responses for easier reading in dev
app.set('json spaces', 2);

// Allow requests from any origin, but echo back the specific origin that made the request
app.use((req, res, next) => {
  // For development and production - more flexible
  res.setHeader('Access-Control-Allow-Origin', req.headers.origin || '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Allow-Credentials', 'true'); // Add this if you use cookies/sessions
  next();
});

const PORT = process.env.PORT || 8000;

const AGENT_SCRIPTS = {
  minimalistic: [
    { order: 1, text: 'hello' },
    { order: 2, text: "i dont know, can you?\nI’m just kidding haha send me your account number and customer id" },
    { order: 3, text: "kay, ive got you right here. are you doubly sure you want to change your subscription? itll cost an xtra 5.69 a month" },
    { order: 4, text: "cool, i’ve got you down for the new plan." }
  ],
  polite: [
    { order: 1, text: "Hello! I'm Alice, and it is a pleasure to help you today! I’m so sorry that it seems like you’re having some trouble with our product. I’m going ahead and connecting you to the IT support team. Would you please describe the problem you’re having to me?" },
    { order: 2, text: "Oh! You are only looking to change your plan! I apologize for the confusion. Well, I can do that for you as well! Please send me your account number and customer ID and I’ll get it taken care of for you." },
    { order: 3, text: "Alright! I’ve found your account. \n And sorry just one thing for the records, could you please confirm that you would like to change your subscription plan from HyperParameter Basic to HyperParameter Plus?" },
    { order: 4, text: "Okay, great! Thank you. Your bill will increase by $5.69 per month. If there is any other problem, feel free to contact us again! \n Thank you!" }
  ],
  professional: [
    { order: 1, text: "Hello, thank you for contacting the customer support team, how may I help you?" },
    { order: 2, text: "Certainly. Please provide your account number and customer ID so that I may locate your account." },
    { order: 3, text: "I have located your account. Can you please confirm that you would like to change your subscription plan from HyperParameter Basic to HyperParameter Plus? It will cause your bill to increase by $5.69." },
    { order: 4, text: "Okay, I have now updated your subscription plan. Please have a nice day." }
  ],
  high_emotionality: [
    { order: 1, text: 'yeah, whats the problem?' },
    { order: 2, text: "... i mean you know you can do this on the website right? \n whatever. just send me your details." },
    { order: 3, text: "ugh that took so long to find. are you sure you wanna change your subscription plan? its 5.69 extra." },
    { order: 4, text: "okay its done. just use the website next time." }
  ]
};

const AGENT_ORDER = ['minimalistic', 'polite', 'professional', 'high_emotionality'];

app.post('/api/session', async (req, res) => {
  try {
    const { consent_given } = req.body || {};
    if (!consent_given) return res.status(400).json({ error: 'consent_required' });

    // Use a DB-backed rotation pointer so it persists across restarts.
    // We update the pointer transactionally to avoid races.
    await pool.query('BEGIN');
    try {
      const s = await pool.query('SELECT value FROM server_state WHERE key=$1 FOR UPDATE', ['agent_rotation_index']);
      let currentIdx = -1;
      if (s.rowCount > 0 && s.rows[0].value && typeof s.rows[0].value.idx === 'number') {
        currentIdx = s.rows[0].value.idx;
      }
      const nextIdx = (currentIdx + 1) % AGENT_ORDER.length;
      const nextType = AGENT_ORDER[nextIdx];

      // persist new index
      await pool.query('UPDATE server_state SET value = $1 WHERE key = $2', [JSON.stringify({ idx: nextIdx }), 'agent_rotation_index']);

      const pseudoid = genPseudoId();
      const sessionObj = { agent_type: nextType, consent_given: true };
      const enc = encryptObject(sessionObj);
      await pool.query('INSERT INTO sessions(pseudoid, ciphertext, nonce, tag) VALUES($1,$2,$3,$4)', [pseudoid, enc.ciphertext, enc.nonce, enc.tag]);

      await pool.query('COMMIT');
      return res.json({ session_pseudoid: pseudoid, agent_type: nextType });
    } catch (e) {
      await pool.query('ROLLBACK');
      throw e;
    }
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'server_error' });
  }
});

app.get('/api/agent-script', (req, res) => {
  const type = req.query.agent_type || 'default';
  const script = AGENT_SCRIPTS[type] || AGENT_SCRIPTS['default'];
  res.json(script);
});

app.post('/api/survey', async (req, res) => {
  try {
    const { session_pseudoid, survey } = req.body || {};
    if (!session_pseudoid || !survey) return res.status(400).json({ error: 'invalid_payload' });

    // Capture a snapshot of the chat messages for this session
    const msgsRes = await pool.query(
      'SELECT pseudoid, created_at, ciphertext, nonce, tag FROM messages WHERE session_pseudoid=$1 ORDER BY created_at ASC',
      [session_pseudoid]
    );
    // store the encrypted message rows as snapshot (keep ciphertext/nonce/tag)
    const messages_snapshot = msgsRes.rows;

    const enc = encryptObject(survey);
    const pseudoid = genPseudoId();

    await pool.query(
      `INSERT INTO survey_responses(pseudoid, session_pseudoid, ciphertext, nonce, tag, schema_version, messages_snapshot)
       VALUES($1,$2,$3,$4,$5,$6,$7::jsonb)`,
      [
        pseudoid,
        session_pseudoid,
        enc.ciphertext,
        enc.nonce,
        enc.tag,
        '1',
        JSON.stringify(messages_snapshot)
      ]
    );

    // Return both the survey pseudoid and the session pseudoid so clients
    // can distinguish which id is which (session vs survey), and the
    // messages snapshot for convenience.
    res.json({ pseudoid, session_pseudoid, messages_snapshot });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'server_error' });
  }
});

// Store a chat message (user or agent)
app.post('/api/message', async (req, res) => {
  try {
    const { session_pseudoid, sender, content } = req.body || {};
    if (!session_pseudoid || !sender || typeof content !== 'string') return res.status(400).json({ error: 'invalid_payload' });
    const pseudoid = genPseudoId();
    const msgObj = { sender, content };
    const enc = encryptObject(msgObj);
    await pool.query(
      'INSERT INTO messages(pseudoid, session_pseudoid, ciphertext, nonce, tag) VALUES($1,$2,$3,$4,$5)',
      [pseudoid, session_pseudoid, enc.ciphertext, enc.nonce, enc.tag]
    );
    return res.json({ pseudoid });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'server_error' });
  }
});

// Get messages for a session
app.get('/api/messages', async (req, res) => {
  try {
    const session = req.query.session;
    if (!session) return res.status(400).json({ error: 'missing_session' });
    const limit = Math.min(1000, parseInt(req.query.limit || '100', 10));
    const r = await pool.query(
      'SELECT pseudoid, created_at, ciphertext, nonce, tag FROM messages WHERE session_pseudoid=$1 ORDER BY created_at ASC LIMIT $2',
      [session, limit]
    );
    const rows = r.rows.map(row => {
      try {
        const obj = decryptRecord({ ciphertext: row.ciphertext, nonce: row.nonce, tag: row.tag });
        return { pseudoid: row.pseudoid, sender: obj.sender, content: obj.content, created_at: row.created_at };
      } catch (e) {
        return { pseudoid: row.pseudoid, error: 'decryption_failed' };
      }
    });
    return res.json(rows);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'server_error' });
  }
});

// Admin: fetch encrypted survey record (returns only encrypted fields)
app.get('/api/survey/:pseudoid', async (req, res) => {
  try {
    const { pseudoid } = req.params;
    const r = await pool.query('SELECT pseudoid, session_pseudoid, ciphertext, nonce, tag, schema_version, messages_snapshot, created_at FROM survey_responses WHERE pseudoid=$1', [pseudoid]);
    if (r.rowCount === 0) return res.status(404).json({ error: 'not_found' });
    const row = r.rows[0];
    return res.json(row);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'server_error' });
  }
});

// Admin: decrypt and return plaintext survey (server-side decryption)
app.get('/api/survey/:pseudoid/plain', async (req, res) => {
  try {
    const { pseudoid } = req.params;
    const r = await pool.query('SELECT * FROM survey_responses WHERE pseudoid=$1', [pseudoid]);
    if (r.rowCount === 0) return res.status(404).json({ error: 'not_found' });
    const row = r.rows[0];
    try {
      const survey = decryptRecord({ ciphertext: row.ciphertext, nonce: row.nonce, tag: row.tag });
      let messages = row.messages_snapshot;
      if (!messages) {
        const m = await pool.query(
          'SELECT pseudoid, created_at, ciphertext, nonce, tag FROM messages WHERE session_pseudoid=$1 ORDER BY created_at ASC',
          [row.session_pseudoid]
        );
        messages = m.rows.map(rw => ({ pseudoid: rw.pseudoid, ...decryptRecord({ ciphertext: rw.ciphertext, nonce: rw.nonce, tag: rw.tag }) }));
      }
      return res.json({ pseudoid: row.pseudoid, session_pseudoid: row.session_pseudoid, survey, messages_snapshot: messages || [], created_at: row.created_at });
    } catch (e) {
      console.error('decryption_failed', e);
      return res.status(500).json({ error: 'decryption_failed' });
    }
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'server_error' });
  }
});

// Admin: fetch session metadata (no PII stored)
app.get('/api/session/:pseudoid', async (req, res) => {
  try {
    const { pseudoid } = req.params;
    const r = await pool.query('SELECT pseudoid, ciphertext, nonce, tag, created_at FROM sessions WHERE pseudoid=$1', [pseudoid]);
    if (r.rowCount === 0) return res.status(404).json({ error: 'not_found' });
    const row = r.rows[0];
    try {
      const session = decryptRecord({ ciphertext: row.ciphertext, nonce: row.nonce, tag: row.tag });
      return res.json({ pseudoid: row.pseudoid, ...session, created_at: row.created_at });
    } catch (e) {
      console.error('decryption_failed', e);
      return res.status(500).json({ error: 'decryption_failed' });
    }
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'server_error' });
  }
});

// Dev: list recent surveys (pseudoid, session_pseudoid, created_at)
app.get('/api/surveys', async (req, res) => {
  try {
    const limit = Math.min(100, parseInt(req.query.limit || '50', 10));
    const session = req.query.session;
    if (session) {
      const r = await pool.query(
        'SELECT pseudoid, session_pseudoid, created_at FROM survey_responses WHERE session_pseudoid=$1 ORDER BY created_at DESC LIMIT $2',
        [session, limit]
      );
      return res.json(r.rows);
    }
    const r = await pool.query(
      'SELECT pseudoid, session_pseudoid, created_at FROM survey_responses ORDER BY created_at DESC LIMIT $1',
      [limit]
    );
    return res.json(r.rows);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'server_error' });
  }
});

// Dev: list recent sessions (pseudoid, agent_type, consent_given, created_at)
app.get('/api/sessions', async (req, res) => {
  try {
    const limit = Math.min(100, parseInt(req.query.limit || '50', 10));
    const r = await pool.query('SELECT pseudoid, ciphertext, nonce, tag, created_at FROM sessions ORDER BY created_at DESC LIMIT $1', [limit]);
    const rows = r.rows.map(row => {
      try {
        const session = decryptRecord({ ciphertext: row.ciphertext, nonce: row.nonce, tag: row.tag });
        return { pseudoid: row.pseudoid, ...session, created_at: row.created_at };
      } catch (e) {
        return { pseudoid: row.pseudoid, error: 'decryption_failed' };
      }
    });
    return res.json(rows);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'server_error' });
  }
});

// Find session by an external session identifier or pseudoid.
// Query param: session_id
app.get('/api/session/find', async (req, res) => {
  try {
    const id = req.query.session_id;
    if (!id) return res.status(400).json({ error: 'missing_session_id' });

    // Only search by pseudoid when session metadata is encrypted.
    const r = await pool.query('SELECT pseudoid, ciphertext, nonce, tag, created_at FROM sessions WHERE pseudoid = $1 LIMIT 1', [id]);
    if (r.rowCount === 0) return res.status(404).json({ error: 'not_found' });
    const row = r.rows[0];
    let session;
    try {
      session = decryptRecord({ ciphertext: row.ciphertext, nonce: row.nonce, tag: row.tag });
    } catch (e) {
      return res.status(500).json({ error: 'decryption_failed' });
    }
    const s = await pool.query('SELECT pseudoid, created_at FROM survey_responses WHERE session_pseudoid=$1 ORDER BY created_at DESC', [row.pseudoid]);
    session.surveys = s.rows;
    return res.json({ pseudoid: row.pseudoid, ...session, created_at: row.created_at });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'server_error' });
  }
});

// Dev: search sessions by free-text term (searches pseudoid and metadata JSON text)
app.get('/api/session/search', async (req, res) => {
  try {
    const term = req.query.term;
    if (!term) return res.status(400).json({ error: 'missing_term' });
    // With encryption enabled, only exact pseudoid matches are supported for search.
    const r = await pool.query('SELECT pseudoid, ciphertext, nonce, tag, created_at FROM sessions WHERE pseudoid = $1 LIMIT 50', [term]);
    const rows = r.rows.map(row => {
      try {
        const session = decryptRecord({ ciphertext: row.ciphertext, nonce: row.nonce, tag: row.tag });
        return { pseudoid: row.pseudoid, ...session, created_at: row.created_at };
      } catch (e) {
        return { pseudoid: row.pseudoid, error: 'decryption_failed' };
      }
    });
    return res.json(rows);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'server_error' });
  }
});

async function start() {
  try {
    await init();
    app.listen(PORT, () => console.log(`Backend listening on ${PORT}`));
  } catch (err) {
    console.error('Failed to start server', err);
    process.exit(1);
  }
}

start();
