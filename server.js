// server.js — Serveur API Baccalauréat (PostgreSQL / Railway)
const express = require('express');
const cors    = require('cors');
const path    = require('path');
const { Pool } = require('pg');

const app  = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ─── CONNEXION PostgreSQL ───────────────────────────────────────────────────
// Railway injecte automatiquement DATABASE_URL dans les variables d'environnement
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false
});

// ─── INIT TABLES + SEED ────────────────────────────────────────────────────
async function initDB() {
  const client = await pool.connect();
  try {
    // Créer les tables si elles n'existent pas
    await client.query(`
      CREATE TABLE IF NOT EXISTS etablissement (
        code INTEGER PRIMARY KEY,
        nom  TEXT NOT NULL
      );
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS salle (
        id        SERIAL PRIMARY KEY,
        code_etab INTEGER NOT NULL REFERENCES etablissement(code),
        num_salle TEXT NOT NULL,
        capacite  INTEGER NOT NULL
      );
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS jury (
        id        SERIAL PRIMARY KEY,
        numero    INTEGER NOT NULL,
        nom       TEXT,
        code_etab INTEGER NOT NULL REFERENCES etablissement(code)
      );
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS dispatch (
        id        SERIAL PRIMARY KEY,
        code_etab INTEGER NOT NULL REFERENCES etablissement(code),
        date_disp DATE NOT NULL,
        session   TEXT NOT NULL CHECK(session IN ('MATIN','APRES_MIDI')),
        jury_id   INTEGER NOT NULL REFERENCES jury(id),
        salle_id  INTEGER NOT NULL REFERENCES salle(id)
      );
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS verification (
        id           SERIAL PRIMARY KEY,
        code_etab    INTEGER NOT NULL REFERENCES etablissement(code),
        date_verif   DATE NOT NULL,
        session      TEXT NOT NULL CHECK(session IN ('MATIN','APRES_MIDI')),
        salle_id     INTEGER NOT NULL REFERENCES salle(id),
        jury_id      INTEGER NOT NULL REFERENCES jury(id),
        conforme     BOOLEAN NOT NULL,
        heure_verif  TIMESTAMP DEFAULT NOW()
      );
    `);

    // Seed : charger les données si la table est vide
    const { rows } = await client.query('SELECT COUNT(*) as c FROM etablissement');
    if (parseInt(rows[0].c) === 0) {
      console.log('[DB] Chargement des données initiales...');
      const seed = require('./seeddata.json');

      for (const e of seed.etablissements) {
        await client.query(
          'INSERT INTO etablissement(code, nom) VALUES($1, $2) ON CONFLICT DO NOTHING',
          [e.CODEETABLISSEMENT, e.NOMETABLISSEMENT]
        );
      }

      for (const s of seed.salles) {
        await client.query(
          'INSERT INTO salle(code_etab, num_salle, capacite) VALUES($1, $2, $3)',
          [s.CODEETABLISSEMENT, String(s.numSalle), s.capaciteaccueil]
        );
      }

      // Calculer et créer les jurys par établissement
      const etabMap = {};
      for (const s of seed.salles) {
        if (!etabMap[s.CODEETABLISSEMENT]) etabMap[s.CODEETABLISSEMENT] = 0;
        etabMap[s.CODEETABLISSEMENT] += Math.ceil(s.capaciteaccueil / 20);
      }
      for (const [code, total] of Object.entries(etabMap)) {
        for (let i = 1; i <= total; i++) {
          await client.query(
            'INSERT INTO jury(numero, nom, code_etab) VALUES($1, $2, $3)',
            [i, null, parseInt(code)]
          );
        }
      }

      console.log('[DB] Données initiales chargées.');
    }

    console.log('[DB] Base prête.');
  } finally {
    client.release();
  }
}

// ─── HELPER shuffle ────────────────────────────────────────────────────────
function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// ─── ROUTES ────────────────────────────────────────────────────────────────

// GET /etablissements
app.get('/etablissements', async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT e.code, e.nom,
        (SELECT COUNT(*) FROM salle s WHERE s.code_etab = e.code)::int AS nb_salles,
        (SELECT COUNT(*) FROM jury  j WHERE j.code_etab = e.code)::int AS nb_jurys
      FROM etablissement e
      ORDER BY e.nom
    `);
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /etablissements/:code
app.get('/etablissements/:code', async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT code, nom FROM etablissement WHERE code=$1', [req.params.code]);
    if (!rows.length) return res.status(404).json({ error: 'Non trouvé' });
    res.json(rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /etablissements/:code/salles
app.get('/etablissements/:code/salles', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, num_salle, capacite FROM salle
       WHERE code_etab=$1 ORDER BY num_salle`, [req.params.code]);
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /etablissements/:code/jurys
app.get('/etablissements/:code/jurys', async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT id, numero, nom FROM jury WHERE code_etab=$1 ORDER BY numero',
      [req.params.code]);
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /dispatch/:code/:date/:session
app.get('/dispatch/:code/:date/:session', async (req, res) => {
  try {
    const { code, date, session } = req.params;
    const { rows } = await pool.query(`
      SELECT
        s.num_salle,
        s.capacite,
        j.numero   AS jury_numero,
        j.nom      AS jury_nom,
        d.id       AS dispatch_id
      FROM dispatch d
      JOIN salle s ON s.id = d.salle_id
      JOIN jury  j ON j.id = d.jury_id
      WHERE d.code_etab=$1 AND d.date_disp=$2 AND d.session=$3
      ORDER BY s.num_salle
    `, [code, date, session.toUpperCase()]);
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /dispatch/generer  — Body: { code_etab, date, session }
app.post('/dispatch/generer', async (req, res) => {
  const client = await pool.connect();
  try {
    const { code_etab, date, session } = req.body;
    if (!code_etab || !date || !session)
      return res.status(400).json({ error: 'code_etab, date, session requis' });
    const sessionUp = session.toUpperCase();

    await client.query('BEGIN');

    // Supprimer ancien dispatch si existant
    const existing = await client.query(
      'SELECT COUNT(*) as c FROM dispatch WHERE code_etab=$1 AND date_disp=$2 AND session=$3',
      [code_etab, date, sessionUp]);
    const alreadyExists = parseInt(existing.rows[0].c) > 0;
    if (alreadyExists) {
      await client.query(
        'DELETE FROM dispatch WHERE code_etab=$1 AND date_disp=$2 AND session=$3',
        [code_etab, date, sessionUp]);
    }

    // Récupérer salles et jurys
    const { rows: salles } = await client.query(
      'SELECT id, capacite FROM salle WHERE code_etab=$1 ORDER BY num_salle', [code_etab]);
    const { rows: jurys } = await client.query(
      'SELECT id FROM jury WHERE code_etab=$1 ORDER BY numero', [code_etab]);

    if (!salles.length) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Aucune salle' }); }
    if (!jurys.length)  { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Aucun jury' }); }

    // Construire les assignments (une ligne par jury nécessaire dans chaque salle)
    const assignments = [];
    for (const salle of salles) {
      const needed = Math.ceil(salle.capacite / 20);
      for (let i = 0; i < needed; i++) assignments.push(salle.id);
    }

    const shuffledJurys = shuffle(jurys.map(j => j.id));
    const total = Math.min(assignments.length, shuffledJurys.length);

    for (let i = 0; i < total; i++) {
      await client.query(
        'INSERT INTO dispatch(code_etab, date_disp, session, jury_id, salle_id) VALUES($1,$2,$3,$4,$5)',
        [code_etab, date, sessionUp, shuffledJurys[i], assignments[i]]
      );
    }

    await client.query('COMMIT');
    res.json({ success: true, message: `${total} jurys affectés`, regenerated: alreadyExists });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// POST /dispatch/generer-tous  — Body: { date, session }
app.post('/dispatch/generer-tous', async (req, res) => {
  const client = await pool.connect();
  try {
    const { date, session } = req.body;
    if (!date || !session) return res.status(400).json({ error: 'date et session requis' });
    const sessionUp = session.toUpperCase();

    const { rows: etabs } = await client.query('SELECT code FROM etablissement');
    let totalAffect = 0;

    await client.query('BEGIN');
    for (const e of etabs) {
      await client.query(
        'DELETE FROM dispatch WHERE code_etab=$1 AND date_disp=$2 AND session=$3',
        [e.code, date, sessionUp]);

      const { rows: salles } = await client.query(
        'SELECT id, capacite FROM salle WHERE code_etab=$1', [e.code]);
      const { rows: jurys } = await client.query(
        'SELECT id FROM jury WHERE code_etab=$1', [e.code]);
      if (!salles.length || !jurys.length) continue;

      const assignments = [];
      for (const s of salles) {
        const n = Math.ceil(s.capacite / 20);
        for (let i = 0; i < n; i++) assignments.push(s.id);
      }
      const shuffled = shuffle(jurys.map(j => j.id));
      const count = Math.min(assignments.length, shuffled.length);

      for (let i = 0; i < count; i++) {
        await client.query(
          'INSERT INTO dispatch(code_etab, date_disp, session, jury_id, salle_id) VALUES($1,$2,$3,$4,$5)',
          [e.code, date, sessionUp, shuffled[i], assignments[i]]
        );
      }
      totalAffect += count;
    }
    await client.query('COMMIT');
    res.json({ success: true, message: `Dispatch global : ${totalAffect} affectations sur ${etabs.length} établissements` });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// PUT /jurys/:id  — mettre à jour le nom d'un jury
app.put('/jurys/:id', async (req, res) => {
  try {
    const { nom } = req.body;
    await pool.query('UPDATE jury SET nom=$1 WHERE id=$2', [nom, req.params.id]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── DÉMARRAGE ─────────────────────────────────────────────────────────────
initDB().then(() => {
  app.listen(PORT, () => {
    console.log(`\n✅ Serveur BAC démarré sur port ${PORT}`);
    console.log(`   Interface admin : http://localhost:${PORT}/admin.html\n`);
  });
}).catch(err => {
  console.error('Erreur DB:', err);
  process.exit(1);
});

// ─── VÉRIFICATION ──────────────────────────────────────────────────────────

// POST /verifier
app.post('/verifier', async (req, res) => {
  try {
    const { qr_salle, qr_jury, date, session } = req.body;
    if (!qr_salle || !qr_jury || !date || !session)
      return res.status(400).json({ error: 'qr_salle, qr_jury, date, session requis' });

    const partsSalle = qr_salle.split(':');
    const partsJury  = qr_jury.split(':');
    if (partsSalle[0] !== 'SALLE' || partsJury[0] !== 'JURY')
      return res.status(400).json({ conforme: false, message: 'Format QR invalide' });

    const codeEtabSalle = parseInt(partsSalle[1]);
    const numSalle      = partsSalle[2];
    const codeEtabJury  = parseInt(partsJury[1]);
    const numeroJury    = parseInt(partsJury[2]);
    const sessionUp     = session.toUpperCase();

    if (codeEtabSalle !== codeEtabJury)
      return res.json({ conforme: false, message: '❌ La salle et le jury ne sont pas du même établissement' });

    const { rows: salleRows } = await pool.query(
      'SELECT id, num_salle, capacite FROM salle WHERE code_etab=$1 AND num_salle=$2',
      [codeEtabSalle, numSalle]);
    if (!salleRows.length) return res.json({ conforme: false, message: '❌ Salle non trouvée' });
    const salle = salleRows[0];

    const { rows: juryRows } = await pool.query(
      'SELECT id, numero, nom FROM jury WHERE code_etab=$1 AND numero=$2',
      [codeEtabJury, numeroJury]);
    if (!juryRows.length) return res.json({ conforme: false, message: '❌ Jury non trouvé' });
    const jury = juryRows[0];

    const { rows: dispatchRows } = await pool.query(
      'SELECT id FROM dispatch WHERE code_etab=$1 AND date_disp=$2 AND session=$3 AND jury_id=$4 AND salle_id=$5',
      [codeEtabSalle, date, sessionUp, jury.id, salle.id]);
    const conforme = dispatchRows.length > 0;

    let salleAttendue = null;
    if (!conforme) {
      const { rows: att } = await pool.query(
        'SELECT s.num_salle FROM dispatch d JOIN salle s ON s.id=d.salle_id WHERE d.code_etab=$1 AND d.date_disp=$2 AND d.session=$3 AND d.jury_id=$4',
        [codeEtabSalle, date, sessionUp, jury.id]);
      if (att.length) salleAttendue = att[0].num_salle;
    }

    // Upsert verification
    await pool.query(
      'INSERT INTO verification(code_etab,date_verif,session,salle_id,jury_id,conforme) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING',
      [codeEtabSalle, date, sessionUp, salle.id, jury.id, conforme]);

    res.json({
      conforme,
      message: conforme
        ? `✅ Jury ${jury.numero}${jury.nom ? ' — '+jury.nom : ''} est bien en Salle ${salle.num_salle}`
        : `❌ Jury ${jury.numero} ne devrait PAS être en Salle ${salle.num_salle}${salleAttendue ? '. Salle attendue : '+salleAttendue : ''}`,
      jury_numero: jury.numero,
      jury_nom: jury.nom,
      num_salle: salle.num_salle,
      salle_attendue: salleAttendue,
      code_etab: codeEtabSalle
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /verifications/:code/:date/:session
app.get('/verifications/:code/:date/:session', async (req, res) => {
  try {
    const { code, date, session } = req.params;
    const { rows } = await pool.query(`
      SELECT s.num_salle, j.numero AS jury_numero, j.nom AS jury_nom,
             v.conforme, v.heure_verif
      FROM verification v
      JOIN salle s ON s.id=v.salle_id
      JOIN jury  j ON j.id=v.jury_id
      WHERE v.code_etab=$1 AND v.date_verif=$2 AND v.session=$3
      ORDER BY s.num_salle, j.numero
    `, [code, date, session.toUpperCase()]);
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /verifications/stats/:date/:session
app.get('/verifications/stats/:date/:session', async (req, res) => {
  try {
    const { date, session } = req.params;
    const { rows } = await pool.query(`
      SELECT e.nom, e.code,
        COUNT(v.id)::int AS total_verif,
        SUM(CASE WHEN v.conforme THEN 1 ELSE 0 END)::int AS conformes,
        SUM(CASE WHEN NOT v.conforme THEN 1 ELSE 0 END)::int AS non_conformes,
        (SELECT COUNT(*) FROM jury j WHERE j.code_etab=e.code)::int AS total_jurys
      FROM etablissement e
      LEFT JOIN verification v ON v.code_etab=e.code AND v.date_verif=$1 AND v.session=$2
      GROUP BY e.code, e.nom ORDER BY e.nom
    `, [date, session.toUpperCase()]);
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /qrcodes/:code
app.get('/qrcodes/:code', async (req, res) => {
  try {
    const code = parseInt(req.params.code);
    const { rows: etabRows } = await pool.query('SELECT code, nom FROM etablissement WHERE code=$1', [code]);
    if (!etabRows.length) return res.status(404).json({ error: 'Non trouvé' });
    const { rows: salles } = await pool.query('SELECT num_salle FROM salle WHERE code_etab=$1 ORDER BY num_salle', [code]);
    const { rows: jurys  } = await pool.query('SELECT numero, nom FROM jury WHERE code_etab=$1 ORDER BY numero', [code]);
    res.json({
      etablissement: etabRows[0],
      qr_chef:   `CHEF:${code}`,
      qr_salles: salles.map(s => ({ num_salle: s.num_salle, qr: `SALLE:${code}:${s.num_salle}` })),
      qr_jurys:  jurys.map(j =>  ({ numero: j.numero, nom: j.nom, qr: `JURY:${code}:${j.numero}` }))
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});
