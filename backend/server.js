require('dotenv').config();
const express = require('express');
const cors    = require('cors');
const path    = require('path');

const app = express();

app.use(cors({ origin: '*', credentials: true }));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use('/uploads', express.static(path.join(__dirname, '..', 'uploads')));
app.use(express.static(path.join(__dirname, '..', 'frontend')));

app.use('/api/auth',     require('./routes/auth'));
app.use('/api/admin',    require('./routes/admin'));
app.use('/api/prof',     require('./routes/prof'));
app.use('/api/etudiant', require('./routes/etudiant'));

const upload = require('./middleware/upload');
const db     = require('./db');
const { auth } = require('./middleware/auth');

process.on('uncaughtException',   err => console.error('UNCAUGHT EXCEPTION:', err));
process.on('unhandledRejection',  err => console.error('UNHANDLED REJECTION:', err));

app.post('/api/upload', auth, upload.single('fichier'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Aucun fichier reçu.' });
  res.json({ url: `/uploads/${req.file.filename}`, filename: req.file.filename });
});

const pages = ['home','login','admin','professor','student','reset-password'];
pages.forEach(p => {
  app.get(`/${p}.html`, (_req, res) =>
    res.sendFile(path.join(__dirname, '..', 'frontend', `${p}.html`))
  );
});
app.get('/', (_req, res) =>
  res.sendFile(path.join(__dirname, '..', 'frontend', 'home.html'))
);

app.use((_req, res) => res.status(404).json({ error: 'Route introuvable.' }));
app.use((err, _req, res, _next) => {
  console.error('💥', err.message);
  res.status(500).json({ error: err.message || 'Erreur interne.' });
});

const https = require('https');
const fs    = require('fs');
const PORT  = process.env.PORT || 443;

https.createServer({
  key:  fs.readFileSync(__dirname + '/key.pem'),
  cert: fs.readFileSync(__dirname + '/cert.pem')
}, app).listen(PORT, '0.0.0.0', () => {
  console.log(`\n🚀 UniPresence running on https://5.231.120.22`);
});