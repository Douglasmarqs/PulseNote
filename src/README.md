# PulseNote — Full Stack

Aplicativo de produtividade pessoal com autenticação, banco de dados e sincronização por usuário.

## Stack

| Camada   | Tecnologia                         |
|----------|------------------------------------|
| Frontend | HTML + CSS + Vanilla JS            |
| Backend  | Node.js + Express                  |
| Banco    | SQLite (via sql.js — sem compilar) |
| Auth     | JWT + bcrypt                       |
| Email    | Nodemailer (Ethereal em dev)       |

---

## Estrutura do projeto

```
PulseNote-Full/
├── backend/
│   ├── server.js          ← Servidor Express principal
│   ├── db.js              ← SQLite (sql.js)
│   ├── mailer.js          ← Envio de e-mails
│   ├── middleware/
│   │   └── auth.js        ← Verificação JWT
│   ├── routes/
│   │   ├── auth.js        ← Login, registro, reset de senha
│   │   └── data.js        ← Sync de dados por usuário
│   ├── .env.example       ← Copie para .env e configure
│   └── package.json
└── frontend/
    └── src/
        ├── index.html     ← App principal (requer login)
        ├── login.html     ← Login + Cadastro
        ├── forgot-password.html
        ├── reset-password.html
        ├── app.js         ← Lógica do app
        ├── auth.js        ← Lógica de autenticação
        ├── styles.css     ← Estilos do app
        └── auth.css       ← Estilos das telas de auth
```

---

## Como rodar

### 1. Instalar dependências

```bash
cd backend
npm install
```

### 2. Configurar variáveis de ambiente

```bash
cp .env.example .env
# Edite o .env se quiser (não é obrigatório para dev)
```

### 3. Iniciar o servidor

```bash
npm start
# ou para hot-reload:
node --watch server.js
```

### 4. Acessar o app

Abra: **http://localhost:3001/login.html**

O servidor serve os arquivos estáticos do frontend automaticamente.

---

## Funcionalidades de autenticação

### Cadastro
- Nome, e-mail e senha
- Validação de campos
- Senha com mínimo 6 caracteres
- E-mail duplicado detectado
- E-mail de boas-vindas enviado

### Login
- JWT com validade de 7 dias
- Mensagem de erro genérica (segurança)
- Redirecionamento automático

### Redefinição de senha
1. Usuário clica em "Esqueci minha senha"
2. Informa o e-mail cadastrado
3. Servidor gera token com validade de **30 minutos**
4. Link de reset enviado por e-mail

Em **modo desenvolvimento**, o link aparece direto no terminal — não precisa configurar SMTP.

5. Usuário clica no link → cria nova senha
6. Token é invalidado após uso

### Perfil
- Alterar nome
- Alterar senha (com confirmação da senha atual)
- Avatar com inicial do nome

---

## Configurar e-mail real (produção)

Edite o `.env`:

```env
# Gmail (use Senha de App, não a senha normal)
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=seu@gmail.com
SMTP_PASS=xxxx xxxx xxxx xxxx
SMTP_FROM=PulseNote <seu@gmail.com>
```

Para gerar uma Senha de App no Gmail:
1. Acesse myaccount.google.com
2. Segurança → Verificação em duas etapas → Senhas de app
3. Crie uma senha para "Outro aplicativo"

---

## Banco de dados

O arquivo `pulsenote.db` é criado automaticamente na pasta `backend/`.
Não precisa de nenhuma configuração. As tabelas são criadas na primeira execução.

### Tabelas

- **users** — id, name, email, password (hash), avatar, created_at
- **reset_tokens** — token, user_id, expires_at, used
- **user_data** — user_id, data (JSON com notas/tarefas/metas/finanças)

---

## Segurança

- Senhas com bcrypt (salt rounds: 12)
- JWT assinado com chave secreta (configure `JWT_SECRET` em produção)
- Rate limiting nas rotas de auth (20 req/15min)
- Tokens de reset expiram em 30 minutos e são invalidados após uso
- E-mail de reset não revela se o usuário existe

---

## Deploy (produção)

### Variáveis de ambiente obrigatórias:

```env
PORT=3001
JWT_SECRET=uma-chave-muito-longa-e-aleatoria
FRONTEND_URL=https://seudominio.com
ALLOWED_ORIGIN=https://seudominio.com
SMTP_HOST=...
```

### Plataformas sugeridas:
- **Backend:** Railway, Render, Fly.io, VPS
- **Frontend:** pode ser servido pelo próprio Express (já configurado) ou separado via Vercel/Netlify
