# Testes de ponta a ponta (navegador)

Rodam o app em modo `?designPreview=1` (dados de exemplo, sem login) e clicam/tocam
em cada botão de Notas, Início, Pulsinho, Planner e Finanças — no celular (toque) e
no computador (mouse) — e conferem a virada do dia com o app aberto.

```bash
pip install playwright && python -m playwright install chromium
(cd qa && npm i --no-save firebase@10.12.2)        # Firebase servido localmente
python -m http.server 8077 &                        # na raiz do projeto
python qa/e2e_notes.py all && python qa/e2e_notes_extra.py && python qa/e2e_flows.py
```
