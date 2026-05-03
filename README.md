# 🎓 UniPresence v2.0

Système de gestion des présences universitaires par QR Code.

## 🆕 Nouveautés v2.0

- **Réinitialisation de mot de passe** par email (lien valide 1h)
- **Crédits ECTS** en plus du coefficient pour chaque module  
- **Approbation admin** obligatoire après vérification email
  - L'admin assigne les **groupes** lors de l'approbation d'un étudiant
  - Badge de notification dans la sidebar pour les comptes en attente
- **Police Inter** sur toutes les pages (meilleure lisibilité)
- Email de bienvenue lors de l'approbation

## 📁 Structure

```
unipresence/
├── backend/
│   ├── server.js           # Point d'entrée Express
│   ├── db.js               # Pool MySQL
│   ├── database.sql        # Schéma + seed data
│   ├── .env                # Variables d'environnement
│   ├── package.json
│   ├── middleware/
│   │   ├── auth.js         # JWT middleware
│   │   └── upload.js       # Multer config
│   ├── routes/
│   │   ├── auth.js         # Login, register, verify, reset
│   │   ├── admin.js        # Admin CRUD + approvals
│   │   ├── prof.js         # Professor routes
│   │   └── etudiant.js     # Student routes
│   └── utils/
│       └── mailer.js       # Nodemailer (verify + reset + approval)
├── frontend/
│   ├── api.js              # Client API helper
│   ├── home.html
│   ├── login.html          # Connexion + Inscription + Mot de passe oublié
│   ├── reset-password.html # Réinitialisation mot de passe
│   ├── admin.html          # Dashboard admin + approbations
│   ├── professor.html
│   └── student.html
└── uploads/                # Fichiers justificatifs
```

## ⚙️ Installation

### 1. Base de données
```bash
mysql -u root -p < backend/database.sql
```

### 2. Configuration
```bash
cp backend/.env.example backend/.env
# Éditez .env avec vos paramètres SMTP et DB
```

### 3. Dépendances
```bash
cd backend
npm install
```

### 4. Démarrer
```bash
npm start
# ou en développement:
npm run dev
```

## 🔑 Comptes de test

| Rôle | Email | Mot de passe |
|------|-------|-------------|
| Admin | admin@unipresence.dz | Admin@1234 |
| Professeur | k.boudiaf@unipresence.dz | Prof@1234 |
| Étudiant | y.amrani@unipresence.dz | Etudiant@1234 |

## 📧 Configuration SMTP (Gmail)

1. Activez la validation en 2 étapes sur votre compte Google
2. Créez un mot de passe d'application : Google Account → Sécurité → Mots de passe des applications
3. Dans `.env` :
```
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=votre@gmail.com
SMTP_PASS=xxxx xxxx xxxx xxxx   # mot de passe d'application (16 caractères)
SMTP_FROM="UniPresence <votre@gmail.com>"
APP_URL=http://votre-domaine.com
```

## 🔄 Flux d'inscription (v2.0)

1. L'utilisateur s'inscrit → statut `en_attente`, email **non vérifié**
2. Email de vérification envoyé → l'utilisateur clique le lien
3. Statut passe à `en_attente` + email **vérifié**
4. L'admin voit le compte dans "Approbations"
5. L'admin approuve → assigne les groupes (pour étudiant) → statut `actif`
6. Email de bienvenue envoyé à l'utilisateur

## 🗄️ Migration depuis v1

Si vous avez déjà une base de données, décommentez la section MIGRATION dans `database.sql` et exécutez-la.
