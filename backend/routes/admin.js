const router = require('express').Router();
const bcrypt = require('bcryptjs');
const db     = require('../db');
const { auth, role } = require('../middleware/auth');
const { sendApprovalEmail } = require('../utils/mailer');

const isAdmin = [auth, role('admin')];

// ── GET /api/admin/dashboard ──────────────────────────────────
router.get('/dashboard', isAdmin, async (req, res) => {
  try {
    const [[totals]] = await db.execute(`
      SELECT
        (SELECT COUNT(*) FROM users WHERE role='etudiant' AND status='actif') AS total_etudiants,
        (SELECT COUNT(*) FROM users WHERE role='professeur' AND status='actif') AS total_profs,
        (SELECT COUNT(*) FROM seances) AS total_seances,
        (SELECT COUNT(*) FROM presences WHERE statut='present') AS total_presences,
        (SELECT COUNT(*) FROM justifications WHERE statut='en_attente') AS justif_attente,
        (SELECT COUNT(*) FROM users WHERE status='en_attente') AS users_attente,
        ROUND(
          (SELECT COUNT(*) FROM presences WHERE statut='present') * 100.0 /
          NULLIF((SELECT COUNT(*) FROM presences),0), 1
        ) AS taux_global
    `);
    const [recent_users] = await db.execute(`
      SELECT id, nom, prenom, email, role, status, created_at
      FROM users ORDER BY created_at DESC LIMIT 10
    `);
    const [modules_stats] = await db.execute(`
      SELECT m.code, m.intitule, m.coefficient, m.credits,
             COUNT(DISTINCT s.id) AS nb_seances,
             ROUND(AVG(CASE WHEN p.statut='present' THEN 100.0 ELSE 0 END),1) AS taux
      FROM modules m
      LEFT JOIN seances s ON s.module_id = m.id
      LEFT JOIN presences p ON p.seance_id = s.id
      GROUP BY m.id
    `);
    res.json({ totals, recent_users, modules_stats });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erreur serveur.' });
  }
});

// ── GET /api/admin/users ──────────────────────────────────────
router.get('/users', isAdmin, async (req, res) => {
  const { role: r, status, search } = req.query;
  let sql = 'SELECT id, nom, prenom, email, role, status, telephone, created_at, last_login, email_verified FROM users WHERE 1=1';
  const params = [];
  if (r)      { sql += ' AND role = ?';   params.push(r); }
  if (status) { sql += ' AND status = ?'; params.push(status); }
  if (search) {
    sql += ' AND (nom LIKE ? OR prenom LIKE ? OR email LIKE ?)';
    params.push(`%${search}%`, `%${search}%`, `%${search}%`);
  }
  sql += ' ORDER BY created_at DESC';
  try {
    const [rows] = await db.execute(sql, params);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: 'Erreur serveur.' });
  }
});

// ── GET /api/admin/users/pending ──────────────────────────────
// Users that verified email but need admin approval
router.get('/users/pending', isAdmin, async (req, res) => {
  try {
    const [rows] = await db.execute(`
      SELECT u.id, u.nom, u.prenom, u.email, u.role, u.status, u.created_at,
             e.matricule, e.niveau_id, n.libelle AS niveau
      FROM users u
      LEFT JOIN etudiants e ON e.user_id = u.id
      LEFT JOIN niveaux n ON n.id = e.niveau_id
      WHERE u.status = 'en_attente' AND u.email_verified = 1
      ORDER BY u.created_at ASC
    `);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: 'Erreur serveur.' });
  }
});

// ── POST /api/admin/users/:id/approve ────────────────────────
// Approve user + optionally assign groups (for students)
router.post('/users/:id/approve', isAdmin, async (req, res) => {
  const { groupe_ids } = req.body; // array of group IDs for students
  try {
    const [rows] = await db.execute(
      'SELECT u.*, e.id AS etudiant_id FROM users u LEFT JOIN etudiants e ON e.user_id = u.id WHERE u.id=?',
      [req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Utilisateur introuvable.' });

    const user = rows[0];
    await db.execute('UPDATE users SET status="actif" WHERE id=?', [user.id]);

    // Assign groups to student
    if (user.role === 'etudiant' && user.etudiant_id && groupe_ids && groupe_ids.length) {
      for (const gid of groupe_ids) {
        await db.execute(
          'INSERT IGNORE INTO etudiant_groupes (etudiant_id, groupe_id) VALUES (?,?)',
          [user.etudiant_id, gid]
        );
      }
    }

    // Notify by email
    sendApprovalEmail({ nom: user.nom, prenom: user.prenom, email: user.email, role: user.role })
      .catch(err => console.error('⚠️  Approval email failed:', err.message));

    // In-app notification
    await db.execute(
      'INSERT INTO notifications (user_id, titre, message, type) VALUES (?,?,?,?)',
      [user.id, 'Compte approuvé', 'Votre compte a été approuvé. Bienvenue sur UniPresence !', 'success']
    );

    res.json({ message: 'Utilisateur approuvé avec succès.' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erreur serveur.' });
  }
});

// ── POST /api/admin/users/:id/reject ─────────────────────────
router.post('/users/:id/reject', isAdmin, async (req, res) => {
  try {
    await db.execute('UPDATE users SET status="inactif" WHERE id=?', [req.params.id]);
    res.json({ message: 'Utilisateur rejeté.' });
  } catch (err) {
    res.status(500).json({ error: 'Erreur serveur.' });
  }
});

// ── POST /api/admin/users ─────────────────────────────────────
router.post('/users', isAdmin, async (req, res) => {
  const { nom, prenom, email, password, role: userRole, matricule, niveau_id, grade, specialite } = req.body;
  if (!nom || !prenom || !email || !password || !userRole)
    return res.status(400).json({ error: 'Champs obligatoires manquants.' });
  try {
    const [exist] = await db.execute('SELECT id FROM users WHERE email=?', [email]);
    if (exist.length) return res.status(409).json({ error: 'Email déjà utilisé.' });

    const hash = await bcrypt.hash(password, 10);
    const [r] = await db.execute(
      'INSERT INTO users (nom, prenom, email, password_hash, role, status, email_verified) VALUES (?,?,?,?,?,?,1)',
      [nom, prenom, email, hash, userRole, 'actif']
    );
    const uid = r.insertId;

    if (userRole === 'etudiant' && matricule && niveau_id) {
      await db.execute('INSERT INTO etudiants (user_id, matricule, niveau_id) VALUES (?,?,?)', [uid, matricule, niveau_id]);
    } else if (userRole === 'professeur') {
      await db.execute('INSERT INTO professeurs (user_id, grade, specialite) VALUES (?,?,?)', [uid, grade || 'MCB', specialite || '']);
    }
    res.status(201).json({ message: 'Utilisateur créé.', id: uid });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erreur serveur.' });
  }
});

// ── PUT /api/admin/users/:id ──────────────────────────────────
router.put('/users/:id', isAdmin, async (req, res) => {
  const { nom, prenom, email, telephone, role: userRole } = req.body;
  if (!nom || !prenom || !email)
    return res.status(400).json({ error: 'Champs obligatoires manquants.' });
  try {
    await db.execute(
      'UPDATE users SET nom=?, prenom=?, email=?, telephone=?, role=? WHERE id=?',
      [nom, prenom, email, telephone || null, userRole, req.params.id]
    );
    res.json({ message: 'Utilisateur mis à jour.' });
  } catch (err) {
    res.status(500).json({ error: 'Erreur serveur.' });
  }
});

// ── PUT /api/admin/users/:id/status ──────────────────────────
router.put('/users/:id/status', isAdmin, async (req, res) => {
  const { status } = req.body;
  if (!['actif','inactif','en_attente'].includes(status))
    return res.status(400).json({ error: 'Statut invalide.' });
  try {
    await db.execute('UPDATE users SET status=? WHERE id=?', [status, req.params.id]);
    res.json({ message: 'Statut mis à jour.' });
  } catch (err) {
    res.status(500).json({ error: 'Erreur serveur.' });
  }
});

// ── DELETE /api/admin/users/:id ───────────────────────────────
router.delete('/users/:id', isAdmin, async (req, res) => {
  if (parseInt(req.params.id) === req.user.id)
    return res.status(400).json({ error: 'Impossible de supprimer votre propre compte.' });
  try {
    await db.execute('DELETE FROM users WHERE id=?', [req.params.id]);
    res.json({ message: 'Utilisateur supprimé.' });
  } catch (err) {
    res.status(500).json({ error: 'Erreur serveur.' });
  }
});

// ── GET /api/admin/modules ────────────────────────────────────
router.get('/modules', isAdmin, async (req, res) => {
  try {
    const [rows] = await db.execute(`
      SELECT m.*, n.libelle AS niveau, s.libelle AS semestre,
             CONCAT(u.nom,' ',u.prenom) AS professeur_nom, p.grade
      FROM modules m
      JOIN niveaux n ON n.id = m.niveau_id
      JOIN semestres s ON s.id = m.semestre_id
      LEFT JOIN professeurs p ON p.id = m.professeur_id
      LEFT JOIN users u ON u.id = p.user_id
      ORDER BY m.code
    `);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: 'Erreur serveur.' });
  }
});

// ── POST /api/admin/modules ───────────────────────────────────
router.post('/modules', isAdmin, async (req, res) => {
  const { code, intitule, niveau_id, semestre_id, professeur_id, has_td, has_tp, coefficient, credits } = req.body;
  if (!code || !intitule || !niveau_id || !semestre_id)
    return res.status(400).json({ error: 'Code, intitulé, niveau et semestre sont obligatoires.' });
  try {
    const [r] = await db.execute(
      'INSERT INTO modules (code,intitule,niveau_id,semestre_id,professeur_id,has_td,has_tp,coefficient,credits) VALUES (?,?,?,?,?,?,?,?,?)',
      [code, intitule, niveau_id, semestre_id, professeur_id || null,
       has_td ? 1 : 0, has_tp ? 1 : 0, coefficient || 2, credits || 3]
    );
    res.status(201).json({ message: 'Module créé.', id: r.insertId });
  } catch (err) {
    console.error('POST /modules error:', err.message);
    if (err.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: `Le code "${code}" est déjà utilisé.` });
    if (err.code === 'ER_NO_REFERENCED_ROW_2') return res.status(400).json({ error: 'Niveau ou semestre invalide.' });
    res.status(500).json({ error: err.message });
  }
});

// ── PUT /api/admin/modules/:id ────────────────────────────────
router.put('/modules/:id', isAdmin, async (req, res) => {
  const { code, intitule, niveau_id, semestre_id, professeur_id, has_td, has_tp, coefficient, credits } = req.body;
  try {
    await db.execute(
      'UPDATE modules SET code=?, intitule=?, niveau_id=?, semestre_id=?, professeur_id=?, has_td=?, has_tp=?, coefficient=?, credits=? WHERE id=?',
      [code, intitule, niveau_id, semestre_id, professeur_id || null,
       has_td ? 1 : 0, has_tp ? 1 : 0, coefficient || 2, credits || 3, req.params.id]
    );
    res.json({ message: 'Module mis à jour.' });
  } catch (err) {
    res.status(500).json({ error: 'Erreur serveur.' });
  }
});

// ── DELETE /api/admin/modules/:id ────────────────────────────
router.delete('/modules/:id', isAdmin, async (req, res) => {
  try {
    await db.execute('DELETE FROM modules WHERE id=?', [req.params.id]);
    res.json({ message: 'Module supprimé.' });
  } catch (err) {
    res.status(500).json({ error: 'Erreur serveur.' });
  }
});

// ── GET /api/admin/niveaux ────────────────────────────────────
router.get('/niveaux', isAdmin, async (req, res) => {
  const [rows] = await db.execute('SELECT * FROM niveaux');
  res.json(rows);
});

// ── GET /api/admin/semestres ──────────────────────────────────
router.get('/semestres', isAdmin, async (req, res) => {
  const [rows] = await db.execute(`
    SELECT s.*, a.libelle AS annee, n.libelle AS niveau
    FROM semestres s
    JOIN annees_universitaires a ON a.id = s.annee_id
    JOIN niveaux n ON n.id = s.niveau_id
    ORDER BY s.date_debut DESC
  `);
  res.json(rows);
});

// ── GET /api/admin/professeurs ────────────────────────────────
router.get('/professeurs', isAdmin, async (req, res) => {
  const [rows] = await db.execute(`
    SELECT p.id, p.grade, p.specialite, u.nom, u.prenom, u.email, u.status,
           COUNT(m.id) AS nb_modules
    FROM professeurs p
    JOIN users u ON u.id = p.user_id
    LEFT JOIN modules m ON m.professeur_id = p.id
    GROUP BY p.id
  `);
  res.json(rows);
});

// ── GET /api/admin/etudiants ──────────────────────────────────
router.get('/etudiants', isAdmin, async (req, res) => {
  const [rows] = await db.execute(`
    SELECT e.id, e.matricule, n.libelle AS niveau, u.nom, u.prenom, u.email, u.status,
           GROUP_CONCAT(DISTINCT g.nom ORDER BY g.type SEPARATOR ', ') AS groupes,
           ROUND(AVG(CASE WHEN p.statut='present' THEN 100.0 ELSE 0 END),1) AS taux_presence
    FROM etudiants e
    JOIN users u ON u.id = e.user_id
    JOIN niveaux n ON n.id = e.niveau_id
    LEFT JOIN etudiant_groupes eg ON eg.etudiant_id = e.id
    LEFT JOIN groupes g ON g.id = eg.groupe_id
    LEFT JOIN presences p ON p.etudiant_id = e.id
    GROUP BY e.id
    ORDER BY e.matricule
  `);
  res.json(rows);
});

// ── GET /api/admin/groupes ────────────────────────────────────
router.get('/groupes', isAdmin, async (req, res) => {
  try {
    const [rows] = await db.execute(`
      SELECT g.*, n.libelle AS niveau, COUNT(eg.etudiant_id) AS nb_etudiants
      FROM groupes g
      JOIN niveaux n ON n.id = g.niveau_id
      LEFT JOIN etudiant_groupes eg ON eg.groupe_id = g.id
      GROUP BY g.id ORDER BY g.nom
    `);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: 'Erreur serveur.' });
  }
});

// ── POST /api/admin/groupes ───────────────────────────────────
router.post('/groupes', isAdmin, async (req, res) => {
  const { nom, type, niveau_id } = req.body;
  if (!nom || !type || !niveau_id)
    return res.status(400).json({ error: 'Champs obligatoires manquants.' });
  try {
    const [r] = await db.execute('INSERT INTO groupes (nom, type, niveau_id) VALUES (?,?,?)', [nom, type, niveau_id]);
    res.status(201).json({ message: 'Groupe créé.', id: r.insertId });
  } catch (err) {
    res.status(500).json({ error: 'Erreur serveur.' });
  }
});

// ── PUT /api/admin/groupes/:id ────────────────────────────────
router.put('/groupes/:id', isAdmin, async (req, res) => {
  const { nom, type, niveau_id } = req.body;
  try {
    await db.execute('UPDATE groupes SET nom=?, type=?, niveau_id=? WHERE id=?', [nom, type, niveau_id, req.params.id]);
    res.json({ message: 'Groupe mis à jour.' });
  } catch (err) {
    res.status(500).json({ error: 'Erreur serveur.' });
  }
});

// ── DELETE /api/admin/groupes/:id ────────────────────────────
router.delete('/groupes/:id', isAdmin, async (req, res) => {
  try {
    await db.execute('DELETE FROM groupes WHERE id=?', [req.params.id]);
    res.json({ message: 'Groupe supprimé.' });
  } catch (err) {
    res.status(500).json({ error: 'Erreur serveur.' });
  }
});

// ── POST /api/admin/groupes/:id/etudiants ────────────────────
router.post('/groupes/:id/etudiants', isAdmin, async (req, res) => {
  const { etudiant_id } = req.body;
  try {
    await db.execute(
      'INSERT IGNORE INTO etudiant_groupes (etudiant_id, groupe_id) VALUES (?,?)',
      [etudiant_id, req.params.id]
    );
    res.status(201).json({ message: 'Étudiant ajouté au groupe.' });
  } catch (err) {
    res.status(500).json({ error: 'Erreur serveur.' });
  }
});

// ── DELETE /api/admin/groupes/:id/etudiants/:eid ─────────────
router.delete('/groupes/:id/etudiants/:eid', isAdmin, async (req, res) => {
  try {
    await db.execute(
      'DELETE FROM etudiant_groupes WHERE groupe_id=? AND etudiant_id=?',
      [req.params.id, req.params.eid]
    );
    res.json({ message: 'Étudiant retiré du groupe.' });
  } catch (err) {
    res.status(500).json({ error: 'Erreur serveur.' });
  }
});

// ── GET /api/admin/annees ─────────────────────────────────────
router.get('/annees', isAdmin, async (req, res) => {
  const [rows] = await db.execute('SELECT * FROM annees_universitaires ORDER BY date_debut DESC');
  res.json(rows);
});

// ── POST /api/admin/annees ────────────────────────────────────
router.post('/annees', isAdmin, async (req, res) => {
  const { libelle, date_debut, date_fin } = req.body;
  try {
    const [r] = await db.execute(
      'INSERT INTO annees_universitaires (libelle, date_debut, date_fin) VALUES (?,?,?)',
      [libelle, date_debut, date_fin]
    );
    res.status(201).json({ id: r.insertId });
  } catch (err) {
    res.status(500).json({ error: 'Erreur serveur.' });
  }
});

// ── POST /api/admin/semestres ─────────────────────────────────
router.post('/semestres', isAdmin, async (req, res) => {
  const { libelle, annee_id, niveau_id, date_debut, date_fin, actif } = req.body;
  try {
    const [r] = await db.execute(
      'INSERT INTO semestres (libelle, annee_id, niveau_id, date_debut, date_fin, actif) VALUES (?,?,?,?,?,?)',
      [libelle, annee_id, niveau_id, date_debut, date_fin, actif ? 1 : 0]
    );
    res.status(201).json({ id: r.insertId });
  } catch (err) {
    res.status(500).json({ error: 'Erreur serveur.' });
  }
});

// ── GET /api/admin/justifications ────────────────────────────
router.get('/justifications', isAdmin, async (req, res) => {
  try {
    const [rows] = await db.execute(`
      SELECT j.*, CONCAT(ue.nom,' ',ue.prenom) AS etudiant_nom, ue.email AS etudiant_email,
             m.intitule AS module, s.date_seance, s.type AS seance_type,
             CONCAT(up.nom,' ',up.prenom) AS traite_par_nom
      FROM justifications j
      JOIN etudiants e ON e.id = j.etudiant_id
      JOIN users ue ON ue.id = e.user_id
      JOIN seances s ON s.id = j.seance_id
      JOIN modules m ON m.id = s.module_id
      LEFT JOIN users up ON up.id = j.traite_par
      ORDER BY j.created_at DESC
    `);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: 'Erreur serveur.' });
  }
});

// ── PUT /api/admin/justifications/:id ────────────────────────
router.put('/justifications/:id', isAdmin, async (req, res) => {
  const { statut, commentaire } = req.body;
  if (!['acceptee','refusee'].includes(statut))
    return res.status(400).json({ error: 'Statut invalide.' });
  try {
    await db.execute(
      'UPDATE justifications SET statut=?, commentaire=?, traite_at=NOW(), traite_par=? WHERE id=?',
      [statut, commentaire || null, req.user.id, req.params.id]
    );
    if (statut === 'acceptee') {
      const [j] = await db.execute('SELECT seance_id, etudiant_id FROM justifications WHERE id=?', [req.params.id]);
      if (j.length) {
        await db.execute(
          'INSERT INTO presences (seance_id, etudiant_id, statut) VALUES (?,?,\'justifie\') ON DUPLICATE KEY UPDATE statut=\'justifie\'',
          [j[0].seance_id, j[0].etudiant_id]
        );
      }
    }
    res.json({ message: `Justification ${statut}.` });
  } catch (err) {
    res.status(500).json({ error: 'Erreur serveur.' });
  }
});

// ── GET /api/admin/stats/presence ────────────────────────────
router.get('/stats/presence', isAdmin, async (req, res) => {
  try {
    const [rows] = await db.execute(`
      SELECT n.libelle AS niveau,
             COUNT(p.id) AS total,
             SUM(CASE WHEN p.statut='present' THEN 1 ELSE 0 END) AS presents,
             ROUND(SUM(CASE WHEN p.statut='present' THEN 100.0 ELSE 0 END)/NULLIF(COUNT(p.id),0),1) AS taux
      FROM niveaux n
      JOIN etudiants e ON e.niveau_id = n.id
      JOIN presences p ON p.etudiant_id = e.id
      GROUP BY n.id
    `);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: 'Erreur serveur.' });
  }
});

module.exports = router;
