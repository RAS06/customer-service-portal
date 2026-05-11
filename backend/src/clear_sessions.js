const { pool } = require('./db');

(async () => {
  try {
    console.log('Starting session history deletion (no backup requested).');

    console.log('Deleting messages...');
    await pool.query('DELETE FROM messages');

    console.log('Deleting survey_responses...');
    await pool.query('DELETE FROM survey_responses');

    console.log('Deleting sessions...');
    await pool.query('DELETE FROM sessions');

    const counts = {};
    const r1 = await pool.query('SELECT count(*)::int AS cnt FROM messages');
    const r2 = await pool.query('SELECT count(*)::int AS cnt FROM survey_responses');
    const r3 = await pool.query('SELECT count(*)::int AS cnt FROM sessions');
    counts.messages = r1.rows[0].cnt;
    counts.survey_responses = r2.rows[0].cnt;
    counts.sessions = r3.rows[0].cnt;

    console.log('Deletion complete. Remaining counts:');
    console.log(JSON.stringify(counts, null, 2));
  } catch (err) {
    console.error('Error during deletion:', err);
    process.exitCode = 2;
  } finally {
    await pool.end();
  }
})();
