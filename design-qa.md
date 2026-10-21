# PulseNote Admin — Design QA

**Source visual truth paths**

- `C:\Users\Douglas\.codex\generated_images\01a08e2a-5ce9-7a13-a9df-58ebf780a596\exec-a1f07b58-558c-4eb7-a1b8-6408f268630b.png` — visão geral.
- `C:\Users\Douglas\.codex\generated_images\01a08e2a-5ce9-7a13-a9df-58ebf780a596\exec-ba5dda1d-7fe9-4bad-a590-19571403e7de.png` — usuários e detalhe.
- `C:\Users\Douglas\.codex\generated_images\01a08e2a-5ce9-7a13-a9df-58ebf780a596\exec-9ece4bb1-ab29-4608-8cf5-e10720ace3a8.png` — planos e cobrança.

**Implementation screenshot path**

- Indisponível nesta iteração. O painel exige uma sessão Firebase administrativa no preview público e o navegador automatizado não conseguiu alcançar o servidor local. Uma captura anterior do usuário representa a versão antiga e não serve como evidência da implementação atual.

**Viewport**

- Alvo desktop: `1440 × 900` CSS px, `deviceScaleFactor: 1`.
- Alvo mobile: `390 × 844` CSS px, `deviceScaleFactor: 1`.

**Pixel dimensions and normalization**

- Source overview: `1488 × 1058` px.
- Source users: `1488 × 1058` px.
- Source plans: `1488 × 1058` px.
- Implementation: não capturada; normalização visual ainda não pode ser concluída.

**State**

- Tema escuro Aurora, administrador principal autenticado, ambiente de preview, dados operacionais reais carregados.

**Full-view comparison evidence**

- Os três alvos visuais foram abertos e revisados. A implementação ainda não pôde ser capturada no mesmo estado, viewport e sessão; portanto não existe comparação visual válida nesta iteração.

**Focused region comparison evidence**

- Bloqueada junto com a captura completa. As regiões prioritárias para a próxima passagem são: navegação lateral, faixa de métricas, gráfico de acesso, tabela/drawer de usuários e matriz de recursos dos planos.

**Findings**

- [P1] Falta evidência renderizada autenticada da versão atual
  Location: `/admin` no preview da PR.
  Evidence: os alvos visuais estão disponíveis, mas não há captura da implementação atual no mesmo estado.
  Impact: tipografia, densidade, alinhamento, responsividade e estados interativos não podem ser aprovados apenas pelo código.
  Fix: publicar o preview, abrir `/admin` com a conta administrativa, capturar desktop e mobile e executar a comparação visual combinada.

**Open Questions**

- Nenhuma decisão de produto está pendente. Falta somente evidência visual autenticada após o deploy.

**Implementation Checklist**

- Publicar a branch da PR e aguardar o preview ficar pronto.
- Capturar a visão geral em `1440 × 900` e `390 × 844`.
- Testar navegação, busca/filtros de usuários, drawer, edição de plano e retorno ao app.
- Verificar console e rede sem erros.
- Comparar as capturas com os três alvos e corrigir qualquer P0/P1/P2.

**Comparison History**

- Iteração 1: a versão antiga exibida pelo usuário tinha conteúdo comprimido numa coluna estreita e grande área vazia. O painel foi reestruturado com grade responsiva, tabelas operacionais, detalhes de usuário, fluxo real e matriz de planos. Evidência pós-correção ainda não capturada.

**Follow-up Polish**

- Avaliar microajustes P3 de densidade, truncamento e contraste após a captura real.

final result: blocked
