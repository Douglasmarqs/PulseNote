// routes/auth.js
const express = require("express");
const bcrypt = require("bcryptjs");
const crypto = require("crypto");
const router = express.Router();

const { get, run } = require("../db");
const { signToken, requireAuth } = require("../middleware/auth");
const { sendResetEmail, sendWelcomeEmail } = require("../mailer");

const FRONTEND_URL = process.env.FRONTEND_URL || "http://localhost:5500";

// ── POST /api/auth/register ──────────────────────────────────
router.post("/register", async (req, res) => {
  try {
    const { name, email, password } = req.body;

    if (!name || !email || !password) {
      return res.status(400).json({ error: "Nome, e-mail e senha são obrigatórios." });
    }

    if (password.length < 6) {
      return res.status(400).json({ error: "A senha deve ter pelo menos 6 caracteres." });
    }

    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
      return res.status(400).json({ error: "E-mail inválido." });
    }

    const existing = get("SELECT id FROM users WHERE email = ?", [email.toLowerCase()]);
    if (existing) {
      return res.status(409).json({ error: "Este e-mail já está cadastrado." });
    }

    const hash = await bcrypt.hash(password, 12);
    run(
      "INSERT INTO users (name, email, password) VALUES (?, ?, ?)",
      [name.trim(), email.toLowerCase(), hash]
    );

    const user = get("SELECT * FROM users WHERE email = ?", [email.toLowerCase()]);

    // Create empty user data
    run("INSERT INTO user_data (user_id, data) VALUES (?, ?)", [user.id, "{}"]);

    const token = signToken(user);

    // Send welcome email (non-blocking)
    sendWelcomeEmail(user.email, user.name).catch(() => {});

    return res.status(201).json({
      token,
      user: { id: user.id, name: user.name, email: user.email, avatar: user.avatar },
    });
  } catch (err) {
    console.error("Register error:", err);
    return res.status(500).json({ error: "Erro interno. Tente novamente." });
  }
});

// ── POST /api/auth/login ─────────────────────────────────────
router.post("/login", async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: "E-mail e senha são obrigatórios." });
    }

    const user = get("SELECT * FROM users WHERE email = ?", [email.toLowerCase()]);
    if (!user) {
      return res.status(401).json({ error: "E-mail ou senha incorretos." });
    }

    const match = await bcrypt.compare(password, user.password);
    if (!match) {
      return res.status(401).json({ error: "E-mail ou senha incorretos." });
    }

    const token = signToken(user);

    return res.json({
      token,
      user: { id: user.id, name: user.name, email: user.email, avatar: user.avatar },
    });
  } catch (err) {
    console.error("Login error:", err);
    return res.status(500).json({ error: "Erro interno. Tente novamente." });
  }
});

// ── GET /api/auth/me ─────────────────────────────────────────
router.get("/me", requireAuth, (req, res) => {
  const user = get("SELECT id, name, email, avatar, created_at FROM users WHERE id = ?", [req.user.id]);
  if (!user) return res.status(404).json({ error: "Usuário não encontrado." });
  return res.json({ user });
});

// ── PATCH /api/auth/profile ──────────────────────────────────
router.patch("/profile", requireAuth, async (req, res) => {
  try {
    const { name, avatar } = req.body;
    if (name) {
      run("UPDATE users SET name = ? WHERE id = ?", [name.trim(), req.user.id]);
    }
    if (avatar !== undefined) {
      run("UPDATE users SET avatar = ? WHERE id = ?", [avatar, req.user.id]);
    }
    const user = get("SELECT id, name, email, avatar FROM users WHERE id = ?", [req.user.id]);
    return res.json({ user });
  } catch (err) {
    console.error("Profile update error:", err);
    return res.status(500).json({ error: "Erro ao atualizar perfil." });
  }
});

// ── PATCH /api/auth/change-password ─────────────────────────
router.patch("/change-password", requireAuth, async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;
    if (!currentPassword || !newPassword) {
      return res.status(400).json({ error: "Preencha todos os campos." });
    }
    if (newPassword.length < 6) {
      return res.status(400).json({ error: "Nova senha deve ter pelo menos 6 caracteres." });
    }
    const user = get("SELECT * FROM users WHERE id = ?", [req.user.id]);
    const match = await bcrypt.compare(currentPassword, user.password);
    if (!match) {
      return res.status(401).json({ error: "Senha atual incorreta." });
    }
    const hash = await bcrypt.hash(newPassword, 12);
    run("UPDATE users SET password = ? WHERE id = ?", [hash, req.user.id]);
    return res.json({ message: "Senha alterada com sucesso." });
  } catch (err) {
    console.error("Change password error:", err);
    return res.status(500).json({ error: "Erro interno." });
  }
});

// ── POST /api/auth/forgot-password ──────────────────────────
router.post("/forgot-password", async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: "Informe o e-mail." });

    const user = get("SELECT * FROM users WHERE email = ?", [email.toLowerCase()]);

    // Always return success (don't reveal if email exists)
    if (!user) {
      return res.json({ message: "Se este e-mail estiver cadastrado, você receberá as instruções em breve." });
    }

    // Invalidate old tokens
    run("UPDATE reset_tokens SET used = 1 WHERE user_id = ?", [user.id]);

    // Create new token (expires in 30 min)
    const token = crypto.randomBytes(32).toString("hex");
    const expiresAt = new Date(Date.now() + 30 * 60 * 1000).toISOString();
    run(
      "INSERT INTO reset_tokens (user_id, token, expires_at) VALUES (?, ?, ?)",
      [user.id, token, expiresAt]
    );

    const resetUrl = `${FRONTEND_URL}/reset-password.html?token=${token}`;

    await sendResetEmail(user.email, user.name, resetUrl);

    return res.json({ message: "Se este e-mail estiver cadastrado, você receberá as instruções em breve." });
  } catch (err) {
    console.error("Forgot password error:", err);
    return res.status(500).json({ error: "Erro ao enviar e-mail. Tente novamente." });
  }
});

// ── POST /api/auth/reset-password ───────────────────────────
router.post("/reset-password", async (req, res) => {
  try {
    const { token, newPassword } = req.body;

    if (!token || !newPassword) {
      return res.status(400).json({ error: "Token e nova senha são obrigatórios." });
    }
    if (newPassword.length < 6) {
      return res.status(400).json({ error: "A senha deve ter pelo menos 6 caracteres." });
    }

    const record = get(
      "SELECT * FROM reset_tokens WHERE token = ? AND used = 0",
      [token]
    );

    if (!record) {
      return res.status(400).json({ error: "Link inválido ou já utilizado." });
    }

    if (new Date(record.expires_at) < new Date()) {
      return res.status(400).json({ error: "Link expirado. Solicite um novo." });
    }

    const hash = await bcrypt.hash(newPassword, 12);
    run("UPDATE users SET password = ? WHERE id = ?", [hash, record.user_id]);
    run("UPDATE reset_tokens SET used = 1 WHERE id = ?", [record.id]);

    return res.json({ message: "Senha redefinida com sucesso! Faça login com a nova senha." });
  } catch (err) {
    console.error("Reset password error:", err);
    return res.status(500).json({ error: "Erro interno." });
  }
});

// ── GET /api/auth/validate-reset-token ──────────────────────
router.get("/validate-reset-token", (req, res) => {
  const { token } = req.query;
  if (!token) return res.status(400).json({ valid: false });

  const record = get(
    "SELECT * FROM reset_tokens WHERE token = ? AND used = 0",
    [token]
  );

  if (!record || new Date(record.expires_at) < new Date()) {
    return res.json({ valid: false });
  }

  const user = get("SELECT name FROM users WHERE id = ?", [record.user_id]);
  return res.json({ valid: true, name: user?.name });
});

module.exports = router;
