// server.js — PulseNote Backend
require("dotenv").config();

const express = require("express");
const cors    = require("cors");
const path    = require("path");
const rateLimit = require("express-rate-limit");
const { getDb } = require("./db");

const app  = express();
const PORT = process.env.PORT || 3001;

// ── Middleware ───────────────────────────────────────────────
app.use(cors({
  origin: process.env.ALLOWED_ORIGIN || "*",
  credentials: true,
}));

app.use(express.json({ limit: "5mb" }));
app.use(express.urlencoded({ extended: true }));

// Rate limiting — protect auth endpoints
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 20,
  message: { error: "Muitas tentativas. Aguarde 15 minutos." },
  standardHeaders: true,
  legacyHeaders: false,
});

// Serve static frontend files
app.use(express.static(path.join(__dirname, "../frontend/src")));

// ── Routes ───────────────────────────────────────────────────
app.use("/api/auth", authLimiter, require("./routes/auth"));
app.use("/api/data", require("./routes/data"));

// Health check
app.get("/api/health", (_, res) => res.json({ status: "ok", time: new Date().toISOString() }));

// Fallback — serve login for unknown routes (SPA behavior)
app.get("*", (req, res) => {
  if (req.path.startsWith("/api")) {
    return res.status(404).json({ error: "Rota não encontrada." });
  }
  res.sendFile(path.join(__dirname, "../frontend/src/index.html"));
});

// ── Start ────────────────────────────────────────────────────
async function start() {
  await getDb(); // Initialize DB & tables
  app.listen(PORT, () => {
    console.log(`\n🚀 PulseNote backend rodando em http://localhost:${PORT}`);
    console.log(`📁 SQLite: pulsenote.db`);
    console.log(`🔑 JWT: ${process.env.JWT_SECRET ? "env configurado ✅" : "usando chave dev ⚠️  (configure JWT_SECRET em prod)"}`);
    console.log(`📧 SMTP: ${process.env.SMTP_HOST ? process.env.SMTP_HOST + " ✅" : "Ethereal (modo dev)"}`);
    console.log(`\nAcesse: http://localhost:${PORT}\n`);
  });
}

start().catch(console.error);
