# BookVerse — Relatório de Status do Projeto

**Data:** 30/06/2026
**Objetivo deste documento:** comparar honestamente o que já foi construído contra o que foi planejado nos documentos originais (Blueprint de ~35 seções, 500 páginas, 90+ telas), sem inflar números nem esconder lacunas.

---

## 1. Resumo executivo (leia isto primeiro)

O projeto está na fase de **fundação técnica**, não na fase de "produto completo". O que existe hoje é um esqueleto **real, funcional e de qualidade profissional** (não tem cara de projeto acadêmico) — mas cobre uma fração pequena do escopo total que você descreveu no planejamento inicial.

Em números honestos:
- **Telas nomeadas no planejamento original:** ~46 (o número "90+" citado nas conversas iniciais era um chute de brainstorm, nunca uma lista fechada)
- **Telas construídas e funcionando:** 7
- **Pilares do produto (Hábito, Identidade, IA, Social, Acabamento) com algo implementado:** 2 de 5 (Hábito parcialmente, Acabamento parcialmente)
- **Funcionalidades "alma do produto" ainda em zero:** API de livros, IA (Lumi), Sistema Social, Ranking, Gamificação

Isso não é um sinal de que o projeto não vai dar certo — é o estado normal de um produto desse porte nesta altura. Mas é importante você ter clareza disso antes de pensar em prazos ou em apresentar isso como produto pronto.

---

## 2. O que já foi entregue (detalhado)

### 2.1 Documentação (Volume 1 do Blueprint)
- **Documento 01 — Visão Geral**: escrito por completo (missão, pilares, personas, critérios de sucesso). Os demais 34 documentos do Blueprint (Arquitetura, Tecnologias, Design System formal, Banco de Dados, etc.) **ainda não foram escritos** — o que existe de arquitetura está implícito no código, não documentado formalmente.

### 2.2 Autenticação e conta
- Cadastro e login por e-mail/senha (Firebase Auth)
- Criação automática do documento de perfil no Firestore (`users/{uid}`)
- Rotas protegidas (telas internas exigem login)
- Logout

**Não implementado:** login social (Google/Apple), recuperação de senha, confirmação de e-mail, 2FA, gerenciamento de sessões/dispositivos conectados — todo o "módulo Segurança" do seu documento de Minha Conta.

### 2.3 Biblioteca e Leitura
- Cadastro **manual** de livro (título, autor, total de páginas)
- Lista com filtro por status (Quero ler / Lendo / Concluído)
- Atualização de progresso por página
- Sincronização em tempo real entre dispositivos (Firestore `onSnapshot`)

**Não implementado:** busca de livros por API externa, capas de livro reais, sinopse/metadados, sistema de capítulos, qualquer "descoberta" de novos títulos.

### 2.4 Dashboard
- Sequência de leitura (streak), calculada de forma honesta (zera visualmente se não há leitura hoje/ontem)
- Páginas lidas hoje vs. meta diária configurável
- Total de páginas e livros concluídos
- Atalho "Continue lendo"

**Não implementado:** heatmap (estilo GitHub), calendário, timeline de eventos, qualquer estatística além das 3 mostradas (gênero favorito, autor mais lido, horário de leitura, etc. — tudo isso citado no planejamento original).

### 2.5 Configurações
- Tema Claro/Escuro/Automático, sincronizado entre dispositivos
- Meta diária ajustável
- Toggle de notificações (preferência salva, mas **sem envio de notificação de verdade ainda**)

**Não implementado:** idioma (fixo em pt-BR), preferências de som/vibração/animação, edição de perfil (foto, bio, gêneros favoritos), privacidade (perfil público/privado, bloqueios).

### 2.6 PWA
- Instalável (ícone próprio, splash, tela cheia)
- Funciona offline para a interface (não para dados do Firestore)
- Atualização automática com aviso ao usuário

Esse módulo está **relativamente completo** frente ao que foi pedido.

### 2.7 Segurança de dados (Firestore Rules)
- Cada usuário só lê/escreve o próprio perfil, biblioteca e registro de leitura
- Bloqueio padrão (deny-all) para qualquer coleção não mapeada — princípio correto, mas **superficial**: ainda não há rate limiting, App Check, validação de dados no lado do servidor (Cloud Functions), nem proteção contra abuso (ex: alguém escrevendo valores absurdos de páginas lidas).

### 2.8 Identidade visual
- Paleta de cores, tipografia (Fraunces + Inter), e um elemento de marca (a "fita de marcador de página") aplicados de forma consistente
- Isso é **provisório** — ainda não passou pela formalização do Documento 07 (Sistema de Design), então pode mudar.

---

## 3. Resposta direta às suas perguntas específicas

**"Tem extensa variedade de livros por uma API?"**
Não. Hoje o cadastro é 100% manual. A integração com uma API de livros (Google Books API ou Open Library são as candidatas mais prováveis — ambas gratuitas, com boa cobertura em português) é o **Documento 12**, ainda não iniciado. Sem isso, o app não tem "biblioteca infinita" nenhuma — só o que cada usuário digitar.

**"Tem aquele estilo agradável para os usuários?"**
Parcialmente, e só nas 7 telas que existem. A identidade visual que foi aplicada (cores, tipografia, o elemento da fita) é consistente e não parece "projeto de faculdade" — mas é uma fração pequena da experiência total. Splash, Onboarding, Login, Cadastro, Dashboard, Biblioteca e Configurações têm esse cuidado. As outras ~40 telas planejadas ainda não existem, então não têm esse tratamento ainda.

**"Tem as metas de segurança?"**
Parcialmente, e no nível básico. O que existe: isolamento de dados por usuário (ninguém lê dado de outro usuário sem permissão), bloqueio padrão de qualquer coleção nova. O que falta, e é uma lista longa: 2FA, gerenciamento de sessões/dispositivos, revogação de tokens, App Check (proteção contra bots/scripts), Cloud Functions com validação server-side (hoje toda escrita confia no que o app manda, o que é arriscado para campos como XP/streak quando o sistema social/gamificação existir), rate limiting, logs de auditoria, sistema de denúncia/bloqueio de usuários. Isso é o **Documento 11 — Segurança**, ainda não escrito nem implementado a fundo.

**"Tem ranking de usuários?"**
Não. Zero implementado. É o **Documento 16**, que depende do Sistema Social (Documento 15) existir primeiro, porque ranking sem "amigos" ou "grupo de comparação" não faz sentido.

**"A alocação em banco de dados está pronta?"**
Só para o que já existe (perfil, biblioteca, log de leitura). O esquema completo do Firestore para social (posts, comentários, clubes, mensagens), gamificação (badges, moedas, loja, missões) e ranking (rankings por período, por grupo de amigos) ainda não foi desenhado. Isso é o **Documento 08 — Banco de Dados**, que deveria ter sido o primeiro documento técnico formal do Volume 2 e ainda não foi escrito.

---

## 4. Checklist completo de telas

Status: ✅ feita e funcionando · 🔄 existe parcialmente (faltam partes do que foi pedido) · ⬜ não iniciada

### Auth / Onboarding (7)
| Tela | Status |
|---|---|
| Splash | ✅ |
| Onboarding | ✅ |
| Escolha de idioma | ⬜ |
| Cadastro | ✅ |
| Login | ✅ |
| Recuperar senha | ⬜ |
| Confirmação de e-mail | ⬜ |

### Núcleo de leitura (12)
| Tela | Status |
|---|---|
| Dashboard / Home | 🔄 (sem heatmap, calendário, timeline) |
| Biblioteca | 🔄 (sem API de livros) |
| Explorar | ⬜ |
| Descobrir | ⬜ |
| Pesquisa | ⬜ |
| Livro (detalhe) | 🔄 (sem capa, sinopse, metadados) |
| Capítulos | ⬜ |
| Progresso | 🔄 (parte da tela de Livro, sem tela própria) |
| Metas | 🔄 (parte de Configurações/Dashboard) |
| Calendário | ⬜ |
| Ranking | ⬜ |

### Perfil / Conta (7)
| Tela | Status |
|---|---|
| Perfil (próprio) | ⬜ |
| Perfil de outro usuário | ⬜ |
| Editar Perfil | ⬜ |
| Configurações | ✅ |
| Segurança | ⬜ |
| Sessões | ⬜ |
| Central de Notificações | ⬜ (só existe o toggle, não a central) |

### Social (7)
| Tela | Status |
|---|---|
| Chat IA (Lumi) | ⬜ |
| Clube do Livro | ⬜ |
| Amigos | ⬜ |
| Feed | ⬜ |
| Comentários | ⬜ |
| Mensagens | ⬜ |
| Avaliações | ⬜ |

### Gamificação / Loja (4)
| Tela | Status |
|---|---|
| Badges | ⬜ |
| Loja | ⬜ |
| Eventos | ⬜ |
| Premium | ⬜ |

### Admin (3)
| Tela | Status |
|---|---|
| Painel Admin | ⬜ |
| Analytics | ⬜ |
| Relatórios | ⬜ |

### Institucional (6)
| Tela | Status |
|---|---|
| Ajuda | ⬜ |
| FAQ | ⬜ |
| Suporte | ⬜ |
| Política de Privacidade | ⬜ |
| Termos de Uso | ⬜ |
| Sobre | ⬜ |

**Total: 4 telas ✅ completas, 5 🔄 parciais, 37 ⬜ não iniciadas** (de 46 nomeadas — o número real final tende a crescer um pouco quando essas seções forem detalhadas, como o próprio planejamento original previa).

---

## 5. O que ainda será entregue — roadmap por documento

### Volume 2 — Backend e Dados (0% feito)
- **08 Banco de Dados**: schema completo do Firestore para social, gamificação, ranking, clubes
- **09 Firebase**: Storage (fotos de perfil, capas), regras de Storage
- **10 Cloud Functions**: validação server-side de XP/streak (impedir trapaça), jobs agendados (resetar streak à meia-noite, calcular ranking semanal)
- **11 Segurança**: 2FA, sessões, App Check, rate limiting, denúncias/bloqueios
- **12 APIs de Livros**: integração real (Google Books ou Open Library) — isto é o que resolve "variedade extensa de livros"
- **13 Sistema de IA**: motor de recomendação por trás da Lumi

### Volume 3 — Produto e Telas (telas Dashboard/Biblioteca parcialmente feitas, resto 0%)
- **14 Mascote Lumi**: personalidade, frases, integração com chat
- **15 Sistema Social**: feed, amigos, comentários, mensagens
- **16 Ranking**: depende do Social
- **17 Gamificação**: XP, badges, loja, missões
- **18-26**: expansão de Dashboard/Perfil/Biblioteca/Leitura, Avaliações, Clube do Livro, Chat, Notificações (push de verdade), Painel Admin

### Volume 4 — Qualidade e Lançamento (0% feito)
- **27 Responsividade**: auditoria formal em todos os breakpoints
- **29 Performance**: o bundle já está acima de 500kB (aviso do Vite) — vai precisar de code-splitting antes de crescer mais
- **30-35**: SEO, deploy formal, roadmap, melhorias futuras

---

## 6. Avaliação honesta de aderência ao prompt original

| Pilar do produto | Status |
|---|---|
| Hábito (streak, metas) | 🔄 Parcial — base funcional, falta heatmap/calendário/conquistas |
| Identidade emocional (Lumi, visual) | 🔄 Parcial — visual ok nas telas existentes, Lumi (a mascote/personalidade) não existe |
| Inteligência (IA) | ⬜ Zero |
| Pertencimento social | ⬜ Zero |
| Acabamento profissional | 🔄 Parcial — o que existe está bem feito, mas é pouco do total |

**Conclusão honesta:** o projeto está seguindo a direção certa tecnicamente (Firebase, sincronização real, PWA, segurança básica correta, identidade visual consistente) — mas ainda está longe de ser "o aplicativo que você pediu" como experiência completa. O diferencial citado no seu pitch original (IA que conhece o leitor, comunidade viva, gamificação tipo Duolingo) ainda não existe.

---

## 7. Recomendação de prioridade

Se o objetivo é ter algo demonstrável e genuinamente diferenciado o mais rápido possível, sugiro esta ordem (em vez de seguir os documentos estritamente em sequência):

1. **API de livros** (Documento 12) — sem isso, o app não tem conteúdo de verdade, e é provavelmente a lacuna mais visível pra qualquer pessoa que for testar.
2. **Lumi básica** (Documento 14) — mesmo sem IA real no início, dar uma cara/personalidade ao app já muda a percepção de produto.
3. **Cloud Functions de validação** (parte do Documento 10/11) — antes de adicionar gamificação/ranking, porque esses sistemas são os mais fáceis de trapacear se a validação continuar só no app.
4. Só depois, Social + Ranking + Gamificação completos, que são os módulos mais caros em tempo de desenvolvimento.

Isso é uma sugestão, não uma imposição — você decide a ordem.
