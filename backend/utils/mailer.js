const nodemailer = require('nodemailer');

const transporter = nodemailer.createTransport({
  host:   process.env.SMTP_HOST   || 'smtp.gmail.com',
  port:   parseInt(process.env.SMTP_PORT || '587'),
  secure: process.env.SMTP_SECURE === 'true',
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS
  }
});

const FROM = () => process.env.SMTP_FROM || `"UniPresence" <${process.env.SMTP_USER}>`;

function baseTemplate(title, content, btnText, btnUrl, color = '#6366f1') {
  return `<!DOCTYPE html>
<html lang="fr">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1.0">
  <title>${title}</title>
</head>
<body style="margin:0;padding:0;background:#0f0e1a;font-family:'Segoe UI',system-ui,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#0f0e1a;padding:40px 16px;">
    <tr><td align="center">
      <table width="520" cellpadding="0" cellspacing="0"
             style="background:#1a1730;border-radius:16px;overflow:hidden;border:1px solid rgba(139,92,246,0.2);">
        <tr><td style="background:linear-gradient(135deg,${color},#4f46e5);height:5px;"></td></tr>
        <tr>
          <td style="padding:36px 40px 0;text-align:center;">
            <h1 style="margin:0;font-size:24px;color:#a78bfa;letter-spacing:-0.5px;">🎓 UniPresence</h1>
          </td>
        </tr>
        <tr>
          <td style="padding:24px 40px 32px;">
            ${content}
            ${btnText && btnUrl ? `
            <table cellpadding="0" cellspacing="0" style="margin:28px auto;">
              <tr>
                <td align="center" style="border-radius:10px;background:linear-gradient(135deg,${color},#4f46e5);">
                  <a href="${btnUrl}"
                     style="display:inline-block;padding:14px 36px;color:#ffffff;
                            font-weight:700;font-size:15px;text-decoration:none;border-radius:10px;">
                    ${btnText}
                  </a>
                </td>
              </tr>
            </table>
            <p style="margin:0;color:#5c5478;font-size:12px;word-break:break-all;">
              Ou copiez ce lien : <span style="color:#8b5cf6;">${btnUrl}</span>
            </p>` : ''}
          </td>
        </tr>
        <tr>
          <td style="background:#13111f;padding:20px 40px;border-top:1px solid rgba(139,92,246,0.1);
                     text-align:center;color:#5c5478;font-size:12px;">
            © ${new Date().getFullYear()} UniPresence — Système de gestion des présences
          </td>
        </tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

async function sendVerificationEmail({ nom, prenom, email, verifyUrl }) {
  const content = `
    <h2 style="margin:0 0 12px;font-size:20px;color:#f1eeff;">Bonjour ${prenom} ${nom},</h2>
    <p style="margin:0 0 16px;color:#a89ec4;line-height:1.7;font-size:15px;">
      Merci de vous être inscrit sur <strong style="color:#a78bfa;">UniPresence</strong>.<br>
      Pour activer votre compte, confirmez votre adresse email ci-dessous.
    </p>
    <p style="margin:0 0 8px;color:#5c5478;font-size:13px;">
      Ce lien est valable <strong>24 heures</strong>. Si vous n'avez pas créé de compte, ignorez cet email.
    </p>`;

  await transporter.sendMail({
    from: FROM(), to: email,
    subject: '✅ Confirmez votre adresse email — UniPresence',
    html: baseTemplate('Confirmez votre email', content, '✅ Confirmer mon email', verifyUrl)
  });
  console.log(`📧 Verification email → ${email}`);
}

async function sendPasswordResetEmail({ nom, prenom, email, resetUrl }) {
  const content = `
    <h2 style="margin:0 0 12px;font-size:20px;color:#f1eeff;">Bonjour ${prenom} ${nom},</h2>
    <p style="margin:0 0 16px;color:#a89ec4;line-height:1.7;font-size:15px;">
      Vous avez demandé la réinitialisation de votre mot de passe.<br>
      Cliquez sur le bouton ci-dessous pour choisir un nouveau mot de passe.
    </p>
    <p style="margin:0 0 8px;color:#5c5478;font-size:13px;">
      Ce lien est valable <strong>1 heure</strong>. Si vous n'avez pas demandé cela, ignorez cet email — votre mot de passe ne changera pas.
    </p>`;

  await transporter.sendMail({
    from: FROM(), to: email,
    subject: '🔑 Réinitialisation de mot de passe — UniPresence',
    html: baseTemplate('Réinitialisation du mot de passe', content, '🔑 Réinitialiser mon mot de passe', resetUrl, '#f59e0b')
  });
  console.log(`📧 Password reset email → ${email}`);
}

async function sendApprovalEmail({ nom, prenom, email, role }) {
  const roleLabel = role === 'etudiant' ? 'étudiant' : 'professeur';
  const content = `
    <h2 style="margin:0 0 12px;font-size:20px;color:#f1eeff;">Félicitations ${prenom} ${nom} ! 🎉</h2>
    <p style="margin:0 0 16px;color:#a89ec4;line-height:1.7;font-size:15px;">
      Votre compte <strong style="color:#a78bfa;">${roleLabel}</strong> sur UniPresence a été <strong style="color:#34d399;">approuvé</strong> par l'administrateur.<br>
      Vous pouvez maintenant vous connecter et accéder à la plateforme.
    </p>`;

  await transporter.sendMail({
    from: FROM(), to: email,
    subject: '🎉 Compte approuvé — UniPresence',
    html: baseTemplate('Compte approuvé', content, '🚀 Se connecter', `${process.env.APP_URL}/login.html`, '#34d399')
  });
  console.log(`📧 Approval email → ${email}`);
}

module.exports = { sendVerificationEmail, sendPasswordResetEmail, sendApprovalEmail, transporter };
