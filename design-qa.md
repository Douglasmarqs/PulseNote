# Pulse Command — relatório de QA visual

Data: 4 de novembro de 2026  
Preview validado: `pulse-command-preview-20261103`  
URL estável: `https://pulse-note-5erj-git-pulse-comm-fc87e7-douglas-projects-c831a9fc.vercel.app`

## Escopo

- Direção visual: Pulse Command, com superfícies escuras translúcidas, hierarquia compacta e acentos violeta/ciano.
- Áreas verificadas: Dashboard, Planner (lista e mês), Notas (criação, cartão e detalhe), Finanças (lançamentos e análise) e Autopilot.
- Referência visual: `C:\Users\Douglas\.codex\generated_images\01a08e2a-5ce9-7a13-a9df-58ebf780a596\exec-6cc40272-8a9d-4f29-a485-9277ff8f909e.png`.

## Verificações concluídas

- Desktop: grade principal, sidebar, previsão financeira, agenda, Autopilot e comando rápido sem cortes ou sobreposição.
- Mobile 390×844: Dashboard, Planner, Notas e Finanças sem rolagem horizontal.
- Planner mensal: compromissos compactados em contadores no mobile, evitando cards amontoados.
- Notas: formulário principal limpo, prioridades distintas, checklist e ações do detalhe sem colisão com a navegação inferior.
- Finanças: Excel removido; PDF mantido; abas compactas; gráficos dos últimos seis meses e saldo acumulado contidos em 321 px dentro de cards de 321 px.
- Análise financeira: `clientWidth = 375`, `scrollWidth = 375`, nenhum elemento fora da viewport e rótulos de junho a novembro visíveis.
- Comando rápido: intenções de Finanças, Planner e Notas abrem diretamente a área solicitada; pedidos genéricos seguem para o Autopilot.
- Autopilot no preview: exige confirmação e exibe explicitamente que nenhum dado real foi alterado.
- Preview seguro: dados fictícios apenas em localhost ou domínio de preview; o domínio oficial não aceita `designPreview=1`.
- Cobrança no preview: consulta autenticada desativada; checkout e assinatura não são simulados.
- Integridade: `src/app.js` publicado com 385.122 caracteres e 7.942 quebras de linha, sem truncamento.
- Regressão: 138 de 138 testes automatizados aprovados.
- Vercel: deployment `dpl_AaYJnaHdfLDTJ6fC6WgWwDeXYdou` em estado READY.

## Observações

- A produção não foi promovida durante esta rodada de QA.
- O teste real de push com o app fechado permanece separado e será executado por último, conforme solicitado.
- Após a última correção não foi possível abrir uma nova sessão de automação visual porque o controle local do navegador foi desativado nas configurações do Work. A mudança final não afeta layout e foi coberta pelos testes; a inspeção visual anterior foi concluída no mesmo deployment de estilos.

final result: passed

## Rodada complementar — 6 de novembro de 2026

- Branch de validação: `feature/pulsenote-admin-autopilot-20261013`.
- Commit publicado: `2443cdc01d243031d1118b9a9d2d999ea30166d2`.
- Deployment: `dpl_6kbpqmsPtyhvPbJW1Z4dEzKo7Cbe`, estado `READY`, sem erro de build.
- URL estável da branch: `https://pulse-note-5erj-git-feature-pu-76c2a1-douglas-projects-c831a9fc.vercel.app`.
- Regressão local: 150 de 150 testes aprovados.
- Pulsinho: consultas de saldo, margem diária, compromissos, categorias, tarefas, agenda e metas agora usam o motor local, sem depender da disponibilidade do provedor de IA.
- Perguntas abertas: continuam usando o provedor configurado, com uma única tentativa curta no fallback Gemini e resposta operacional segura caso haja timeout ou HTTP 503.
- Integrações preservadas: simulador “posso gastar?”, gráficos com detalhamento, contas/espaços compartilhados e permissões owner/editor/viewer.
- Produção não promovida nesta rodada. O teste real de push com o aplicativo fechado continua sendo a última etapa.

## Reconstrução por quadros — Dashboard — 11 de novembro de 2026

- Fonte visual: `PulseNote-Visual-Pack/imagens/{claro,escuro}/{desktop,mobile}/02-dashboard.png`.
- Escopo desta aprovação: somente Dashboard, conforme solicitado antes de avançar às demais telas.
- Implementação: estrutura de desktop e mobile, temas claro/escuro, navegação, espaços financeiros, resumo de saldo/gastos, meta de orçamento, gráfico com períodos reais, compromissos, resultado do mês e Pulsinho conversacional.
- Regressão automatizada: 174 de 174 testes aprovados.
- Build estático do repositório: não se aplica; o projeto é estático com rewrites da Vercel e não possui `index.html` na raiz.
- Bloqueio visual local: o navegador interno informou `Local browser use is disabled in Work settings`; portanto ainda não foi possível capturar a implementação nos mesmos viewports 1440 e 390.
- Próxima validação: publicar somente esta tela em preview, abrir o preview e comparar com os quatro quadros antes de qualquer avanço.

final result: blocked

