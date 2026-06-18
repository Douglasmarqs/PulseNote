# PulseNote — Firebase Edition

Aplicativo de produtividade pessoal com login, cadastro, recuperação de senha
e armazenamento em nuvem via **Google Firebase**.

---

## Por que Firebase em vez de servidor próprio?

| | Antes (Express + SQLite) | Agora (Firebase) |
|---|---|---|
| Banco de dados | Arquivo local, você gerencia backup | Banco em nuvem gerenciado pelo Google |
| Segurança dos dados | Criptografia manual no código | Regras de segurança aplicadas pelo próprio servidor do Firebase — impossível burlar via JavaScript |
| Servidor | Precisa rodar `node server.js` sempre | Não existe servidor — tudo roda direto no navegador |
| Reset de senha | E-mail customizado (SMTP) | Firebase envia e gerencia o link automaticamente |
| Sincronização entre dispositivos | Manual (polling) | Tempo real automático |
| Custo | Você precisa hospedar o backend | Gratuito até 50 mil leituras/dia (mais que suficiente) |

---

## Fluxo das telas (como tudo se conecta)

```
                    ┌─────────────────┐
                    │   login.html    │ ◄──────────────────┐
                    │  (Entrar/Criar) │                     │
                    └────────┬────────┘                     │
                             │                               │
              ┌──────────────┼──────────────┐                │
              │              │              │                │
       login OK         cadastro OK    "Esqueci senha"        │
              │              │              │                │
              ▼              ▼              ▼                │
        ┌──────────────────────┐   ┌─────────────────────┐   │
        │      index.html       │   │ forgot-password.html│   │
        │   (App principal)     │   └──────────┬──────────┘   │
        │                        │              │ envia e-mail │
        │  🚪 Botão "Sair" no    │              ▼              │
        │  menu de perfil ───────┼──────────────┴──────────────┘
        └────────────────────────┘
                 │
                 │ usuário clica no link do e-mail
                 ▼
        (página de redefinição hospedada pelo
         próprio Firebase — segura e automática)
                 │
                 ▼
            volta para login.html
```

**Proteções automáticas:**
- Se você abrir `index.html` sem estar logado → redireciona para `login.html`
- Se você abrir `login.html` já estando logado → redireciona direto para `index.html`
- O botão **Sair** (🚪) está em dois lugares: no menu do avatar (topo direito) e dentro do modal "Meu perfil"

---

## Passo a passo — configurar seu Firebase (gratuito, ~5 minutos)

### 1. Criar o projeto
1. Acesse **https://console.firebase.google.com**
2. Clique em **"Adicionar projeto"**
3. Dê um nome (ex.: `pulsenote-douglas`) e siga os passos (pode desativar o Google Analytics, não é necessário)

### 2. Ativar a Autenticação
1. No menu lateral: **Build → Authentication**
2. Clique em **"Vamos começar"**
3. Selecione **"E-mail/senha"** na lista de provedores
4. Ative a primeira opção (E-mail/senha) e clique em **Salvar**

### 3. Criar o banco de dados (Firestore)
1. No menu lateral: **Build → Firestore Database**
2. Clique em **"Criar banco de dados"**
3. Escolha a localização mais próxima (ex.: `southamerica-east1` para Brasil)
4. Inicie em **modo de produção**

### 4. Aplicar as regras de segurança
1. Ainda no Firestore, vá na aba **"Regras"**
2. Apague o conteúdo padrão e cole o conteúdo do arquivo **`firestore.rules`** (está na raiz deste projeto)
3. Clique em **"Publicar"**

Isso garante que **cada usuário só pode ler/escrever os próprios dados** —
mesmo que alguém manipule o código JavaScript do site, o Firebase bloqueia
no servidor.

### 5. Registrar o app Web e copiar as credenciais
1. Vá em **⚙️ (engrenagem) → Configurações do projeto**
2. Role até **"Seus apps"** e clique no ícone **`</>`** (Web)
3. Dê um nome (ex.: `PulseNote Web`) e clique em **Registrar app**
4. Copie o objeto `firebaseConfig` que aparece

### 6. Colar as credenciais no projeto
Abra o arquivo **`src/firebase-config.js`** e substitua:

```js
export const firebaseConfig = {
  apiKey: "SUA_API_KEY_AQUI",
  authDomain: "seu-projeto.firebaseapp.com",
  projectId: "seu-projeto",
  storageBucket: "seu-projeto.appspot.com",
  messagingSenderId: "000000000000",
  appId: "1:000000000000:web:xxxxxxxxxxxxxxxxxxxx",
};
```

pelos valores reais copiados no passo anterior.

---

## Como rodar localmente

Como o app usa módulos ES6 (`import`/`export`), ele precisa ser servido por
um servidor HTTP simples (não funciona abrindo o arquivo `.html` direto, tipo
`file://`, por restrição de segurança do navegador).

### Opção A — usando Python (já vem instalado na maioria dos sistemas)
```bash
cd src
python3 -m http.server 5500
```
Acesse: **http://localhost:5500/login.html**

### Opção B — usando a extensão "Live Server" do VS Code
1. Instale a extensão **Live Server**
2. Clique com o botão direito em `src/login.html`
3. Selecione **"Open with Live Server"**

### Opção C — usando Node.js
```bash
cd src
npx serve .
```

---

## Publicar online (gratuito)

A forma mais simples é usar o próprio **Firebase Hosting**:

```bash
npm install -g firebase-tools
firebase login
firebase init hosting
# Quando perguntar a pasta pública, digite: src
firebase deploy
```

Em poucos segundos você recebe uma URL pública tipo
`https://seu-projeto.web.app` já com HTTPS automático.

---

## Estrutura do projeto

```
PulseNote-Firebase/
├── firestore.rules          ← Regras de segurança (cole no Firebase Console)
└── src/
    ├── login.html            ← Tela de login + cadastro
    ├── forgot-password.html  ← Recuperação de senha
    ├── index.html             ← App principal (protegido por login)
    ├── firebase-config.js     ← SUAS credenciais do Firebase (edite aqui)
    ├── firebase-init.js       ← Inicialização do Firebase (não precisa editar)
    ├── auth.js                ← Lógica de login/cadastro/reset
    ├── app.js                  ← Lógica do app (notas, tarefas, finanças, sync)
    ├── auth.css                ← Estilos das telas de autenticação
    └── styles.css              ← Estilos do app principal
```

---

## Segurança — o que está implementado

- **Senhas:** nunca tocam no seu código — o Firebase Authentication processa
  tudo (hash, salt, validação) nos servidores do Google.
- **Dados por usuário:** cada conta tem um documento isolado no Firestore,
  identificado pelo UID único gerado pelo Firebase — impossível um usuário
  ver dados de outro.
- **Regras no servidor:** a validação de "este dado pertence a este usuário"
  acontece no Firestore, não no navegador — não pode ser burlada inspecionando
  o código.
- **Reset de senha:** o link expira automaticamente e só pode ser usado uma vez,
  gerenciado inteiramente pelo Firebase.
- **Troca de senha:** exige reautenticação (senha atual) antes de permitir
  definir uma nova — protege contra sessões roubadas.
- **Tráfego:** todo o tráfego com o Firebase é HTTPS por padrão.

---

## Limites do plano gratuito (Spark)

Mais do que suficiente para uso pessoal ou um grupo pequeno:
- 50.000 leituras/dia no Firestore
- 20.000 escritas/dia
- 10 GB de armazenamento
- Autenticação ilimitada

Se um dia precisar de mais, o plano pago (Blaze) só cobra pelo que exceder
esses limites gratuitos.
