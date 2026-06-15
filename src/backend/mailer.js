// mailer.js — Nodemailer setup
const nodemailer = require("nodemailer");

function createTransporter() {
  // Production: use real SMTP via .env
  if (process.env.SMTP_HOST) {
    return nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: parseInt(process.env.SMTP_PORT || "587"),
      secure: process.env.SMTP_SECURE === "true",
      auth: {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASS,
      },
    });
  }

  // Development: Ethereal (fake SMTP — logs emails in terminal)
  return null; // will be created async on first use
}

let transporter = createTransporter();

async function getTransporter() {
  if (transporter) return transporter;
  // Create Ethereal test account for dev
  const testAccount = await nodemailer.createTestAccount();
  transporter = nodemailer.createTransport({
    host: "smtp.ethereal.email",
    port: 587,
    secure: false,
    auth: {
      user: testAccount.user,
      pass: testAccount.pass,
    },
  });
  console.log("📧 Dev email account:", testAccount.user);
  return transporter;
}

async function sendResetEmail(toEmail, toName, resetUrl) {
  const t = await getTransporter();

  const info = await t.sendMail({
    from: `"PulseNote" <${process.env.SMTP_FROM || "no-reply@pulsenote.app"}>`,
    to: toEmail,
    subject: "🔑 Redefinir sua senha — PulseNote",
    html: `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="utf-8"/>
        <style>
          body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background:#f5f7fa; margin:0; padding:24px; }
          .card { max-width:480px; margin:0 auto; background:#fff; border-radius:24px; padding:40px; box-shadow:0 4px 24px rgba(0,0,0,.08); }
          .logo { display:flex; align-items:center; gap:12px; margin-bottom:32px; }
          .logo-mark { width:48px; height:48px; border-radius:14px; background:linear-gradient(145deg,#4f8ef7,#af52de); display:flex; align-items:center; justify-content:center; }
          h1 { font-size:1.5rem; font-weight:800; color:#1a1f2e; margin:0 0 8px; }
          p { color:#4a5568; line-height:1.6; margin:0 0 20px; }
          .btn { display:inline-block; padding:14px 32px; background:linear-gradient(135deg,#4f8ef7,#af52de); color:#fff; text-decoration:none; border-radius:14px; font-weight:700; font-size:1rem; }
          .note { font-size:.82rem; color:#8a9bb0; margin-top:24px; }
          .divider { border:none; border-top:1px solid #e8ecf2; margin:24px 0; }
        </style>
      </head>
      <body>
        <div class="card">
          <div class="logo">
            <div class="logo-mark"><span style="color:#fff;font-size:1.2rem">⚡</span></div>
            <strong style="font-size:1.1rem;color:#1a1f2e">PulseNote</strong>
          </div>
          <h1>Olá, ${toName}! 👋</h1>
          <p>Recebemos uma solicitação para redefinir a senha da sua conta PulseNote.</p>
          <p>Clique no botão abaixo para criar uma nova senha. Este link é válido por <strong>30 minutos</strong>.</p>
          <a href="${resetUrl}" class="btn">🔑 Redefinir minha senha</a>
          <hr class="divider"/>
          <p class="note">Se você não solicitou a redefinição de senha, ignore este e-mail. Sua conta continua segura.</p>
          <p class="note">Link direto: <a href="${resetUrl}">${resetUrl}</a></p>
        </div>
      </body>
      </html>
    `,
  });

  // In dev, print preview URL
  const previewUrl = nodemailer.getTestMessageUrl(info);
  if (previewUrl) {
    console.log(`\n📧 Email de reset enviado!`);
    console.log(`🔗 Visualizar em: ${previewUrl}\n`);
  }

  return info;
}

async function sendWelcomeEmail(toEmail, toName) {
  const t = await getTransporter();

  const info = await t.sendMail({
    from: `"PulseNote" <${process.env.SMTP_FROM || "no-reply@pulsenote.app"}>`,
    to: toEmail,
    subject: "🎉 Bem-vindo ao PulseNote!",
    html: `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="utf-8"/>
        <style>
          body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background:#f5f7fa; margin:0; padding:24px; }
          .card { max-width:480px; margin:0 auto; background:#fff; border-radius:24px; padding:40px; box-shadow:0 4px 24px rgba(0,0,0,.08); }
          h1 { font-size:1.5rem; font-weight:800; color:#1a1f2e; margin:0 0 8px; }
          p { color:#4a5568; line-height:1.6; margin:0 0 16px; }
          .feature { display:flex; gap:12px; align-items:flex-start; margin-bottom:12px; }
          .feature-icon { font-size:1.4rem; }
          .feature-text strong { display:block; color:#1a1f2e; font-weight:700; }
          .feature-text span { color:#8a9bb0; font-size:.86rem; }
        </style>
      </head>
      <body>
        <div class="card">
          <h1>Seja bem-vindo, ${toName}! 🎉</h1>
          <p>Sua conta PulseNote está pronta. Aqui está o que você pode fazer:</p>
          <div class="feature"><div class="feature-icon">📝</div><div class="feature-text"><strong>Anotações</strong><span>Notas coloridas estilo post-it com checklist</span></div></div>
          <div class="feature"><div class="feature-icon">✅</div><div class="feature-text"><strong>Tarefas</strong><span>Quadro kanban com drag & drop</span></div></div>
          <div class="feature"><div class="feature-icon">💰</div><div class="feature-text"><strong>Finanças</strong><span>Controle de receitas e despesas por categoria</span></div></div>
          <div class="feature"><div class="feature-icon">🎯</div><div class="feature-text"><strong>Metas</strong><span>Acompanhe seu progresso com gamificação</span></div></div>
          <p style="margin-top:24px;color:#8a9bb0;font-size:.82rem">Bom proveito! 🚀</p>
        </div>
      </body>
      </html>
    `,
  });

  const previewUrl = nodemailer.getTestMessageUrl(info);
  if (previewUrl) console.log(`📧 Boas-vindas: ${previewUrl}`);
}

module.exports = { sendResetEmail, sendWelcomeEmail };
