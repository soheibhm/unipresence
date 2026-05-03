const router = require('express').Router();
const { v4: uuidv4 } = require('uuid');
const db = require('../db');
const { auth, role } = require('../middleware/auth');

const isProf = [auth, role('professeur', 'admin')];

// ── GET /api/prof/dashboard ───────────────────────────────────
router.get('/dashboard', isProf, async (req, res) => {
  const profId = req.user.professeur_id;
  try {
    const [[stats]] = await db.execute(`
      SELECT
        COUNT(DISTINCT s.id)                                                  AS total_seances,
        COUNT(DISTINCT s.id) FILTER (WHERE s.statut = 'active')              AS seances_actives,
        COUNT(DISTINCT m.id)                                                  AS total_modules,
        ROUND(AVG(CASE WHEN p.statut='present' THEN 100.0 ELSE 0 END), 1)   AS taux_global,
        COUNT(DISTINCT j.id) FILTER (WHERE j.statut='en_attente')            AS justif_attente
      FROM professeurs pr
      JOIN modules m ON m.professeur_id = pr.id
      JOIN seances s ON s.module_id = m.id
      LEFT JOIN presences p ON p.seance_id = s.id
      LEFT JOIN justifications j ON j.seance_id = s.id
      WHERE pr.id = ?
    `, [profId]).catch(() => [[{}]]);  // fallback if FILTER not supported

    // Fallback for MySQL < 8.0.29 (no FILTER clause)
    const [[stats2]] = await db.execute(`
      SELECT
        (SELECT COUNT(*) FROM seances s JOIN modules m ON m.id=s.module_id WHERE m.professeur_id=?) AS total_seances,
        (SELECT COUNT(*) FROM seances s JOIN modules m ON m.id=s.module_id WHERE m.professeur_id=? AND s.statut='active') AS seances_actives,
        (SELECT COUNT(DISTINCT m.id) FROM modules m WHERE m.professeur_id=?) AS total_modules,
        (SELECT ROUND(AVG(CASE WHEN p.statut='present' THEN 100.0 ELSE 0 END),1)
         FROM presences p JOIN seances s ON s.id=p.seance_id JOIN modules m ON m.id=s.module_id
         WHERE m.professeur_id=?) AS taux_global,
        (SELECT COUNT(*) FROM justifications j JOIN seances s ON s.id=j.seance_id JOIN modules m ON m.id=s.module_id
         WHERE m.professeur_id=? AND j.statut='en_attente') AS justif_attente
    `, [profId, profId, profId, profId, profId]);

    const [prochaines] = await db.execute(`
      SELECT s.*, m.intitule AS module, g.nom AS groupe
      FROM seances s
      JOIN modules m ON m.id = s.module_id
      JOIN groupes g ON g.id = s.groupe_id
      WHERE m.professeur_id = ? AND s.date_seance >= CURDATE()
      ORDER BY s.date_seance, s.heure_debut LIMIT 5
    `, [profId]);

    res.json({ stats: stats2, prochaines });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erreur serveur.' });
  }
});

// ── GET /api/prof/modules ─────────────────────────────────────
router.get('/modules', isProf, async (req, res) => {
  try {
    const [rows] = await db.execute(`
      SELECT m.*, n.libelle AS niveau, s.libelle AS semestre,
             (SELECT COUNT(*) FROM seances WHERE module_id=m.id) AS nb_seances,
             (SELECT ROUND(AVG(CASE WHEN p.statut='present' THEN 100.0 ELSE 0 END),1)
              FROM presences p JOIN seances s2 ON s2.id=p.seance_id WHERE s2.module_id=m.id) AS taux
      FROM modules m
      JOIN niveaux n ON n.id = m.niveau_id
      JOIN semestres s ON s.id = m.semestre_id
      WHERE m.professeur_id = ?
      ORDER BY m.code
    `, [req.user.professeur_id]);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: 'Erreur serveur.' });
  }
});

// ── GET /api/prof/seances ─────────────────────────────────────
router.get('/seances', isProf, async (req, res) => {
  const { module_id, statut } = req.query;
  let sql = `
    SELECT s.*, m.intitule AS module, m.code, g.nom AS groupe,
           (SELECT COUNT(*) FROM presences p WHERE p.seance_id=s.id AND p.statut='present') AS nb_presents,
           (SELECT COUNT(*) FROM etudiant_groupes eg WHERE eg.groupe_id=s.groupe_id) AS nb_inscrits
    FROM seances s
    JOIN modules m ON m.id = s.module_id
    JOIN groupes g ON g.id = s.groupe_id
    WHERE m.professeur_id = ?
  `;
  const params = [req.user.professeur_id];
  if (module_id) { sql += ' AND m.id = ?'; params.push(module_id); }
  if (statut)    { sql += ' AND s.statut = ?'; params.push(statut); }
  sql += ' ORDER BY s.date_seance DESC, s.heure_debut DESC';
  try {
    const [rows] = await db.execute(sql, params);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: 'Erreur serveur.' });
  }
});

// ── POST /api/prof/seances ────────────────────────────────────
router.post('/seances', isProf, async (req, res) => {
  const { module_id, groupe_id, type, date_seance, heure_debut, heure_fin, salle } = req.body;
  if (!module_id || !groupe_id || !type || !date_seance || !heure_debut || !heure_fin)
    return res.status(400).json({ error: 'Champs obligatoires manquants.' });
  try {
    // Verify module belongs to this prof
    const [m] = await db.execute(
      'SELECT id FROM modules WHERE id=? AND professeur_id=?',
      [module_id, req.user.professeur_id]
    );
    if (!m.length) return res.status(403).json({ error: 'Module non autorisé.' });

    const [r] = await db.execute(
      'INSERT INTO seances (module_id, groupe_id, type, date_seance, heure_debut, heure_fin, salle) VALUES (?,?,?,?,?,?,?)',
      [module_id, groupe_id, type, date_seance, heure_debut, heure_fin, salle || null]
    );
    res.status(201).json({ message: 'Séance créée.', id: r.insertId });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erreur serveur.' });
  }
});

// ── POST /api/prof/seances/:id/qr ────────────────────────────
// Generate (or refresh) QR token for a session
router.post('/seances/:id/qr', isProf, async (req, res) => {
  const seanceId = req.params.id;
  const validityMin = parseInt(process.env.QR_VALIDITY_MINUTES) || 15;
  try {
    // Verify ownership
    const [rows] = await db.execute(`
      SELECT s.* FROM seances s
      JOIN modules m ON m.id=s.module_id
      WHERE s.id=? AND m.professeur_id=?
    `, [seanceId, req.user.professeur_id]);
    if (!rows.length) return res.status(403).json({ error: 'Séance non autorisée.' });

    const token   = uuidv4().replace(/-/g,'');
    const expires = new Date(Date.now() + validityMin * 60 * 1000);

    await db.execute(
      'UPDATE seances SET qr_token=?, qr_expires_at=?, statut="active" WHERE id=?',
      [token, expires, seanceId]
    );

    res.json({ token, expires_at: expires, validity_minutes: validityMin });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erreur serveur.' });
  }
});

// ── GET /api/prof/seances/:id/presences ──────────────────────
router.get('/seances/:id/presences', isProf, async (req, res) => {
  try {
    const [rows] = await db.execute(`
      SELECT e.id AS etudiant_id, e.matricule,
             CONCAT(u.nom,' ',u.prenom) AS nom_complet,
             COALESCE(p.statut,'absent') AS statut,
             p.scanned_at
      FROM etudiant_groupes eg
      JOIN etudiants e ON e.id = eg.etudiant_id
      JOIN users u ON u.id = e.user_id
      LEFT JOIN presences p ON p.etudiant_id=e.id AND p.seance_id=?
      JOIN seances s ON s.id=?
      WHERE eg.groupe_id = s.groupe_id
      ORDER BY u.nom, u.prenom
    `, [req.params.id, req.params.id]);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: 'Erreur serveur.' });
  }
});

// ── PUT /api/prof/seances/:id/presences ──────────────────────
// Manual override of presence status
router.put('/seances/:id/presences', isProf, async (req, res) => {
  const { etudiant_id, statut } = req.body;
  if (!['present','absent','justifie'].includes(statut))
    return res.status(400).json({ error: 'Statut invalide.' });
  try {
    await db.execute(`
      INSERT INTO presences (seance_id, etudiant_id, statut)
      VALUES (?,?,?)
      ON DUPLICATE KEY UPDATE statut=VALUES(statut)
    `, [req.params.id, etudiant_id, statut]);
    res.json({ message: 'Présence mise à jour.' });
  } catch (err) {
    res.status(500).json({ error: 'Erreur serveur.' });
  }
});

// ── GET /api/prof/justifications ─────────────────────────────
router.get('/justifications', isProf, async (req, res) => {
  try {
    const [rows] = await db.execute(`
      SELECT j.*, CONCAT(ue.nom,' ',ue.prenom) AS etudiant_nom, ue.email,
             m.intitule AS module, s.date_seance, s.type AS seance_type
      FROM justifications j
      JOIN etudiants e ON e.id=j.etudiant_id
      JOIN users ue ON ue.id=e.user_id
      JOIN seances s ON s.id=j.seance_id
      JOIN modules m ON m.id=s.module_id
      WHERE m.professeur_id=?
      ORDER BY j.created_at DESC
    `, [req.user.professeur_id]);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: 'Erreur serveur.' });
  }
});

// ── PUT /api/prof/justifications/:id ─────────────────────────
router.put('/justifications/:id', isProf, async (req, res) => {
  const { statut, commentaire } = req.body;
  if (!['acceptee','refusee'].includes(statut))
    return res.status(400).json({ error: 'Statut invalide.' });
  try {
    await db.execute(`
      UPDATE justifications SET statut=?, commentaire=?, traite_at=NOW(), traite_par=?
      WHERE id=?
    `, [statut, commentaire || null, req.user.id, req.params.id]);

    // If accepted, update presence to 'justifie'
    if (statut === 'acceptee') {
      const [j] = await db.execute('SELECT seance_id, etudiant_id FROM justifications WHERE id=?', [req.params.id]);
      if (j.length) {
        await db.execute(`
          INSERT INTO presences (seance_id, etudiant_id, statut) VALUES (?,?,'justifie')
          ON DUPLICATE KEY UPDATE statut='justifie'
        `, [j[0].seance_id, j[0].etudiant_id]);
      }

      // Notify student
      const [jdata] = await db.execute(`
        SELECT e.user_id, m.intitule, s.date_seance FROM justifications j
        JOIN etudiants e ON e.id=j.etudiant_id
        JOIN seances s ON s.id=j.seance_id JOIN modules m ON m.id=s.module_id
        WHERE j.id=?`, [req.params.id]);
      if (jdata.length) {
        await db.execute(
          'INSERT INTO notifications (user_id, titre, message, type) VALUES (?,?,?,?)',
          [jdata[0].user_id,
           'Justification acceptée',
           `Votre justification pour ${jdata[0].intitule} du ${new Date(jdata[0].date_seance).toLocaleDateString('fr-FR')} a été acceptée.`,
           'success']
        );
      }
    }

    res.json({ message: `Justification ${statut}.` });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erreur serveur.' });
  }
});

// ── GET /api/prof/groupes ─────────────────────────────────────
router.get('/groupes', isProf, async (req, res) => {
  try {
    const [rows] = await db.execute(`
      SELECT g.*, n.libelle AS niveau,
             COUNT(eg.etudiant_id) AS nb_etudiants
      FROM groupes g
      JOIN niveaux n ON n.id=g.niveau_id
      LEFT JOIN etudiant_groupes eg ON eg.groupe_id=g.id
      GROUP BY g.id ORDER BY g.nom
    `);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: 'Erreur serveur.' });
  }
});

// ── GET /api/prof/notifications ──────────────────────────────
router.get('/notifications', isProf, async (req, res) => {
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

// ── PUT /api/prof/notifications/read ─────────────────────────
router.put('/notifications/read', isProf, async (req, res) => {
  await db.execute('UPDATE notifications SET lu=1 WHERE user_id=?', [req.user.id]);
  res.json({ message: 'Notifications marquées comme lues.' });
});

module.exports = router;