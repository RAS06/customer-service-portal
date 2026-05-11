#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// This file is a copy of decrypt_messages.js renamed to decrypt_csv_files.js
// It decrypts messages.csv, sessions.csv, and survey_responses.csv producing
// messages_unencrypted.csv, sessions_unencrypted.csv, and survey_responses_unencrypted.csv

function readEnvFile(p) {
  try {
    const s = fs.readFileSync(p, 'utf8');
    const lines = s.split(/\r?\n/);
    const map = {};
    for (const l of lines) {
      const m = l.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
      if (m) {
        let v = m[2];
        if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
          v = v.slice(1, -1);
        }
        map[m[1]] = v;
      }
    }
    return map;
  } catch (e) {
    return {};
  }
}

function deriveKey(master) {
  return crypto.createHash('sha256').update(master).digest();
}

function csvEscape(v) {
  if (v === null || v === undefined) return '';
  const s = String(v);
  if (s.includes('"') || s.includes(',') || s.includes('\n') || s.includes('\r')) {
    return '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
}

function parseCSV(text) {
  const rows = [];
  let cur = [];
  let i = 0;
  let field = '';
  let inQuotes = false;
  while (i < text.length) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (i + 1 < text.length && text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        } else {
          inQuotes = false;
          i++;
          continue;
        }
      } else {
        field += ch;
        i++;
        continue;
      }
    } else {
      if (ch === ',') {
        cur.push(field);
        field = '';
        i++;
        continue;
      }
      if (ch === '\n' || ch === '\r') {
        if (ch === '\r' && i + 1 < text.length && text[i + 1] === '\n') i++;
        cur.push(field);
        rows.push(cur);
        cur = [];
        field = '';
        i++;
        continue;
      }
      if (ch === '"') {
        inQuotes = true;
        i++;
        continue;
      }
      field += ch;
      i++;
    }
  }
  if (field !== '' || cur.length > 0) {
    cur.push(field);
    rows.push(cur);
  }
  return rows;
}

async function main() {
  const projectRoot = path.resolve(__dirname, '..');
  const inFile = path.join(projectRoot, 'messages.csv');
  const outFile = path.join(projectRoot, 'messages_unencrypted.csv');

  if (!fs.existsSync(inFile)) {
    console.error('Input file not found:', inFile);
    process.exitCode = 2;
    return;
  }

  let MASTER_KEY = process.env.MASTER_KEY || '';
  if (!MASTER_KEY) {
    const envPath = path.join(projectRoot, '.env');
    const env = readEnvFile(envPath);
    MASTER_KEY = env.MASTER_KEY || '';
  }
  if (!MASTER_KEY) {
    console.error('MASTER_KEY not found in environment or .env');
    process.exitCode = 3;
    return;
  }

  const key = deriveKey(MASTER_KEY);

  const text = fs.readFileSync(inFile, 'utf8');
  const parsed = parseCSV(text);
  if (!parsed || parsed.length === 0) {
    console.error('Empty CSV');
    return;
  }
  const cols = parsed[0].map(c => c.trim());
  const idx = {
    pseudoid: cols.indexOf('pseudoid'),
    session_pseudoid: cols.indexOf('session_pseudoid'),
    ciphertext_hex: cols.indexOf('ciphertext_hex'),
    nonce_hex: cols.indexOf('nonce_hex'),
    tag_hex: cols.indexOf('tag_hex'),
    created_at: cols.indexOf('created_at'),
  };

  const outLines = [];
  outLines.push(['pseudoid','session_pseudoid','sender','content','created_at'].join(','));

  for (let r = 1; r < parsed.length; r++) {
    const parts = parsed[r];
    if (parts.length === 1 && parts[0] === '') continue;
    const pseudoid = parts[idx.pseudoid] || '';
    const session_pseudoid = parts[idx.session_pseudoid] || '';
    const ct_hex = (idx.ciphertext_hex >=0) ? parts[idx.ciphertext_hex] : '';
    const nonce_hex = (idx.nonce_hex >=0) ? parts[idx.nonce_hex] : '';
    const tag_hex = (idx.tag_hex >=0) ? parts[idx.tag_hex] : '';
    const created_at = (idx.created_at >=0) ? parts[idx.created_at] : '';

    let sender = '';
    let content = '';
    if (ct_hex && ct_hex.trim()) {
      try {
        const iv = Buffer.from(nonce_hex, 'hex');
        const tag = Buffer.from(tag_hex, 'hex');
        const ciphertext = Buffer.from(ct_hex, 'hex');
        const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
        decipher.setAuthTag(tag);
        const pt = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
        const obj = JSON.parse(pt.toString('utf8'));
        sender = obj.sender || '';
        content = obj.content || '';
      } catch (e) {
        sender = '';
        content = `__decryption_failed__: ${e.message}`;
      }
    }

    outLines.push([
      csvEscape(pseudoid),
      csvEscape(session_pseudoid),
      csvEscape(sender),
      csvEscape(content),
      csvEscape(created_at)
    ].join(','));
  }

  fs.writeFileSync(outFile, outLines.join('\n'));
  console.log('Wrote', outFile);
}

function decryptRow(ciphertext_hex, nonce_hex, tag_hex, key) {
  if (!ciphertext_hex) return null;
  try {
    const iv = Buffer.from(nonce_hex, 'hex');
    const tag = Buffer.from(tag_hex, 'hex');
    const ciphertext = Buffer.from(ciphertext_hex, 'hex');
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    const pt = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return JSON.parse(pt.toString('utf8'));
  } catch (e) {
    return { __decryption_error__: e.message };
  }
}

function decryptSessions(projectRoot, key) {
  const inFile = path.join(projectRoot, 'sessions.csv');
  const outFile = path.join(projectRoot, 'sessions_unencrypted.csv');
  if (!fs.existsSync(inFile)) return;
  const txt = fs.readFileSync(inFile, 'utf8');
  const rows = parseCSV(txt);
  if (!rows || rows.length < 1) return;
  const cols = rows[0].map(c => c.trim());
  const idx = { pseudoid: cols.indexOf('pseudoid'), ciphertext_hex: cols.indexOf('ciphertext_hex') >=0 ? cols.indexOf('ciphertext_hex') : cols.indexOf('ciphertext'), nonce_hex: cols.indexOf('nonce_hex') >=0 ? cols.indexOf('nonce_hex') : cols.indexOf('nonce'), tag_hex: cols.indexOf('tag_hex') >=0 ? cols.indexOf('tag_hex') : cols.indexOf('tag'), created_at: cols.indexOf('created_at') };
  const out = [];
  out.push(['pseudoid','agent_type','consent_given','metadata','created_at'].join(','));
  for (let r = 1; r < rows.length; r++) {
    const p = rows[r];
    if (p.length === 1 && p[0] === '') continue;
    const pseudoid = p[idx.pseudoid] || '';
    const ct = (idx.ciphertext_hex>=0)?p[idx.ciphertext_hex]:'';
    const nonce = (idx.nonce_hex>=0)?p[idx.nonce_hex]:'';
    const tag = (idx.tag_hex>=0)?p[idx.tag_hex]:'';
    const created_at = (idx.created_at>=0)?p[idx.created_at]:'';
    const dec = decryptRow(ct, nonce, tag, key);
    let agent_type = '';
    let consent_given = '';
    let metadata = '';
    if (dec) {
      if (dec.__decryption_error__) {
        metadata = `__decryption_failed__:${dec.__decryption_error__}`;
      } else {
        agent_type = dec.agent_type || '';
        consent_given = dec.consent_given === undefined ? '' : String(dec.consent_given);
        metadata = dec.metadata ? JSON.stringify(dec.metadata) : '';
      }
    }
    out.push([csvEscape(pseudoid), csvEscape(agent_type), csvEscape(consent_given), csvEscape(metadata), csvEscape(created_at)].join(','));
  }
  fs.writeFileSync(outFile, out.join('\n'));
  console.log('Wrote', outFile);
}

function decryptSurveys(projectRoot, key) {
  const inFile = path.join(projectRoot, 'survey_responses.csv');
  const outFile = path.join(projectRoot, 'survey_responses_unencrypted.csv');
  if (!fs.existsSync(inFile)) return;
  const txt = fs.readFileSync(inFile, 'utf8');
  const rows = parseCSV(txt);
  if (!rows || rows.length < 1) return;
  const cols = rows[0].map(c => c.trim());
  const idx = {
    pseudoid: cols.indexOf('pseudoid'),
    session_pseudoid: cols.indexOf('session_pseudoid'),
    ciphertext_hex: cols.indexOf('ciphertext_hex') >=0 ? cols.indexOf('ciphertext_hex') : cols.indexOf('ciphertext'),
    nonce_hex: cols.indexOf('nonce_hex') >=0 ? cols.indexOf('nonce_hex') : cols.indexOf('nonce'),
    tag_hex: cols.indexOf('tag_hex') >=0 ? cols.indexOf('tag_hex') : cols.indexOf('tag'),
    schema_version: cols.indexOf('schema_version'),
    messages_snapshot: cols.indexOf('messages_snapshot') >=0 ? cols.indexOf('messages_snapshot') : cols.indexOf('messages_snapshot_text'),
    created_at: cols.indexOf('created_at')
  };
  const out = [];
  out.push(['pseudoid','session_pseudoid','survey_json','messages_snapshot_unencrypted','schema_version','created_at'].join(','));
  for (let r = 1; r < rows.length; r++) {
    const p = rows[r];
    if (p.length === 1 && p[0] === '') continue;
    const pseudoid = p[idx.pseudoid] || '';
    const session_pseudoid = p[idx.session_pseudoid] || '';
    const ct = (idx.ciphertext_hex>=0)?p[idx.ciphertext_hex]:'';
    const nonce = (idx.nonce_hex>=0)?p[idx.nonce_hex]:'';
    const tag = (idx.tag_hex>=0)?p[idx.tag_hex]:'';
    const schema_version = (idx.schema_version>=0)?p[idx.schema_version]:'';
    const messages_snapshot_text = (idx.messages_snapshot>=0)?p[idx.messages_snapshot]:'';
    const created_at = (idx.created_at>=0)?p[idx.created_at]:'';
    const dec = decryptRow(ct, nonce, tag, key);
    let survey_json = '';
    if (dec) {
      if (dec.__decryption_error__) survey_json = `__decryption_failed__:${dec.__decryption_error__}`;
      else survey_json = JSON.stringify(dec);
    }
    let messages_snapshot_unencrypted = '';
    if (messages_snapshot_text) {
      try {
        const mobj = JSON.parse(messages_snapshot_text);
        const decrypted = mobj.map(it => {
          const cth = it.ciphertext || it.ciphertext_hex || '';
          const nv = it.nonce || it.nonce_hex || '';
          const tg = it.tag || it.tag_hex || '';
          if (cth) {
            const d = decryptRow(cth, nv, tg, key);
            if (d && !d.__decryption_error__) return { pseudoid: it.pseudoid, created_at: it.created_at, ...d };
            return { pseudoid: it.pseudoid, created_at: it.created_at, __decryption_error__: d && d.__decryption_error__ };
          }
          return it;
        });
        messages_snapshot_unencrypted = JSON.stringify(decrypted);
      } catch (e) {
        messages_snapshot_unencrypted = `__snapshot_parse_failed__:${e.message}`;
      }
    }
    out.push([
      csvEscape(pseudoid),
      csvEscape(session_pseudoid),
      csvEscape(survey_json),
      csvEscape(messages_snapshot_unencrypted),
      csvEscape(schema_version),
      csvEscape(created_at)
    ].join(','));
  }
  fs.writeFileSync(outFile, out.join('\n'));
  console.log('Wrote', outFile);
}

async function mainAll() {
  const projectRoot = path.resolve(__dirname, '..');
  let MASTER_KEY = process.env.MASTER_KEY || '';
  if (!MASTER_KEY) {
    const envPath = path.join(projectRoot, '.env');
    const env = readEnvFile(envPath);
    MASTER_KEY = env.MASTER_KEY || '';
  }
  if (!MASTER_KEY) {
    console.error('MASTER_KEY not found in environment or .env');
    process.exitCode = 3;
    return;
  }
  const key = deriveKey(MASTER_KEY);

  await main();
  decryptSessions(projectRoot, key);
  decryptSurveys(projectRoot, key);
}

mainAll();
