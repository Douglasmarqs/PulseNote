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

