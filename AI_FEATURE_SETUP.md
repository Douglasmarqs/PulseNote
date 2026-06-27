# Ativando o "Lançar por texto (IA)" em Finanças

Esse recurso precisa de duas coisas que só você pode gerar (são chaves
ligadas à sua conta — eu não tenho acesso a elas): uma chave da API da
Anthropic, e uma credencial de serviço do seu projeto Firebase. Sem isso
configurado, o botão "Preencher" mostra um aviso amigável e a IA simplesmente
não é chamada — o resto do app continua funcionando normalmente.

## 1. Chave da Anthropic (a IA que entende o texto)

1. Acesse https://console.anthropic.com/ e crie uma conta (ou faça login).
2. Vá em **API Keys** → **Create Key**.
3. Copie a chave (algo como `sk-ant-...`).
4. **Recomendado:** em **Settings → Limits**, defina um limite mensal de
   gastos (ex.: US$5) para nunca ter surpresa na fatura.

## 2. Credencial do Firebase (pra confirmar que quem chama a IA é um usuário de verdade logado no PulseNote)

1. No [Firebase Console](https://console.firebase.google.com/), abra o
   projeto `pulsenote-f99e2`.
2. **Project Settings** (engrenagem) → aba **Service Accounts**.
3. Clique em **Generate new private key** → confirma o download de um
   arquivo `.json`.
4. Abra esse arquivo. Você vai precisar de 3 campos dele: `project_id`,
   `client_email` e `private_key`.

⚠️ Esse arquivo dá acesso administrativo total ao seu Firebase — nunca o
suba para o GitHub nem o coloque dentro de `src/`. Ele só deve existir como
variável de ambiente na Vercel (próximo passo).

## 3. Configurar as variáveis de ambiente na Vercel

No painel do seu projeto na Vercel: **Settings → Environment Variables**,
adicione estas 4 (em Production, e também em Preview se você testa por lá):

| Nome | Valor |
|---|---|
| `ANTHROPIC_API_KEY` | a chave do passo 1 |
| `FIREBASE_PROJECT_ID` | o `project_id` do JSON |
| `FIREBASE_CLIENT_EMAIL` | o `client_email` do JSON |
| `FIREBASE_PRIVATE_KEY` | o `private_key` do JSON (cole tudo, incluindo `-----BEGIN PRIVATE KEY-----` e `-----END PRIVATE KEY-----`) |

Depois de salvar, faça um **redeploy** (a Vercel não aplica variáveis novas
em deploys já existentes).

## 4. Testar

1. Abra o app → **Finanças**.
2. No campo "✨ Lançar por texto", escreva algo como `almoço 32 reais ontem`.
3. Toque em **Preencher** — os campos do formulário abaixo devem se preencher
   sozinhos (valor, categoria, descrição, data).
4. Confira os dados e só então toque em **Registrar** — nada é salvo sem essa
   confirmação manual.

Se aparecer um aviso de erro, normalmente é uma das variáveis acima ausente
ou com valor errado — confira no log da função em **Vercel → seu projeto →
Logs** (filtre por `/api/parse-transaction`) para ver a mensagem exata.
