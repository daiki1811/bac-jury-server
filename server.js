// server.js — Serveur API Baccalauréat v2.0
const express = require('express');
const cors    = require('cors');
const path    = require('path');
const { Pool } = require('pg');

const app  = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ─── PostgreSQL ─────────────────────────────────────────────────────────────
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false
});

// ─── Firebase Admin (notifications push) ────────────────────────────────────
let firebaseAdmin = null;
try {
  const admin = require('firebase-admin');
  if (process.env.FIREBASE_SERVICE_ACCOUNT) {
    const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
    admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
    firebaseAdmin = admin;
    console.log('[FCM] Firebase Admin initialisé');
  } else {
    console.log('[FCM] FIREBASE_SERVICE_ACCOUNT absent — notifications désactivées');
  }
} catch(e) {
  console.log('[FCM] firebase-admin non disponible:', e.message);
}

// ─── INIT DB ─────────────────────────────────────────────────────────────────
async function initDB() {
  const client = await pool.connect();
  try {
    await client.query(`CREATE TABLE IF NOT EXISTS etablissement (
      code INTEGER PRIMARY KEY, nom TEXT NOT NULL);`);

    await client.query(`CREATE TABLE IF NOT EXISTS salle (
      id SERIAL PRIMARY KEY, code_etab INTEGER NOT NULL REFERENCES etablissement(code),
      num_salle TEXT NOT NULL, capacite INTEGER NOT NULL);`);

    await client.query(`CREATE TABLE IF NOT EXISTS jury (
      id SERIAL PRIMARY KEY, numero INTEGER NOT NULL, nom TEXT,
      code_etab INTEGER NOT NULL REFERENCES etablissement(code));`);

    await client.query(`CREATE TABLE IF NOT EXISTS dispatch (
      id SERIAL PRIMARY KEY, code_etab INTEGER NOT NULL REFERENCES etablissement(code),
      date_disp DATE NOT NULL, session TEXT NOT NULL CHECK(session IN ('MATIN','APRES_MIDI')),
      jury_id INTEGER NOT NULL REFERENCES jury(id),
      salle_id INTEGER NOT NULL REFERENCES salle(id));`);

    await client.query(`CREATE TABLE IF NOT EXISTS verification (
      id SERIAL PRIMARY KEY, code_etab INTEGER NOT NULL REFERENCES etablissement(code),
      date_verif DATE NOT NULL, session TEXT NOT NULL CHECK(session IN ('MATIN','APRES_MIDI')),
      salle_id INTEGER NOT NULL REFERENCES salle(id),
      jury_id INTEGER NOT NULL REFERENCES jury(id),
      conforme BOOLEAN NOT NULL, synced BOOLEAN DEFAULT TRUE,
      heure_verif TIMESTAMP DEFAULT NOW());`);

    // NOUVEAU: jours d'examen configurés par l'admin
    await client.query(`CREATE TABLE IF NOT EXISTS jours_examen (
      id SERIAL PRIMARY KEY, date_exam DATE NOT NULL UNIQUE,
      label TEXT NOT NULL, actif BOOLEAN DEFAULT TRUE,
      created_at TIMESTAMP DEFAULT NOW());`);

    // NOUVEAU: tokens FCM pour les notifications push
    await client.query(`CREATE TABLE IF NOT EXISTS fcm_tokens (
      id SERIAL PRIMARY KEY, code_etab INTEGER NOT NULL REFERENCES etablissement(code),
      token TEXT NOT NULL, created_at TIMESTAMP DEFAULT NOW(),
      UNIQUE(code_etab, token));`);

    // Seed
    const { rows } = await client.query('SELECT COUNT(*) as c FROM etablissement');
    if (parseInt(rows[0].c) === 0) {
      console.log('[DB] Chargement des données initiales...');
      const seed = require('./seeddata.json');
      for (const e of seed.etablissements)
        await client.query('INSERT INTO etablissement(code,nom) VALUES($1,$2) ON CONFLICT DO NOTHING',
          [e.CODEETABLISSEMENT, e.NOMETABLISSEMENT]);
      for (const s of seed.salles)
        await client.query('INSERT INTO salle(code_etab,num_salle,capacite) VALUES($1,$2,$3)',
          [s.CODEETABLISSEMENT, String(s.numSalle), s.capaciteaccueil]);
      const etabMap = {};
      for (const s of seed.salles) {
        if (!etabMap[s.CODEETABLISSEMENT]) etabMap[s.CODEETABLISSEMENT] = 0;
        etabMap[s.CODEETABLISSEMENT] += Math.ceil(s.capaciteaccueil / 20);
      }
      for (const [code, total] of Object.entries(etabMap))
        for (let i = 1; i <= total; i++)
          await client.query('INSERT INTO jury(numero,nom,code_etab) VALUES($1,$2,$3)',
            [i, null, parseInt(code)]);
      console.log('[DB] Données initiales chargées.');
    }
    // Signalement table
    await client.query(`CREATE TABLE IF NOT EXISTS signalement (
      id           SERIAL PRIMARY KEY,
      code_etab    INTEGER NOT NULL REFERENCES etablissement(code),
      date_signal  DATE NOT NULL DEFAULT CURRENT_DATE,
      session      TEXT,
      description  TEXT NOT NULL,
      photo_url    TEXT,
      heure_signal TIMESTAMP DEFAULT NOW()
    );`);

    console.log("[DB] Base prête.".');
  } finally { client.release(); }
}

// ─── HELPERS ─────────────────────────────────────────────────────────────────
function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length-1; i > 0; i--) {
    const j = Math.floor(Math.random()*(i+1));
    [a[i],a[j]] = [a[j],a[i]];
  }
  return a;
}

// Envoyer une notification FCM à tous les tokens d'un établissement (ou tous)
async function envoyerNotification(titre, corps, codeEtab = null) {
  if (!firebaseAdmin) return;
  try {
    let query = 'SELECT DISTINCT token FROM fcm_tokens';
    const params = [];
    if (codeEtab) { query += ' WHERE code_etab=$1'; params.push(codeEtab); }
    const { rows } = await pool.query(query, params);
    if (!rows.length) return;
    const tokens = rows.map(r => r.token);
    const message = { notification: { title: titre, body: corps },
      android: { notification: { sound: 'default', priority: 'high' } },
      tokens };
    const result = await firebaseAdmin.messaging().sendEachForMulticast(message);
    console.log(`[FCM] Envoyé: ${result.successCount}/${tokens.length}`);
  } catch(e) { console.error('[FCM] Erreur:', e.message); }
}

// ─── ÉTABLISSEMENTS ──────────────────────────────────────────────────────────
app.get('/etablissements', async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT e.code, e.nom,
        (SELECT COUNT(*) FROM salle s WHERE s.code_etab=e.code)::int AS nb_salles,
        (SELECT COUNT(*) FROM jury j WHERE j.code_etab=e.code)::int AS nb_jurys
      FROM etablissement e ORDER BY e.nom`);
    res.json(rows);
  } catch(err) { res.status(500).json({error:err.message}); }
});

app.get('/etablissements/:code', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT code,nom FROM etablissement WHERE code=$1', [req.params.code]);
    if (!rows.length) return res.status(404).json({error:'Non trouvé'});
    res.json(rows[0]);
  } catch(err) { res.status(500).json({error:err.message}); }
});

// ─── JOURS D'EXAMEN ──────────────────────────────────────────────────────────

// GET /jours — liste tous les jours actifs (pour l'app Android)
app.get('/jours', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, date_exam, label, actif FROM jours_examen
       WHERE actif=TRUE ORDER BY date_exam`);
    res.json(rows);
  } catch(err) { res.status(500).json({error:err.message}); }
});

// GET /jours/tous — tous les jours (pour l'admin)
app.get('/jours/tous', async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT id, date_exam, label, actif FROM jours_examen ORDER BY date_exam');
    res.json(rows);
  } catch(err) { res.status(500).json({error:err.message}); }
});

// POST /jours — ajouter un jour (admin)
app.post('/jours', async (req, res) => {
  try {
    const { date_exam, label } = req.body;
    if (!date_exam || !label)
      return res.status(400).json({error:'date_exam et label requis'});
    await pool.query(
      'INSERT INTO jours_examen(date_exam,label) VALUES($1,$2) ON CONFLICT(date_exam) DO UPDATE SET label=$2, actif=TRUE',
      [date_exam, label]);
    res.json({success:true});
  } catch(err) { res.status(500).json({error:err.message}); }
});

// DELETE /jours/:id — supprimer un jour
app.delete('/jours/:id', async (req, res) => {
  try {
    await pool.query('DELETE FROM jours_examen WHERE id=$1', [req.params.id]);
    res.json({success:true});
  } catch(err) { res.status(500).json({error:err.message}); }
});

// ─── JURYS ──────────────────────────────────────────────────────────────────

// GET /etablissements/:code/jurys
app.get('/etablissements/:code/jurys', async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT id, numero, nom FROM jury WHERE code_etab=$1 ORDER BY numero',
      [req.params.code]);
    res.json(rows);
  } catch(err) { res.status(500).json({error:err.message}); }
});

// PUT /jurys/:id — mettre à jour le nom d'un jury
app.put('/jurys/:id', async (req, res) => {
  try {
    const { nom } = req.body;
    await pool.query('UPDATE jury SET nom=$1 WHERE id=$2', [nom, req.params.id]);
    res.json({success:true});
  } catch(err) { res.status(500).json({error:err.message}); }
});

// PUT /jurys/bulk — mise à jour en masse des noms (admin)
app.put('/jurys/bulk', async (req, res) => {
  const client = await pool.connect();
  try {
    const { jurys } = req.body; // [{ id, nom }, ...]
    if (!Array.isArray(jurys)) return res.status(400).json({error:'jurys[] requis'});
    await client.query('BEGIN');
    for (const j of jurys)
      await client.query('UPDATE jury SET nom=$1 WHERE id=$2', [j.nom||null, j.id]);
    await client.query('COMMIT');
    res.json({success:true, updated:jurys.length});
  } catch(err) {
    await client.query('ROLLBACK');
    res.status(500).json({error:err.message});
  } finally { client.release(); }
});

// ─── DISPATCH ────────────────────────────────────────────────────────────────

// GET /dispatch/:code/:date/:session
app.get('/dispatch/:code/:date/:session', async (req, res) => {
  try {
    const { code, date, session } = req.params;
    const { rows } = await pool.query(`
      SELECT s.num_salle, s.capacite,
        j.numero AS jury_numero, j.nom AS jury_nom, d.id AS dispatch_id
      FROM dispatch d
      JOIN salle s ON s.id=d.salle_id
      JOIN jury j ON j.id=d.jury_id
      WHERE d.code_etab=$1 AND d.date_disp=$2 AND d.session=$3
      ORDER BY s.num_salle`,
      [code, date, session.toUpperCase()]);
    res.json(rows);
  } catch(err) { res.status(500).json({error:err.message}); }
});

// POST /dispatch/generer
app.post('/dispatch/generer', async (req, res) => {
  const client = await pool.connect();
  try {
    const { code_etab, date, session } = req.body;
    if (!code_etab || !date || !session)
      return res.status(400).json({error:'code_etab, date, session requis'});
    const sessionUp = session.toUpperCase();
    await client.query('BEGIN');
    await client.query(
      'DELETE FROM dispatch WHERE code_etab=$1 AND date_disp=$2 AND session=$3',
      [code_etab, date, sessionUp]);
    const { rows: salles } = await client.query(
      'SELECT id,capacite FROM salle WHERE code_etab=$1 ORDER BY num_salle', [code_etab]);
    const { rows: jurys } = await client.query(
      'SELECT id FROM jury WHERE code_etab=$1 ORDER BY numero', [code_etab]);
    if (!salles.length || !jurys.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({error:'Aucune salle ou jury'});
    }
    const assignments = [];
    for (const s of salles) {
      const n = Math.ceil(s.capacite/20);
      for (let i=0;i<n;i++) assignments.push(s.id);
    }
    const shuffled = shuffle(jurys.map(j=>j.id));
    const total = Math.min(assignments.length, shuffled.length);
    for (let i=0;i<total;i++)
      await client.query(
        'INSERT INTO dispatch(code_etab,date_disp,session,jury_id,salle_id) VALUES($1,$2,$3,$4,$5)',
        [code_etab, date, sessionUp, shuffled[i], assignments[i]]);
    await client.query('COMMIT');
    // Notification push à ce centre
    const sessionLabel = sessionUp === 'MATIN' ? 'Matin' : 'Après-midi';
    const dateFormatted = new Date(date).toLocaleDateString('fr-FR');
    await envoyerNotification(
      '📋 Nouveau dispatch disponible',
      `Dispatch du ${dateFormatted} — ${sessionLabel} est prêt`,
      code_etab);
    res.json({success:true, message:`${total} jurys affectés`});
  } catch(err) {
    await client.query('ROLLBACK');
    res.status(500).json({error:err.message});
  } finally { client.release(); }
});

// POST /dispatch/generer-tous
app.post('/dispatch/generer-tous', async (req, res) => {
  const client = await pool.connect();
  try {
    const { date, session } = req.body;
    if (!date || !session) return res.status(400).json({error:'date et session requis'});
    const sessionUp = session.toUpperCase();
    const { rows: etabs } = await client.query('SELECT code FROM etablissement');
    let totalAffect = 0;
    await client.query('BEGIN');
    for (const e of etabs) {
      await client.query(
        'DELETE FROM dispatch WHERE code_etab=$1 AND date_disp=$2 AND session=$3',
        [e.code, date, sessionUp]);
      const { rows: salles } = await client.query('SELECT id,capacite FROM salle WHERE code_etab=$1', [e.code]);
      const { rows: jurys }  = await client.query('SELECT id FROM jury WHERE code_etab=$1', [e.code]);
      if (!salles.length || !jurys.length) continue;
      const assignments = [];
      for (const s of salles) { const n=Math.ceil(s.capacite/20); for(let i=0;i<n;i++) assignments.push(s.id); }
      const shuffled = shuffle(jurys.map(j=>j.id));
      const count = Math.min(assignments.length, shuffled.length);
      for (let i=0;i<count;i++)
        await client.query(
          'INSERT INTO dispatch(code_etab,date_disp,session,jury_id,salle_id) VALUES($1,$2,$3,$4,$5)',
          [e.code, date, sessionUp, shuffled[i], assignments[i]]);
      totalAffect += count;
    }
    await client.query('COMMIT');
    // Notification globale à tous les centres
    const sessionLabel = sessionUp === 'MATIN' ? 'Matin' : 'Après-midi';
    const dateFormatted = new Date(date).toLocaleDateString('fr-FR');
    await envoyerNotification(
      '📋 Nouveau dispatch disponible',
      `Dispatch du ${dateFormatted} — ${sessionLabel} est prêt pour votre centre`);
    res.json({success:true, message:`${totalAffect} affectations sur ${etabs.length} centres`});
  } catch(err) {
    await client.query('ROLLBACK');
    res.status(500).json({error:err.message});
  } finally { client.release(); }
});

// ─── VÉRIFICATION ────────────────────────────────────────────────────────────

// POST /verifier — vérification en ligne
app.post('/verifier', async (req, res) => {
  try {
    const { qr_salle, qr_jury, date, session } = req.body;
    if (!qr_salle || !qr_jury || !date || !session)
      return res.status(400).json({error:'Paramètres manquants'});
    const partsSalle = qr_salle.split(':');
    const partsJury  = qr_jury.split(':');
    if (partsSalle[0]!=='SALLE' || partsJury[0]!=='JURY')
      return res.json({conforme:false, message:'Format QR invalide'});
    const codeEtabSalle = parseInt(partsSalle[1]);
    const numSalle      = partsSalle[2];
    const codeEtabJury  = parseInt(partsJury[1]);
    const numeroJury    = parseInt(partsJury[2]);
    const sessionUp     = session.toUpperCase();
    if (codeEtabSalle !== codeEtabJury)
      return res.json({conforme:false, message:'❌ Salle et jury ne sont pas du même établissement'});
    const { rows: salleRows } = await pool.query(
      'SELECT id,num_salle,capacite FROM salle WHERE code_etab=$1 AND num_salle=$2',
      [codeEtabSalle, numSalle]);
    if (!salleRows.length) return res.json({conforme:false, message:'❌ Salle non trouvée'});
    const salle = salleRows[0];
    const { rows: juryRows } = await pool.query(
      'SELECT id,numero,nom FROM jury WHERE code_etab=$1 AND numero=$2',
      [codeEtabJury, numeroJury]);
    if (!juryRows.length) return res.json({conforme:false, message:'❌ Jury non trouvé'});
    const jury = juryRows[0];
    const { rows: dispRows } = await pool.query(
      'SELECT id FROM dispatch WHERE code_etab=$1 AND date_disp=$2 AND session=$3 AND jury_id=$4 AND salle_id=$5',
      [codeEtabSalle, date, sessionUp, jury.id, salle.id]);
    const conforme = dispRows.length > 0;
    let salleAttendue = null;
    if (!conforme) {
      const { rows: att } = await pool.query(
        'SELECT s.num_salle FROM dispatch d JOIN salle s ON s.id=d.salle_id WHERE d.code_etab=$1 AND d.date_disp=$2 AND d.session=$3 AND d.jury_id=$4',
        [codeEtabSalle, date, sessionUp, jury.id]);
      if (att.length) salleAttendue = att[0].num_salle;
    }
    await pool.query(
      'INSERT INTO verification(code_etab,date_verif,session,salle_id,jury_id,conforme,synced) VALUES($1,$2,$3,$4,$5,$6,TRUE) ON CONFLICT DO NOTHING',
      [codeEtabSalle, date, sessionUp, salle.id, jury.id, conforme]);
    res.json({
      conforme,
      message: conforme
        ? `✅ Jury ${jury.numero}${jury.nom?' — '+jury.nom:''} est bien en Salle ${salle.num_salle}`
        : `❌ Jury ${jury.numero} ne devrait PAS être en Salle ${salle.num_salle}${salleAttendue?'. Salle attendue : '+salleAttendue:''}`,
      jury_numero: jury.numero, jury_nom: jury.nom,
      num_salle: salle.num_salle, salle_attendue: salleAttendue
    });
  } catch(err) { res.status(500).json({error:err.message}); }
});

// POST /offline/sync — synchronisation des vérifications hors-ligne
app.post('/offline/sync', async (req, res) => {
  const client = await pool.connect();
  try {
    const { verifications } = req.body; // [{ qr_salle, qr_jury, date, session, heure_locale }]
    if (!Array.isArray(verifications))
      return res.status(400).json({error:'verifications[] requis'});
    let synced = 0, errors = 0;
    await client.query('BEGIN');
    for (const v of verifications) {
      try {
        const partsSalle = v.qr_salle.split(':');
        const partsJury  = v.qr_jury.split(':');
        const codeEtab   = parseInt(partsSalle[1]);
        const numSalle   = partsSalle[2];
        const numeroJury = parseInt(partsJury[2]);
        const sessionUp  = v.session.toUpperCase();
        const { rows: salleRows } = await client.query(
          'SELECT id FROM salle WHERE code_etab=$1 AND num_salle=$2', [codeEtab, numSalle]);
        const { rows: juryRows } = await client.query(
          'SELECT id FROM jury WHERE code_etab=$1 AND numero=$2', [codeEtab, numeroJury]);
        if (!salleRows.length || !juryRows.length) { errors++; continue; }
        const { rows: dispRows } = await client.query(
          'SELECT id FROM dispatch WHERE code_etab=$1 AND date_disp=$2 AND session=$3 AND jury_id=$4 AND salle_id=$5',
          [codeEtab, v.date, sessionUp, juryRows[0].id, salleRows[0].id]);
        const conforme = dispRows.length > 0;
        await client.query(
          `INSERT INTO verification(code_etab,date_verif,session,salle_id,jury_id,conforme,synced,heure_verif)
           VALUES($1,$2,$3,$4,$5,$6,TRUE,$7) ON CONFLICT DO NOTHING`,
          [codeEtab, v.date, sessionUp, salleRows[0].id, juryRows[0].id, conforme,
           v.heure_locale || new Date().toISOString()]);
        synced++;
      } catch(e) { errors++; }
    }
    await client.query('COMMIT');
    res.json({success:true, synced, errors});
  } catch(err) {
    await client.query('ROLLBACK');
    res.status(500).json({error:err.message});
  } finally { client.release(); }
});

// ─── NOTIFICATIONS ───────────────────────────────────────────────────────────

// POST /notifications/enregistrer — enregistre le token FCM d'un téléphone
app.post('/notifications/enregistrer', async (req, res) => {
  try {
    const { code_etab, token } = req.body;
    if (!code_etab || !token)
      return res.status(400).json({error:'code_etab et token requis'});
    await pool.query(
      'INSERT INTO fcm_tokens(code_etab,token) VALUES($1,$2) ON CONFLICT(code_etab,token) DO NOTHING',
      [code_etab, token]);
    res.json({success:true});
  } catch(err) { res.status(500).json({error:err.message}); }
});

// ─── STATS VÉRIFICATIONS ─────────────────────────────────────────────────────
app.get('/verifications/stats/:date/:session', async (req, res) => {
  try {
    const { date, session } = req.params;
    const { rows } = await pool.query(`
      WITH dernieres AS (
        SELECT DISTINCT ON (code_etab,jury_id) code_etab,jury_id,conforme
        FROM verification WHERE date_verif=$1 AND session=$2
        ORDER BY code_etab,jury_id,heure_verif DESC)
      SELECT e.nom, e.code,
        COUNT(d.jury_id)::int AS total_verif,
        SUM(CASE WHEN d.conforme THEN 1 ELSE 0 END)::int AS conformes,
        SUM(CASE WHEN NOT d.conforme THEN 1 ELSE 0 END)::int AS non_conformes,
        (SELECT COUNT(*) FROM jury j WHERE j.code_etab=e.code)::int AS total_jurys
      FROM etablissement e
      LEFT JOIN dernieres d ON d.code_etab=e.code
      GROUP BY e.code,e.nom ORDER BY e.nom`,
      [date, session.toUpperCase()]);
    res.json(rows);
  } catch(err) { res.status(500).json({error:err.message}); }
});

app.get('/verifications/:code/:date/:session', async (req, res) => {
  try {
    const { code, date, session } = req.params;
    const { rows } = await pool.query(`
      SELECT s.num_salle, j.numero AS jury_numero, j.nom AS jury_nom,
             v.conforme, v.heure_verif
      FROM verification v
      JOIN salle s ON s.id=v.salle_id JOIN jury j ON j.id=v.jury_id
      WHERE v.code_etab=$1 AND v.date_verif=$2 AND v.session=$3
      ORDER BY s.num_salle, j.numero`,
      [code, date, session.toUpperCase()]);
    res.json(rows);
  } catch(err) { res.status(500).json({error:err.message}); }
});

// ─── QR CODES ────────────────────────────────────────────────────────────────
app.get('/qrcodes/:code', async (req, res) => {
  try {
    const code = parseInt(req.params.code);
    const { rows: etabRows } = await pool.query(
      'SELECT code,nom FROM etablissement WHERE code=$1', [code]);
    if (!etabRows.length) return res.status(404).json({error:'Non trouvé'});
    const { rows: salles } = await pool.query(
      'SELECT num_salle FROM salle WHERE code_etab=$1 ORDER BY num_salle', [code]);
    const { rows: jurys } = await pool.query(
      'SELECT numero,nom FROM jury WHERE code_etab=$1 ORDER BY numero', [code]);
    res.json({
      etablissement: etabRows[0],
      qr_chef:   `CHEF:${code}`,
      qr_salles: salles.map(s=>({num_salle:s.num_salle, qr:`SALLE:${code}:${s.num_salle}`})),
      qr_jurys:  jurys.map(j=>({numero:j.numero, nom:j.nom, qr:`JURY:${code}:${j.numero}`}))
    });
  } catch(err) { res.status(500).json({error:err.message}); }
});

// ─── DÉMARRAGE ───────────────────────────────────────────────────────────────
initDB().then(() => {
  app.listen(PORT, () => {
    console.log(`\n✅ Serveur BAC v2.0 sur port ${PORT}`);
    console.log(`   Admin : http://localhost:${PORT}/admin.html\n`);
  });
}).catch(err => { console.error('Erreur DB:', err); process.exit(1); });

// ─── SIGNALEMENTS ─────────────────────────────────────────────────────────────

// POST /signalements
app.post('/signalements', async (req, res) => {
  try {
    const { code_etab, session, description, photo_url } = req.body;
    if (!code_etab || !description)
      return res.status(400).json({ error: 'code_etab et description requis' });
    const { rows } = await pool.query(
      `INSERT INTO signalement(code_etab, session, description, photo_url)
       VALUES($1,$2,$3,$4) RETURNING id, heure_signal`,
      [code_etab, session || null, description, photo_url || null]
    );
    res.json({ success: true, id: rows[0].id, heure: rows[0].heure_signal });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// GET /signalements — tous (admin)
app.get('/signalements', async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT s.id, e.nom AS etab_nom, s.code_etab,
             TO_CHAR(s.date_signal,'YYYY-MM-DD') AS date_signal,
             s.session, s.description, s.photo_url,
             s.heure_signal
      FROM signalement s
      JOIN etablissement e ON e.code=s.code_etab
      ORDER BY s.heure_signal DESC`);
    res.json(rows);
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// GET /signalements/:code — signalements d'un centre
app.get('/signalements/:code', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, TO_CHAR(date_signal,'YYYY-MM-DD') AS date_signal,
              session, description, photo_url, heure_signal
       FROM signalement WHERE code_etab=$1 ORDER BY heure_signal DESC`,
      [req.params.code]);
    res.json(rows);
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// DELETE /signalements/:id
app.delete('/signalements/:id', async (req, res) => {
  try {
    await pool.query('DELETE FROM signalement WHERE id=$1', [req.params.id]);
    res.json({ success: true });
  } catch(err) { res.status(500).json({ error: err.message }); }
});
