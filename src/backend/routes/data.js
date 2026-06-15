// routes/data.js — sync user app data to the database
const express = require("express");
const router = express.Router();

const { get, run } = require("../db");
const { requireAuth } = require("../middleware/auth");

// ── GET /api/data ────────────────────────────────────────────
// Load the user's full app state
router.get("/", requireAuth, (req, res) => {
  const row = get("SELECT data FROM user_data WHERE user_id = ?", [req.user.id]);
  if (!row) {
    // Create empty record if missing
    run("INSERT INTO user_data (user_id, data) VALUES (?, ?)", [req.user.id, "{}"]);
    return res.json({ data: {} });
  }
  try {
    return res.json({ data: JSON.parse(row.data) });
  } catch {
    return res.json({ data: {} });
  }
});

// ── PUT /api/data ────────────────────────────────────────────
// Save (overwrite) the user's full app state
router.put("/", requireAuth, (req, res) => {
  try {
    const { data } = req.body;
    if (data === undefined) {
      return res.status(400).json({ error: "Campo 'data' é obrigatório." });
    }

    const json = JSON.stringify(data);
    const existing = get("SELECT id FROM user_data WHERE user_id = ?", [req.user.id]);

    if (existing) {
      run(
        "UPDATE user_data SET data = ?, updated_at = datetime('now') WHERE user_id = ?",
        [json, req.user.id]
      );
    } else {
      run(
        "INSERT INTO user_data (user_id, data) VALUES (?, ?)",
        [req.user.id, json]
      );
    }

    return res.json({ message: "Dados salvos.", updated_at: new Date().toISOString() });
  } catch (err) {
    console.error("Save data error:", err);
    return res.status(500).json({ error: "Erro ao salvar dados." });
  }
});

module.exports = router;
