const router = require('express').Router();
const db     = require('../db');
const { auth, role } = require('../middleware/auth');

const isStudent = [auth, role('etudiant')];

// ── GET /api/etudiant/dashboard ───────────────────────────────
router.get('/dashboard', isStudent, async (req, res) => {
  const eid = req.user.etudiant_id;
  try {
    const [[stats]] = await db.execute(`
      SELECT
        COUNT(*) AS total_seances,
        SUM(CASE WHEN p.statut='present'  THEN 1 ELSE 0 END) AS presents,
        SUM(CASE WHEN p.statut='absent'   THEN 1 ELSE 0 END) AS absents,
        SUM(CASE WHEN p.statut='justifie' THEN 1 ELSE 0 END) AS justifies,
        ROUND(SUM(CASE WHEN p.statut='present' THEN 100.0 ELSE 0 END) / COUNT(*), 1) AS taux_global
      FROM presences p
      WHERE p.etudiant_id = ?
    `, [eid]);

    const [[justif_stats]] = await db.execute(`
      SELECT
        SUM(CASE WHEN statut='en_attente' THEN 1 ELSE 0 END) AS en_attente,
        SUM(CASE WHEN statut='acceptee'   THEN 1 ELSE 0 END) AS acceptees,
        SUM(CASE WHEN statut='refusee'    THEN 1 ELSE 0 END) AS refusees
      FROM justifications WHERE etudiant_id=?
    `, [eid]);

    const [prochaines] = await db.execute(`
      SELECT s.date_seance, s.heure_debut, s.heure_fin, s.salle, s.type,
             m.intitule AS module, g.nom AS groupe
      FROM seances s
      JOIN modules m ON m.id=s.module_id
      JOIN groupes g ON g.id=s.groupe_id
      JOIN etudiant_groupes eg ON eg.groupe_id=s.groupe_id AND eg.etudiant_id=?
      WHERE s.date_seance >= CURDATE() AND s.statut != 'terminee'
      ORDER BY s.date_seance, s.heure_debut LIMIT 5
    `, [eid]);

    const [modules_taux] = await db.execute(`
      SELECT m.intitule AS module, m.code,
             COUNT(p.id) AS total,
             SUM(CASE WHEN p.statut='present' THEN 1 ELSE 0 END) AS presents,
             ROUND(SUM(CASE WHEN p.statut='present' THEN 100.0 ELSE 0 END)/NULLIF(COUNT(p.id),0),1) AS taux
      FROM modules m
      JOIN seances s ON s.module_id=m.id
      JOIN presences p ON p.seance_id=s.id AND p.etudiant_id=?
      GROUP BY m.id ORDER BY m.code
    `, [eid]);

    res.json({ stats, justif_stats, prochaines, modules_taux });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erreur serveur.' });
  }
});

// ── POST /api/etudiant/scan ───────────────────────────────────
// Student scans QR token to register attendance
router.post('/scan', isStudent, async (req, res) => {
  const { token } = req.body;
  if (!token) return res.status(400).json({ error: 'Token QR manquant.' });

  try {
    const [rows] = await db.execute(`
      SELECT s.*, m.intitule AS module, g.nom AS groupe
      FROM seances s
      JOIN modules m ON m.id=s.module_id
      JOIN groupes g ON g.id=s.groupe_id
      WHERE s.qr_token=? AND s.statut='active' AND s.qr_expires_at > NOW()
    `, [token]);

    if (!rows.length)
      return res.status(404).json({ error: 'QR Code invalide ou expiré.' });

    const seance = rows[0];
    const eid    = req.user.etudiant_id;

    // Check student belongs to this group
    const [grp] = await db.execute(
      'SELECT 1 FROM etudiant_groupes WHERE etudiant_id=? AND groupe_id=?',
      [eid, seance.groupe_id]
    );
    if (!grp.length)
      return res.status(403).json({ error: "Vous n'appartenez pas à ce groupe." });

    // Upsert presence
    const [result] = await db.execute(`
      INSERT INTO presences (seance_id, etudiant_id, statut)
      VALUES (?,?,'present')
      ON DUPLICATE KEY UPDATE statut='present', scanned_at=NOW()
    `, [seance.id, eid]);

    res.json({
      message:  'Présence enregistrée avec succès !',
      module:   seance.module,
      groupe:   seance.groupe,
      heure:    new Date().toLocaleTimeString('fr-FR', { hour:'2-digit', minute:'2-digit' }),
      seance_id: seance.id
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erreur serveur.' });
  }
});

// ── GET /api/etudiant/historique ──────────────────────────────
router.get('/historique', isStudent, async (req, res) => {
  const { module_id, statut } = req.query;
  let sql = `
    SELECT p.statut, p.scanned_at,
           s.date_seance, s.heure_debut, s.type AS seance_type, s.salle,
           m.intitule AS module, m.code, g.nom AS groupe
    FROM presences p
    JOIN seances s ON s.id=p.seance_id
    JOIN modules m ON m.id=s.module_id
    JOIN groupes g ON g.id=s.groupe_id
    WHERE p.etudiant_id=?
  `;
  const params = [req.user.etudiant_id];
  if (module_id) { sql += ' AND m.id=?'; params.push(module_id); }
  if (statut)    { sql += ' AND p.statut=?'; params.push(statut); }
  sql += ' ORDER BY s.date_seance DESC, s.heure_debut DESC';
  try {
    const [rows] = await db.execute(sql, params);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: 'Erreur serveur.' });
  }
});

// ── GET /api/etudiant/justifications ─────────────────────────
router.get('/justifications', isStudent, async (req, res) => {
  try {
    const [rows] = await db.execute(`
      SELECT j.*, s.date_seance, s.type AS seance_type, m.intitule AS module,
             CONCAT(u.nom,' ',u.prenom) AS traite_par_nom
      FROM justifications j
      JOIN seances s ON s.id=j.seance_id
      JOIN modules m ON m.id=s.module_id
      LEFT JOIN users u ON u.id=j.traite_par
      WHERE j.etudiant_id=?
      ORDER BY j.created_at DESC
    `, [req.user.etudiant_id]);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: 'Erreur serveur.' });
  }
});

// ── POST /api/etudiant/justifications ────────────────────────
router.post('/justifications', isStudent, async (req, res) => {
  const { seance_id, motif, description, fichier_url } = req.body;
  if (!seance_id || !motif)
    return res.status(400).json({ error: 'Séance et motif requis.' });
  try {
    // Check student was absent for this session
    const [p] = await db.execute(
      'SELECT statut FROM presences WHERE seance_id=? AND etudiant_id=?',
      [seance_id, req.user.etudiant_id]
    );
    if (p.length && p[0].statut === 'present')
      return res.status(400).json({ error: 'Vous étiez présent à cette séance.' });

    // Check no existing pending justification
    const [exists] = await db.execute(
      'SELECT id FROM justifications WHERE seance_id=? AND etudiant_id=? AND statut="en_attente"',
      [seance_id, req.user.etudiant_id]
    );
    if (exists.length)
      return res.status(409).json({ error: 'Une justification est déjà en attente.' });

    const [r] = await db.execute(
      'INSERT INTO justifications (etudiant_id, seance_id, motif, description, fichier_url) VALUES (?,?,?,?,?)',
      [req.user.etudiant_id, seance_id, motif, description || null, fichier_url || null]
    );

    // Notify professor
    const [seanceData] = await db.execute(`
      SELECT m.professeur_id, p.user_id AS prof_user_id, m.intitule, s.date_seance
      FROM seances s JOIN modules m ON m.id=s.module_id
      JOIN professeurs p ON p.id=m.professeur_id
      WHERE s.id=?`, [seance_id]);
    if (seanceData.length) {
      await db.execute(
        'INSERT INTO notifications (user_id, titre, message, type) VALUES (?,?,?,?)',
        [seanceData[0].prof_user_id,
         'Nouvelle justification',
         `${req.user.prenom} ${req.user.nom} a soumis une justification pour ${seanceData[0].intitule}.`,
         'info']
      );
    }

    res.status(201).json({ message: 'Justification soumise.', id: r.insertId });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erreur serveur.' });
  }
});

// ── GET /api/etudiant/absences ────────────────────────────────
// Returns sessions where student was absent (for justification form)
router.get('/absences', isStudent, async (req, res) => {
  try {
    const [rows] = await db.execute(`
      SELECT p.seance_id, p.statut, s.date_seance, s.type AS seance_type,
             m.intitule AS module,
             (SELECT id FROM justifications j WHERE j.seance_id=s.id AND j.etudiant_id=p.etudiant_id LIMIT 1) AS justif_id
      FROM presences p
      JOIN seances s ON s.id=p.seance_id
      JOIN modules m ON m.id=s.module_id
      WHERE p.etudiant_id=? AND p.statut='absent'
      ORDER BY s.date_seance DESC
    `, [req.user.etudiant_id]);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: 'Erreur serveur.' });
  }
});

// ── GET /api/etudiant/notifications ──────────────────────────
router.get('/notifications', isStudent, async (req, res) => {
  try {
    const [rows] = await db.execute(
      'SELECT * FROM notifications WHERE user_id=? ORDER BY created_at DESC LIMIT 20',
      [req.user.id]
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: 'Erreur serveur.' });
  }
});

// ── PUT /api/etudiant/notifications/read ─────────────────────
router.put('/notifications/read', isStudent, async (req, res) => {
  await db.execute('UPDATE notifications SET lu=1 WHERE user_id=?', [req.user.id]);
  res.json({ message: 'Notifications marquées comme lues.' });
});

module.exports = router;
