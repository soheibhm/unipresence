const router  = require('express').Router();
const bcrypt  = require('bcryptjs');
const jwt     = require('jsonwebtoken');
const crypto  = require('crypto');
const db      = require('../db');
const { auth } = require('../middleware/auth');
const { sendVerificationEmail, sendPasswordResetEmail } = require('../utils/mailer');

// ── POST /api/auth/login ──────────────────────────────────────
router.post('/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password)
    return res.status(400).json({ error: 'Email et mot de passe requis.' });

  try {
    const [rows] = await db.execute(
      'SELECT * FROM users WHERE email = ? AND status != "inactif"',
      [email.toLowerCase().trim()]
    );
    if (!rows.length)
      return res.status(401).json({ error: 'Identifiants incorrects.' });

    const user = rows[0];

    if (!user.email_verified)
      return res.status(403).json({
        error: 'Veuillez confirmer votre adresse email avant de vous connecter.',
        email_unverified: true
      });

    if (user.status === 'en_attente')
      return res.status(403).json({
        error: 'Votre compte est en attente d\'approbation par l\'administrateur.',
        pending_approval: true
      });

    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid)
      return res.status(401).json({ error: 'Identifiants incorrects.' });

    await db.execute('UPDATE users SET last_login = NOW() WHERE id = ?', [user.id]);

    let profile = {};
    if (user.role === 'etudiant') {
      const [et] = await db.execute(
        `SELECT e.matricule, n.libelle AS niveau, e.id AS etudiant_id,
                GROUP_CONCAT(DISTINCT g.nom ORDER BY g.type SEPARATOR ', ') AS groupes
         FROM etudiants e
         JOIN niveaux n ON n.id = e.niveau_id
         LEFT JOIN etudiant_groupes eg ON eg.etudiant_id = e.id
         LEFT JOIN groupes g ON g.id = eg.groupe_id
         WHERE e.user_id = ?
         GROUP BY e.id`, [user.id]
      );
      profile = et[0] || {};
    } else if (user.role === 'professeur') {
      const [pr] = await db.execute(
        'SELECT id AS professeur_id, grade, specialite FROM professeurs WHERE user_id = ?',
        [user.id]
      );
      profile = pr[0] || {};
    }

    const payload = {
      id: user.id, email: user.email, role: user.role,
      nom: user.nom, prenom: user.prenom, ...profile
    };

    const token = jwt.sign(payload, process.env.JWT_SECRET, {
      expiresIn: process.env.JWT_EXPIRES_IN || '8h'
    });

    res.json({ token, user: payload });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erreur serveur.' });
  }
});

// ── POST /api/auth/register ───────────────────────────────────
router.post('/register', async (req, res) => {
  const { nom, prenom, email, password, role, matricule, niveau_id } = req.body;
  if (!nom || !prenom || !email || !password)
    return res.status(400).json({ error: 'Champs obligatoires manquants.' });
  if (password.length < 8)
    return res.status(400).json({ error: 'Mot de passe trop court (min. 8 caractères).' });

  try {
    const [existing] = await db.execute('SELECT id FROM users WHERE email = ?', [email]);
    if (existing.length)
      return res.status(409).json({ error: 'Cet email est déjà utilisé.' });

    const hash = await bcrypt.hash(password, 10);
    const allowedRoles = ['professeur', 'etudiant'];
    const userRole = allowedRoles.includes(role) ? role : 'etudiant';
    // All new registrations → en_attente (require admin approval after email verification)
    const status = 'en_attente';

    const verifyToken   = crypto.randomBytes(32).toString('hex');
    const verifyExpires = new Date(Date.now() + 24 * 60 * 60 * 1000);

    const [result] = await db.execute(
      `INSERT INTO users (nom, prenom, email, password_hash, role, status, email_verified,
        email_verify_token, email_verify_expires)
       VALUES (?,?,?,?,?,?, 0, ?,?)`,
      [nom, prenom, email.toLowerCase().trim(), hash, userRole, status, verifyToken, verifyExpires]
    );
    const userId = result.insertId;

    if (userRole === 'etudiant' && matricule && niveau_id) {
      await db.execute(
        'INSERT INTO etudiants (user_id, matricule, niveau_id) VALUES (?,?,?)',
        [userId, matricule, niveau_id]
      );
    } else if (userRole === 'professeur') {
      await db.execute('INSERT INTO professeurs (user_id) VALUES (?)', [userId]);
    }

    const baseUrl = process.env.APP_URL || `http://localhost:${process.env.PORT || 3000}`;
    const verifyUrl = `${baseUrl}/api/auth/verify-email?token=${verifyToken}`;

    sendVerificationEmail({ nom, prenom, email: email.toLowerCase().trim(), verifyUrl })
      .catch(err => console.error('⚠️  Email send failed:', err.message));

    res.status(201).json({
      message: 'Compte créé. Vérifiez votre email, puis attendez l\'approbation de l\'administrateur.'
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erreur serveur.' });
  }
});

// ── GET /api/auth/verify-email ────────────────────────────────
router.get('/verify-email', async (req, res) => {
  const { token } = req.query;
  if (!token) return res.status(400).send(htmlPage('Erreur', 'Token manquant.', false));

  try {
    const [rows] = await db.execute(
      'SELECT id, nom, prenom, email_verified, email_verify_expires FROM users WHERE email_verify_token = ?',
      [token]
    );
    if (!rows.length)
      return res.status(404).send(htmlPage('Lien invalide', 'Ce lien de vérification est invalide.', false));

    const user = rows[0];
    if (user.email_verified)
      return res.send(htmlPage('Déjà vérifié', 'Votre email est déjà confirmé. En attente d\'approbation admin.', true, false));

    if (new Date() > new Date(user.email_verify_expires))
      return res.status(410).send(htmlPage('Lien expiré',
        'Ce lien a expiré (valide 24h). <a href="/login.html" style="color:#8b5cf6;">Demandez un nouveau lien</a>.', false));

    await db.execute(
      'UPDATE users SET email_verified=1, email_verify_token=NULL, email_verify_expires=NULL WHERE id=?',
      [user.id]
    );

    res.send(htmlPage('Email confirmé ✅',
      `Bienvenue ${user.nom} ! Votre adresse email a été confirmée.<br><br>
       <strong>Votre compte est maintenant en attente d'approbation par l'administrateur.</strong><br>
       Vous recevrez un email dès que votre compte sera activé.`, true, false));
  } catch (err) {
    console.error(err);
    res.status(500).send(htmlPage('Erreur serveur', 'Une erreur est survenue.', false));
  }
});

// ── POST /api/auth/resend-verification ───────────────────────
router.post('/resend-verification', async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: 'Email requis.' });

  try {
    const [rows] = await db.execute(
      'SELECT id, nom, prenom, email_verified FROM users WHERE email=?',
      [email.toLowerCase().trim()]
    );
    if (!rows.length || rows[0].email_verified)
      return res.json({ message: 'Si cet email existe et n\'est pas vérifié, un email a été envoyé.' });

    const verifyToken   = crypto.randomBytes(32).toString('hex');
    const verifyExpires = new Date(Date.now() + 24 * 60 * 60 * 1000);

    await db.execute(
      'UPDATE users SET email_verify_token=?, email_verify_expires=? WHERE id=?',
      [verifyToken, verifyExpires, rows[0].id]
    );

    const baseUrl  = process.env.APP_URL || `http://localhost:${process.env.PORT || 3000}`;
    sendVerificationEmail({
      nom: rows[0].nom, prenom: rows[0].prenom,
      email: email.toLowerCase().trim(),
      verifyUrl: `${baseUrl}/api/auth/verify-email?token=${verifyToken}`
    }).catch(err => console.error('⚠️  Email resend failed:', err.message));

    res.json({ message: 'Si cet email existe et n\'est pas vérifié, un email a été envoyé.' });
  } catch (err) {
    res.status(500).json({ error: 'Erreur serveur.' });
  }
});

// ── POST /api/auth/forgot-password ───────────────────────────
router.post('/forgot-password', async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: 'Email requis.' });

  try {
    const [rows] = await db.execute(
      'SELECT id, nom, prenom FROM users WHERE email=? AND status="actif"',
      [email.toLowerCase().trim()]
    );

    // Always return success to prevent email enumeration
    if (!rows.length)
      return res.json({ message: 'Si cet email existe, un lien de réinitialisation a été envoyé.' });

    const user = rows[0];
    const resetToken   = crypto.randomBytes(32).toString('hex');
    const resetExpires = new Date(Date.now() + 60 * 60 * 1000); // 1 hour

    await db.execute(
      'UPDATE users SET reset_token=?, reset_token_expires=? WHERE id=?',
      [resetToken, resetExpires, user.id]
    );

    const baseUrl  = process.env.APP_URL || `http://localhost:${process.env.PORT || 3000}`;
    const resetUrl = `${baseUrl}/reset-password.html?token=${resetToken}`;

    sendPasswordResetEmail({
      nom: user.nom, prenom: user.prenom,
      email: email.toLowerCase().trim(),
      resetUrl
    }).catch(err => console.error('⚠️  Reset email failed:', err.message));

    res.json({ message: 'Si cet email existe, un lien de réinitialisation a été envoyé.' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erreur serveur.' });
  }
});

// ── POST /api/auth/reset-password ────────────────────────────
router.post('/reset-password', async (req, res) => {
  const { token, password } = req.body;
  if (!token || !password)
    return res.status(400).json({ error: 'Token et nouveau mot de passe requis.' });
  if (password.length < 8)
    return res.status(400).json({ error: 'Mot de passe trop court (min. 8 caractères).' });

  try {
    const [rows] = await db.execute(
      'SELECT id FROM users WHERE reset_token=? AND reset_token_expires > NOW()',
      [token]
    );
    if (!rows.length)
      return res.status(400).json({ error: 'Lien invalide ou expiré.' });

    const hash = await bcrypt.hash(password, 10);
    await db.execute(
      'UPDATE users SET password_hash=?, reset_token=NULL, reset_token_expires=NULL WHERE id=?',
      [hash, rows[0].id]
    );

    res.json({ message: 'Mot de passe réinitialisé avec succès. Vous pouvez vous connecter.' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erreur serveur.' });
  }
});

// ── GET /api/auth/me ──────────────────────────────────────────
router.get('/me', auth, async (req, res) => {
  try {
    const [rows] = await db.execute(
      'SELECT id, nom, prenom, email, role, status, telephone, created_at, last_login FROM users WHERE id = ?',
      [req.user.id]
    );
    res.json(rows[0] || {});
  } catch (err) {
    res.status(500).json({ error: 'Erreur serveur.' });
  }
});

// ── PUT /api/auth/profile ─────────────────────────────────────
router.put('/profile', auth, async (req, res) => {
  const { nom, prenom, telephone } = req.body;
  try {
    await db.execute(
      'UPDATE users SET nom=?, prenom=?, telephone=? WHERE id=?',
      [nom, prenom, telephone, req.user.id]
    );
    res.json({ message: 'Profil mis à jour.' });
  } catch (err) {
    res.status(500).json({ error: 'Erreur serveur.' });
  }
});

// ── PUT /api/auth/password ────────────────────────────────────
router.put('/password', auth, async (req, res) => {
  const { current_password, new_password } = req.body;
  if (!current_password || !new_password)
    return res.status(400).json({ error: 'Champs obligatoires.' });
  if (new_password.length < 8)
    return res.status(400).json({ error: 'Mot de passe trop court.' });

  try {
    const [rows] = await db.execute('SELECT password_hash FROM users WHERE id=?', [req.user.id]);
    const valid = await bcrypt.compare(current_password, rows[0].password_hash);
    if (!valid) return res.status(401).json({ error: 'Mot de passe actuel incorrect.' });

    const hash = await bcrypt.hash(new_password, 10);
    await db.execute('UPDATE users SET password_hash=? WHERE id=?', [hash, req.user.id]);
    res.json({ message: 'Mot de passe modifié.' });
  } catch (err) {
    res.status(500).json({ error: 'Erreur serveur.' });
  }
});

module.exports = router;

// ── Helper HTML page ──────────────────────────────────────────
function htmlPage(title, message, success, showLoginBtn = true) {
  const color = success ? '#34d399' : '#f87171';
  return `<!DOCTYPE html>
<html lang="fr">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1.0">
  <title>${title} — UniPresence</title>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
  <style>
    *{margin:0;padding:0;box-sizing:border-box;}
    body{background:#0c0b14;font-family:'Inter',sans-serif;min-height:100vh;
         display:flex;align-items:center;justify-content:center;}
    .card{background:#13111f;border:1px solid rgba(139,92,246,0.2);border-radius:20px;
          padding:48px;max-width:480px;width:90%;text-align:center;
          box-shadow:0 8px 48px rgba(0,0,0,0.5);}
    .stripe{height:4px;border-radius:20px 20px 0 0;background:${color};
            margin:-48px -48px 36px;}
    .icon{font-size:52px;margin-bottom:20px;}
    h1{font-size:22px;color:#f1eeff;margin-bottom:12px;}
    p{color:#a89ec4;line-height:1.7;font-size:14px;}
    a{color:#8b5cf6;text-decoration:none;font-weight:500;}
    .btn{display:inline-block;margin-top:28px;padding:12px 32px;
         background:linear-gradient(135deg,#8b5cf6,#6d28d9);color:#fff;
         border-radius:10px;font-weight:600;font-size:14px;}
    .btn:hover{opacity:0.9;}
  </style>
</head>
<body>
  <div class="card">
    <div class="stripe"></div>
    <div class="icon">${success ? '✅' : '❌'}</div>
    <h1>${title}</h1>
    <p>${message}</p>
    ${showLoginBtn && success ? '<a class="btn" href="/login.html">Se connecter →</a>' : ''}
  </div>
</body>
</html>`;
}
