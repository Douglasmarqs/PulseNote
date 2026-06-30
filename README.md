# BookVerse — Esqueleto da aplicação

Este é o ponto de partida real do BookVerse: projeto React + Firebase rodando
de ponta a ponta, com autenticação e o primeiro fluxo de navegação completo.
A partir daqui, cada módulo do Blueprint (Biblioteca, Leitura, Gamificação,
Lumi, Social…) entra como uma seção nova, sem precisar reescrever o que já
existe.

## O que já funciona

- Splash → Onboarding (3 pilares) → Cadastro/Login → Dashboard
- Autenticação por e-mail/senha (Firebase Auth)
- Criação automática do perfil do usuário no Firestore ao cadastrar
- Rotas protegidas (Dashboard e Biblioteca exigem login)
- **Biblioteca**: busca de livros por título/autor combinando **Google
  Books API** (fonte principal — capa, sinopse, categorias) e **Open
  Library** (complemento automático: entra quando o Google retorna poucos
  resultados ou falha, aumentando a variedade e dando resiliência caso uma
  das duas APIs fique fora do ar), cadastro manual como última alternativa,
  filtro por status, sincronização em tempo real entre dispositivos
- **Detalhe do livro**: mostra capa e sinopse quando disponíveis, atualizar
  página atual, marcar como concluído, remover da biblioteca
- **Lumi**: primeira versão da mascote — avatar visual próprio (consistente
  com a identidade do logo) e mensagens contextuais baseadas em regras
  simples sobre seus dados reais de leitura (streak, meta do dia, livro em
  andamento). Aparece em destaque no Dashboard e tem uma aba própria. **Não
  é IA** ainda — isso é deixado claro tanto no código quanto na própria
  tela, para não prometer algo que não existe
- **Dashboard real**: sequência de leitura (streak), páginas lidas hoje
  vs. meta diária (fixa em 20 páginas por enquanto), total de páginas e
  livros concluídos, atalho "Continue lendo" pros livros em andamento
- **PWA**: o BookVerse pode ser instalado na tela inicial (Android, iOS e
  desktop), funciona com tela cheia (sem barra de navegador), tem ícone
  próprio, e atualiza sozinho quando uma nova versão é publicada — com
  aviso na tela para o usuário recarregar
- **Configurações**: tema Claro/Escuro/Automático (sincronizado entre
  dispositivos via Firestore, com o "Automático" acompanhando o tema do
  sistema operacional em tempo real), meta diária de páginas ajustável
  (substitui o valor fixo do Dashboard), toggle de notificações (a
  preferência já é salva; o envio de push de verdade ainda não existe)
- Navegação inferior compartilhada (`AppShell`) entre Dashboard e Biblioteca,
  com atalho de engrenagem no cabeçalho para abrir as Configurações
- **Validação server-side (Cloud Functions)**: streak, páginas lidas e
  livros concluídos agora são calculados e gravados por uma Cloud Function,
  não mais pelo navegador — fecha a brecha de alguém forjar esses valores
  direto no console do DevTools. Veja a seção "Cloud Functions" mais abaixo
  — **esta é a única mudança deste pacote que exige uma ação extra sua além
  de colar regras no console** (requer publicar a função antes das regras).
- **Login com Google** (Login e Cadastro) e **recuperação de senha por
  e-mail**. O login com Apple não foi implementado — exige inscrição paga
  no Apple Developer Program (US$ 99/ano), então não fazia sentido
  construir um botão que não funcionaria sem essa conta.
- Sistema de tokens visuais provisório (`src/styles/tokens.css`) — cores,
  tipografia (Fraunces + Inter + JetBrains Mono) e o elemento de assinatura
  (a "fita de marcador de página")
- Regras de segurança do Firestore cobrindo perfil, biblioteca pessoal e
  registro diário de leitura
- Responsivo de 320px a desktop, sem scroll horizontal

## O que NÃO está aqui ainda (de propósito)

2FA, envio de notificações push de verdade (a preferência já é salva,
falta o sistema de envio — Documento 25), e os módulos de Social/
Gamificação (as abas "Social" e "Perfil" aparecem na navegação, mas ainda
não levam a nenhuma tela — isso é intencional, não é bug). A Lumi existe,
mas só com mensagens baseadas em regras simples — chat e recomendação por
IA de verdade (Documento 13) ainda não foram construídos. Login com Apple
não está planejado para este projeto (ver acima — exige conta paga).

A validação server-side (Cloud Functions) cobre o caso mais óbvio de abuso
— forjar streak/páginas lidas — mas não é o módulo de segurança completo:
ainda faltam App Check, uma função agendada para resetar o streak à meia-
noite (hoje isso só é "escondido" na tela, não corrigido no banco), rate
limiting mais sofisticado, e Storage rules (ainda nem existe upload de
arquivo no projeto).

## Se você já tinha o projeto Firebase configurado antes desta atualização

O login com Google só funciona depois de um passo manual no Console: vá em
**Authentication → Sign-in method → Google → Ativar**, escolha um e-mail de
suporte do projeto quando solicitado, e salve. Sem isso, o botão "Continuar
com Google" no app vai retornar um erro de operação não permitida. Nenhuma
mudança de regras do Firestore é necessária para isso — é só essa ativação
do provedor.

## Sobre a busca de livros (Google Books + Open Library)

A busca usa a Google Books API como fonte principal, sem exigir chave —
funciona normalmente sem nenhuma configuração extra. A Open Library entra
automaticamente como complemento (resultados extras quando o Google traz
pouca coisa, ou substituta se o Google falhar) — também sem exigir chave.

Se em algum momento a busca via Google começar a ser bloqueada por limite
de requisições (uso muito intenso), gere uma chave gratuita no [Google
Cloud Console](https://console.cloud.google.com) (ative a "Books API" no
projeto, crie uma credencial do tipo "Chave de API") e adicione em `.env`
como `VITE_GOOGLE_BOOKS_API_KEY`. Sem isso, tudo já funciona — essa chave é
só uma rede de segurança para uso mais pesado. A Open Library não tem
equivalente de chave — é sempre gratuita e sem limite documentado.

## Sobre o PWA — como testar a instalação de verdade

O prompt de instalação só aparece quando o navegador considera o app
"instalável", o que exige HTTPS (ou `localhost`, que conta como exceção).
Rodando com `npm run dev` em `localhost:5173` já funciona para testar no
Chrome/Edge do computador. Para testar no celular (instalação real na tela
inicial), o jeito mais simples é publicar o build (`npm run build` gera a
pasta `dist/`) em um serviço como Vercel, Netlify ou Firebase Hosting —
qualquer um deles já serve com HTTPS automaticamente.

No iPhone (Safari), a instalação não usa o prompt automático — o usuário
precisa tocar em **Compartilhar → Adicionar à Tela de Início**. O app já
mostra essa instrução automaticamente quando detecta iOS.

## Como rodar

### 1. Pré-requisitos
- Node.js 18 ou mais recente

### 2. Instalar dependências
```bash
npm install
```

### 3. Criar um projeto Firebase
1. Acesse https://console.firebase.google.com e crie um projeto.
2. Em **Build → Authentication → Sign-in method**, ative os provedores
   **E-mail/senha** e **Google** (no Google, basta escolher um e-mail de
   suporte do projeto quando solicitado — não exige nenhuma configuração
   extra para funcionar em desenvolvimento).
3. Em **Build → Firestore Database**, crie o banco (modo produção).
4. Em **Configurações do projeto → Seus apps**, adicione um app Web e copie
   as credenciais.

### 4. Configurar variáveis de ambiente
```bash
cp .env.example .env
```
Preencha o `.env` com as credenciais copiadas no passo anterior.

### 5. Publicar as regras de segurança e a Cloud Function
Esta etapa mudou: as regras atuais dependem de uma Cloud Function já estar
publicada (sem ela, o streak e as páginas lidas nunca seriam gravados,
porque as regras bloqueiam essa escrita vindo do navegador). Siga a seção
**"Cloud Functions — validação server-side"** mais abaixo neste README,
nesta ordem: publique a função primeiro, confirme que funcionou, e só
depois publique `firestore.rules` no Console Firebase.

### 6. Rodar o projeto
```bash
npm run dev
```
Acesse o endereço mostrado no terminal (normalmente `http://localhost:5173`).

## Estrutura de pastas

```
functions/          # Cloud Functions (Node) — validação server-side
│                    # do progresso de leitura (ver seção própria abaixo)
firebase.json        # Configuração da Firebase CLI (rules + functions)
public/
├── favicon.png
└── icons/           # icon-192, icon-512, icon-maskable-512, apple-touch-icon
src/
├── components/      # Button, Field, BookVerseLogo, AppShell, Modal,
│                     # BookCard, ProgressBar, InstallPrompt, UpdateToast,
│                     # LumiAvatar, GoogleIcon, GoogleSignInButton
├── context/         # AuthContext, ThemeContext
├── firebase/        # config.js — inicialização do Firebase
├── hooks/           # useReadingStats.js — stats/meta/streak compartilhados
├── pages/           # Splash, Onboarding, Login, Cadastro, RecuperarSenha,
│                     # Dashboard, Biblioteca, LivroDetalhe, Configuracoes,
│                     # Lumi
├── routes/          # ProtectedRoute
├── services/        # libraryService.js (CRUD do livro — sem mais escrita
│                     # de stats, isso agora é da Cloud Function),
│                     # booksApiService.js (Google Books + Open Library),
│                     # lumiService.js (mensagens contextuais por regras)
└── styles/          # tokens.css (design system) + global.css
```

## Cloud Functions — validação server-side (leia antes de publicar regras novas)

Até agora, o streak e as páginas lidas eram calculados pelo próprio
navegador e gravados direto no Firestore. Isso tem um problema de
segurança real: qualquer pessoa com um mínimo de conhecimento técnico pode
abrir o DevTools do navegador (F12) e escrever qualquer valor diretamente
no Firestore via SDK, forjando um streak de 500 dias do nada.

A partir desta versão, esse cálculo passa a rodar numa **Cloud Function**
(`functions/index.js`), que usa o Admin SDK do Firebase — esse SDK roda no
servidor e ignora as regras de segurança do Firestore, então é o único
lugar em que dá pra confiar que o valor gravado reflete avanço de leitura
real.

### Importante: isso exige o plano Blaze (pago por uso)

Cloud Functions **não funcionam no plano gratuito (Spark)** do Firebase —
é uma exigência do próprio Google, não uma escolha deste projeto. Você
precisa fazer upgrade para o plano **Blaze** (pay-as-you-go).

Isso assusta menos do que parece: o Blaze tem uma cota gratuita generosa
(2 milhões de invocações de função por mês, entre outras) — para um
projeto pessoal ou acadêmico, é extremamente improvável que você seja
cobrado algo. Você só paga se ultrapassar a cota gratuita. Ainda assim, o
Google exige um cartão de crédito cadastrado para liberar o plano, mesmo
que você nunca seja cobrado.

Para fazer o upgrade: **Console Firebase → ícone de engrenagem →
Uso e faturamento → Detalhes e configurações do plano → Modificar plano →
Blaze**.

### Passo a passo — siga NESTA ORDEM

A ordem importa: se você publicar as regras novas do Firestore antes de a
função estar no ar, o streak para de atualizar até a função ser publicada
(porque ninguém mais vai ter permissão de escrever em `stats`).

**1. Instale a Firebase CLI** (se ainda não tiver):
```bash
npm install -g firebase-tools
```

**2. Faça login:**
```bash
firebase login
```
Isso abre o navegador para você autorizar com a mesma conta Google do
projeto Firebase.

**3. Conecte a pasta do projeto ao seu projeto Firebase:**
```bash
firebase use --add
```
Escolha o projeto BookVerse na lista, e dê um apelido como `default` quando
perguntado. Isso cria um arquivo `.firebaserc` local (não vem no zip,
porque é específico do seu projeto).

**4. Instale as dependências da função:**
```bash
cd functions
npm install
cd ..
```

**5. Publique SÓ a função primeiro:**
```bash
firebase deploy --only functions
```
Isso pode levar 1-3 minutos na primeira vez. No final, o terminal mostra
algo como `✔ functions[onBookProgressUpdate(...)]: Successful create
operation.`

**6. Confirme que funcionou:** abra o app, atualize a página de um livro
(registre algumas páginas lidas), depois vá no **Console Firebase →
Build → Functions → Logs** e veja se aparece uma execução recente da
`onBookProgressUpdate` sem erro.

**7. SÓ AGORA publique as regras novas do Firestore** — mesmo processo de
sempre (Console Firebase → Firestore Database → Regras → colar o conteúdo
atualizado de `firestore.rules` → Publicar). A partir daqui, o cliente
perde a permissão de escrever em `stats`/`readingLog`, e só a função
consegue.

### O que NÃO está coberto ainda (mesmo depois deste passo)

Isto é uma primeira camada, não o módulo de segurança completo
(Documento 11). Ainda faltam: App Check (proteção contra bots/scripts
automatizados chamando a API do Firebase fora do app), uma função
agendada para resetar o streak à meia-noite (hoje isso é só "escondido" na
exibição, não corrigido no banco até a próxima leitura), rate limiting
mais sofisticado, e validação de schema mais rígida nas regras (hoje só
valida os campos principais do livro, não todos).

## Publicando na Vercel

O projeto não precisa de nenhuma configuração especial — é um app Vite
padrão. Ao importar o repositório na Vercel, ela detecta automaticamente:

- **Build Command**: `npm run build` (ou `vite build`)
- **Output Directory**: `dist`

O único passo manual é configurar as variáveis de ambiente na Vercel
(**Settings → Environment Variables**), usando os mesmos nomes e valores do
seu arquivo `.env` local (`VITE_FIREBASE_API_KEY`, `VITE_FIREBASE_AUTH_DOMAIN`,
etc.). Sem isso, o build até funciona, mas o app sobe sem conseguir falar
com o Firebase.

Depois do primeiro deploy, vale também adicionar o domínio gerado pela
Vercel (algo como `bookverse.vercel.app`) em **Firebase Console →
Authentication → Settings → Domínios autorizados** — sem isso, o login pode
ser bloqueado por segurança em produção.

## Próximos passos sugeridos

1. **Sistema de Design formal** (Documento 07), validando ou ajustando os
   tokens e o ícone provisórios criados aqui.
2. **Sistema Social** e **Ranking** — Documentos 15 e 16.
3. **IA de verdade para a Lumi** (Documento 13) — chat e recomendação.
4. **2FA** e central de sessões/dispositivos conectados — Documento 11.
