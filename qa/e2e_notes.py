"""E2E das Notas: cada botão e cada fluxo, no celular (toque) e no computador (mouse).

Uso: python3 -I e2e_notes.py [mobile|desktop|all]
"""
import json
import sys
import pathlib
from playwright.sync_api import sync_playwright

sys.path.insert(0, str(pathlib.Path(__file__).parent))
import os
FB = pathlib.Path(os.environ.get("PN_FIREBASE_DIR", "qa/node_modules/firebase"))
URL = "http://127.0.0.1:8077/src/index.html?designPreview=1"
SHOTS = pathlib.Path(os.environ.get("PN_SHOTS", "qa/shots")); SHOTS.mkdir(parents=True, exist_ok=True)

results = []


def check(name, cond, detail=""):
    results.append((bool(cond), name, detail))
    print(("  PASS " if cond else "  FAIL ") + name + (f"  [{detail}]" if detail and not cond else ""))


def route(r):
    url = r.request.url
    if "gstatic.com/firebasejs" in url:
        f = FB / url.split("/")[-1].split("?")[0]
        return r.fulfill(status=200, body=f.read_bytes(), headers={"content-type": "application/javascript"})
    if url.startswith("http://127.0.0.1"):
        return r.continue_()
    return r.abort()


JS_HELPERS = r"""
window.__t = {
  pressed(sel) { return [...document.querySelectorAll(sel + ' [aria-pressed="true"]')].map(b => b.dataset.neCmd || b.dataset.ndCmd || b.dataset.ndColor); },
  expanded(sel) { return [...document.querySelectorAll(sel + ' [aria-expanded="true"]')].map(b => b.dataset.ndCmd); },
  stored() {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i); const v = localStorage.getItem(k);
      if (v && v.startsWith('{') && v.includes('"notes"')) { try { const j = JSON.parse(v); if (Array.isArray(j.notes)) return j; } catch (e) {} }
    }
    return null;
  },
  caretEnd(el) { el.focus(); const r = document.createRange(); r.selectNodeContents(el); r.collapse(false); const s = getSelection(); s.removeAllRanges(); s.addRange(r); },
  selectText(el, text) {
    const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT); let n;
    while ((n = w.nextNode())) { const i = n.textContent.indexOf(text); if (i >= 0) { el.focus(); const r = document.createRange(); r.setStart(n, i); r.setEnd(n, i + text.length); const s = getSelection(); s.removeAllRanges(); s.addRange(r); return true; } }
    return false;
  },
  html(sel) { return document.querySelector(sel).innerHTML; },
};
"""


def run(mode):
    mobile = mode == "mobile"
    print(f"\n=== Notas — {mode} ===")
    errors = []
    with sync_playwright() as p:
        browser = p.chromium.launch(args=["--no-sandbox"])
        ctx = browser.new_context(viewport={"width": 390, "height": 844} if mobile else {"width": 1440, "height": 900}, has_touch=mobile)
        ctx.add_init_script(JS_HELPERS)
        page = ctx.new_page()
        page.route("**/*", route)
        page.on("pageerror", lambda e: errors.append(str(e)))
        page.on("console", lambda m: errors.append(m.text) if m.type == "error" and not any(k in m.text for k in ("Failed to load resource", "bad HTTP response", "Firestore", "firestore")) else None)
        page.goto(URL)
        page.wait_for_timeout(2500)
        click = (lambda sel: page.locator(sel).first.tap()) if mobile else (lambda sel: page.locator(sel).first.click())
        ev = page.evaluate
        ev("setView('notes')")
        page.wait_for_timeout(500)
        before = ev("document.querySelectorAll('#notesList .bn-card').length")

        # ── Nova nota ─────────────────────────────────────────
        if mobile:
            click("#notesOpenForm")
            page.wait_for_timeout(400)
            check("folha 'Nova nota' abre", ev("document.querySelector('#noteFormWrap').classList.contains('is-open')"))
        check("sem 'Organizar' no formulário", ev("!document.querySelector('#noteForm details') && !/Organizar/.test(document.querySelector('#noteForm').innerText)"))
        check("barra começa sem nenhum botão aceso", ev("__t.pressed('#noteEditorTools').length === 0"))

        ed = "#noteEditor"
        page.locator(ed).click()
        page.keyboard.type("Ola ")
        for cmd in ["bold", "italic", "underline", "strike"]:
            click(f'#noteEditorTools [data-ne-cmd="{cmd}"]')
            check(f"{cmd}: liga só ele (cursor)", ev("__t.pressed('#noteEditorTools')") == [cmd], ev("__t.pressed('#noteEditorTools')"))
            page.keyboard.type(cmd[:2])
            click(f'#noteEditorTools [data-ne-cmd="{cmd}"]')
            check(f"{cmd}: desliga no segundo toque", ev("__t.pressed('#noteEditorTools')") == [], ev("__t.pressed('#noteEditorTools')"))
            page.keyboard.type(" ")
        h = ev("__t.html('#noteEditor')")
        check("negrito/itálico/sublinhado/riscado gravados no texto", all(t in h for t in ["<b>bo</b>", "<i>it</i>", "<u>un</u>"]) and ("<strike>st</strike>" in h or "<s>st</s>" in h), h)

        # seleção + negrito liga/desliga
        page.keyboard.type("palavra")
        ev("__t.selectText(document.querySelector('#noteEditor'), 'palavra')")
        click('#noteEditorTools [data-ne-cmd="bold"]')
        check("negrito em trecho selecionado", "<b>palavra</b>" in ev("__t.html('#noteEditor')") and ev("__t.pressed('#noteEditorTools')") == ["bold"])
        click('#noteEditorTools [data-ne-cmd="bold"]')
        check("negrito sai do trecho no segundo toque", "<b>palavra</b>" not in ev("__t.html('#noteEditor')") and ev("__t.pressed('#noteEditorTools')") == [])

        # marca-texto: trecho
        ev("__t.selectText(document.querySelector('#noteEditor'), 'palavra')")
        click('#noteEditorTools [data-ne-cmd="highlight"]')
        check("marca-texto em trecho vira <mark>", "<mark>palavra</mark>" in ev("__t.html('#noteEditor')"), ev("__t.html('#noteEditor')"))
        check("marca-texto aceso no trecho", ev("__t.pressed('#noteEditorTools')") == ["highlight"], ev("__t.pressed('#noteEditorTools')"))
        click('#noteEditorTools [data-ne-cmd="highlight"]')
        check("marca-texto desliga no segundo toque", "<mark>" not in ev("__t.html('#noteEditor')") and ev("__t.pressed('#noteEditorTools')") == [])
        # marca-texto: cursor
        ev("__t.caretEnd(document.querySelector('#noteEditor'))")
        click('#noteEditorTools [data-ne-cmd="highlight"]')
        check("marca-texto no cursor fica aceso", ev("__t.pressed('#noteEditorTools')") == ["highlight"])
        page.keyboard.type("amarelo")
        check("texto digitado sai marcado", "amarelo</mark>" in ev("__t.html('#noteEditor')"), ev("__t.html('#noteEditor')"))
        click('#noteEditorTools [data-ne-cmd="highlight"]')
        check("segundo toque sai do marca-texto", ev("__t.pressed('#noteEditorTools')") == [])
        page.keyboard.type("normal")
        check("texto depois fica normal", "normal</mark>" not in ev("__t.html('#noteEditor')") and "normal" in ev("__t.html('#noteEditor')"))

        # listas exclusivas
        page.keyboard.press("Enter")
        page.keyboard.type("item")
        click('#noteEditorTools [data-ne-cmd="ul"]')
        check("lista com marcadores acesa sozinha", ev("__t.pressed('#noteEditorTools')") == ["ul"], ev("__t.pressed('#noteEditorTools')"))
        click('#noteEditorTools [data-ne-cmd="ol"]')
        check("lista numerada troca a outra (nunca as duas)", ev("__t.pressed('#noteEditorTools')") == ["ol"], ev("__t.pressed('#noteEditorTools')"))
        click('#noteEditorTools [data-ne-cmd="ol"]')
        check("lista numerada desliga", ev("__t.pressed('#noteEditorTools')") == [], ev("__t.pressed('#noteEditorTools')"))

        # limpar
        ev("__t.selectText(document.querySelector('#noteEditor'), 'bo')")
        click('#noteEditorTools [data-ne-cmd="bold"]')
        ev("__t.caretEnd(document.querySelector('#noteEditor'))")
        click('#noteEditorTools [data-ne-cmd="clear"]')
        hc = ev("__t.html('#noteEditor')")
        check("limpar formatação remove tudo", not any(t in hc for t in ["<b>", "<i>", "<u>", "<strike>", "<mark>"]), hc)

        # sair do texto apaga os botões
        page.locator("#noteTitle").click()
        check("fora do texto, nada aceso", ev("__t.pressed('#noteEditorTools')") == [])

        # formatar de novo para salvar
        ev("__t.selectText(document.querySelector('#noteEditor'), 'palavra')")
        click('#noteEditorTools [data-ne-cmd="bold"]')
        ev("__t.selectText(document.querySelector('#noteEditor'), 'amarelo')")
        click('#noteEditorTools [data-ne-cmd="highlight"]')

        # prioridade
        click('#notePrioritySeg [data-prio="Alta"]')
        check("prioridade: só Alta marcada", ev("[...document.querySelectorAll('#notePrioritySeg [aria-checked=\"true\"]')].map(b=>b.dataset.prio)") == ["Alta"])
        click('#notePrioritySeg [data-prio="Baixa"]')
        click('#notePrioritySeg [data-prio="Alta"]')
        check("prioridade troca sem acumular", ev("document.querySelectorAll('#notePrioritySeg [aria-checked=\"true\"]').length") == 1)

        # pasta
        check("pasta padrão Entrada", ev("document.querySelector('#noteFolderPicker [aria-checked=\"true\"]').dataset.folder") == "Entrada")
        click("#noteFolderPicker [data-folder-new]")
        check("Nova pasta abre o campo", ev("!document.querySelector('#noteFolderNewRow').hidden"))
        page.locator("#noteFolderNewInput").fill("Viagem")
        page.keyboard.press("Enter")
        check("pasta criada e escolhida", ev("document.querySelector('#noteFolderPicker [aria-checked=\"true\"]').dataset.folder") == "Viagem" and ev("document.querySelector('#noteFolderNewRow').hidden"))
        check("só uma pasta marcada", ev("document.querySelectorAll('#noteFolderPicker [aria-checked=\"true\"]').length") == 1)

        # checklist
        click("#noteChecklistAdd")
        check("adicionar item cria e foca o campo", ev("document.activeElement?.classList.contains('bn-clb-input')"))
        page.keyboard.type("Passaporte")
        page.keyboard.press("Enter")
        check("Enter cria o próximo item", ev("document.querySelectorAll('#noteChecklistItems .bn-clb-row').length") == 2 and ev("document.activeElement?.value === ''"))
        page.keyboard.type("Mala")
        page.keyboard.press("Enter")
        page.keyboard.press("Backspace")
        check("Backspace em item vazio apaga e volta", ev("document.querySelectorAll('#noteChecklistItems .bn-clb-row').length") == 2 and ev("document.activeElement?.value") == "Mala")
        click('#noteChecklistItems .bn-clb-row:first-child [data-clb-toggle]')
        check("marcar item", ev("document.querySelector('#noteChecklistItems .bn-clb-row').classList.contains('is-done')") and "1/2" in ev("document.querySelector('#noteChecklistCount').textContent"))
        click('#noteChecklistItems .bn-clb-row:first-child [data-clb-toggle]')
        click('#noteChecklistItems .bn-clb-row:first-child [data-clb-toggle]')
        check("desmarcar/marcar de novo", ev("document.querySelector('#noteChecklistItems .bn-clb-row').classList.contains('is-done')"))
        click('#noteEditorTools [data-ne-cmd="checklist"]')
        click('#noteEditorTools [data-ne-cmd="checklist"]')
        check("botão checklist não cria itens vazios repetidos", ev("document.querySelectorAll('#noteChecklistItems .bn-clb-row').length") == 3)
        page.keyboard.type("Remover")
        click('#noteChecklistItems .bn-clb-row:last-child [data-clb-del]')
        check("remover item", ev("document.querySelectorAll('#noteChecklistItems .bn-clb-row').length") == 2)

        # salvar vazio = erro
        ev("document.querySelector('#noteTitle').value=''")
        snapshot_html = ev("__t.html('#noteEditor')")
        ev("document.querySelector('#noteEditor').innerHTML=''; document.querySelector('#noteEditor').dispatchEvent(new Event('input'))")
        ev("window.__savedChecklist = document.querySelector('#noteChecklistItems').innerHTML")
        # esvazia checklist temporariamente via UI
        while ev("document.querySelectorAll('#noteChecklistItems .bn-clb-row').length") > 0:
            click('#noteChecklistItems .bn-clb-row:last-child [data-clb-del]')
        click("#noteForm .bn-save")
        page.wait_for_timeout(200)
        check("salvar vazio mostra erro e não cria nota", ev("!document.querySelector('#noteFormError').hidden") and ev("document.querySelectorAll('#notesList .bn-card').length") == before)
        # preenche de novo
        page.locator("#noteTitle").fill("Viagem de dezembro")
        check("erro some ao digitar", ev("document.querySelector('#noteFormError').hidden"))
        ev(f"document.querySelector('#noteEditor').innerHTML = {json.dumps(snapshot_html)}; document.querySelector('#noteEditor').dispatchEvent(new Event('input'))")
        click("#noteChecklistAdd"); page.keyboard.type("Passaporte"); page.keyboard.press("Enter"); page.keyboard.type("Mala")
        click('#noteChecklistItems .bn-clb-row:first-child [data-clb-toggle]')

        t0 = ev("performance.now()")
        ev("""(() => { const t = performance.now(); document.querySelector('#noteForm .bn-save').click(); window.__saveMs = performance.now() - t; })()""")
        page.wait_for_timeout(500)
        save_ms = ev("window.__saveMs")
        check("salvar responde rápido (sem travar)", save_ms < 60, f"{save_ms:.1f} ms")
        check("nota criada aparece na lista", ev("document.querySelectorAll('#notesList .bn-card').length") == before + 1)
        check("aviso 'Nota criada'", "Nota criada" in ev("document.querySelector('#toastText')?.textContent || ''"))
        if mobile:
            check("folha fecha ao salvar", not ev("document.querySelector('#noteFormWrap').classList.contains('is-open')"))
        page.wait_for_timeout(1300)
        stored = ev("__t.stored()")
        note = next((n for n in (stored or {}).get("notes", []) if n.get("title") == "Viagem de dezembro"), None)
        check("nota gravada no armazenamento", bool(note))
        if note:
            check("pasta gravada", note.get("folder") == "Viagem", note.get("folder"))
            check("prioridade gravada", note.get("priority") == "Alta", note.get("priority"))
            check("checklist gravado com estado", [(i["text"], i["done"]) for i in note.get("checklist", [])] == [("Passaporte", True), ("Mala", False)], note.get("checklist"))
            check("formatação gravada (negrito + marca-texto)", "<b>palavra</b>" in note.get("descriptionHtml", "") and "<mark>amarelo</mark>" in note.get("descriptionHtml", ""), note.get("descriptionHtml"))
            check("sem caracteres invisíveis gravados", "​" not in json.dumps(note, ensure_ascii=False))

        # editar pelo formulário
        nid = note["id"] if note else ""
        ev(f"editNote('{nid}')")
        page.wait_for_timeout(400)
        check("editar carrega título, pasta, prioridade e checklist", ev("document.querySelector('#noteTitle').value") == "Viagem de dezembro"
              and ev("document.querySelector('#noteFolderPicker [aria-checked=\"true\"]').dataset.folder") == "Viagem"
              and ev("document.querySelector('#notePrioritySeg [aria-checked=\"true\"]').dataset.prio") == "Alta"
              and ev("document.querySelectorAll('#noteChecklistItems .bn-clb-row').length") == 2)
        page.locator("#noteTitle").fill("Viagem de dezembro ✈")
        click("#noteForm .bn-save")
        page.wait_for_timeout(400)
        check("editar não duplica", ev("document.querySelectorAll('#notesList .bn-card').length") == before + 1)
        check("aviso 'Alterações salvas'", "Alterações salvas" in ev("document.querySelector('#toastText')?.textContent || ''"))

        # ── Nota aberta ───────────────────────────────────────
        page.wait_for_timeout(2400)
        if mobile:
            ev(f"openNoteDetail('{nid}')")
        else:
            page.locator(f'#notesList .bn-card[data-note-id="{nid}"]').click()
        page.wait_for_timeout(500)
        check("nota abre", ev("!document.querySelector('#noteDetailModal').hidden"))
        check("selo 'Salvo' ao abrir", ev("document.querySelector('#ndStatus').dataset.state") == "saved")
        check("rodapé: " + ("Concluir" if mobile else "Salvo"), ev("document.querySelector('#ndSaveLabel').textContent") == ("Concluir" if mobile else "Salvo"))
        check("barra da nota sem nada aceso", ev("__t.pressed('#noteDetailToolbar')") == [])
        ev("__t.caretEnd(document.querySelector('#ndBody'))")
        page.keyboard.type(" mais texto")
        check("digitar mostra 'Salvando…'", ev("document.querySelector('#ndStatus').dataset.state") == "saving")
        if not mobile:
            check("rodapé vira 'Salvar agora' com alteração pendente", ev("document.querySelector('#ndSaveLabel').textContent") == "Salvar agora")
        page.wait_for_timeout(1100)
        check("autosave volta para 'Salvo'", ev("document.querySelector('#ndStatus').dataset.state") == "saved")
        for cmd in ["bold", "italic", "underline", "strike", "highlight"]:
            click(f'#noteDetailToolbar [data-nd-cmd="{cmd}"]')
            check(f"nota: {cmd} liga sozinho", ev("__t.pressed('#noteDetailToolbar')") == [cmd], ev("__t.pressed('#noteDetailToolbar')"))
            page.keyboard.type("x")
            click(f'#noteDetailToolbar [data-nd-cmd="{cmd}"]')
            check(f"nota: {cmd} desliga", ev("__t.pressed('#noteDetailToolbar')") == [], ev("__t.pressed('#noteDetailToolbar')"))
        click('#noteDetailToolbar [data-nd-cmd="ul"]')
        click('#noteDetailToolbar [data-nd-cmd="ol"]')
        check("nota: listas exclusivas", ev("__t.pressed('#noteDetailToolbar')") == ["ol"], ev("__t.pressed('#noteDetailToolbar')"))
        click('#noteDetailToolbar [data-nd-cmd="ol"]')
        # painéis exclusivos
        click('#noteDetailToolbar [data-nd-cmd="more"]')
        check("Aa abre o painel de cor", ev("!document.querySelector('#ndMorePanel').hidden") and ev("__t.expanded('#noteDetailToolbar')") == ["more"])
        click('#noteDetailToolbar [data-nd-cmd="link"]')
        check("Link fecha o painel de cor (um por vez)", ev("document.querySelector('#ndMorePanel').hidden") and not ev("document.querySelector('#ndLinkForm').hidden") and ev("__t.expanded('#noteDetailToolbar')") == ["link"], ev("__t.expanded('#noteDetailToolbar')"))
        click('#noteDetailToolbar [data-nd-cmd="link"]')
        check("Link fecha no segundo toque", ev("document.querySelector('#ndLinkForm').hidden") and ev("__t.expanded('#noteDetailToolbar')") == [])
        # cor
        ev("__t.selectText(document.querySelector('#ndBody'), 'mais')")
        click('#noteDetailToolbar [data-nd-cmd="more"]')
        click('#noteDetailToolbar [data-nd-color="#0a84ff"]')
        check("cor aplicada e marcada", "#0a84ff" in ev("__t.pressed('#noteDetailToolbar')") or ev("document.querySelector('[data-nd-color=\"#0a84ff\"]').getAttribute('aria-pressed')") == "true")
        # link
        ev("__t.selectText(document.querySelector('#ndBody'), 'texto')")
        click('#noteDetailToolbar [data-nd-cmd="link"]')
        page.locator("#ndLinkInput").fill("exemplo.com")
        page.keyboard.press("Enter")
        check("link criado com https", 'href="https://exemplo.com"' in ev("__t.html('#ndBody')") and ev("document.querySelector('#ndLinkForm').hidden"))
        # checklist da nota
        click('#noteDetailToolbar [data-nd-cmd="checklist"]')
        page.wait_for_timeout(100)
        check("checklist: foco no novo item", ev("document.activeElement?.id") == "ndChecklistAddInput")
        page.keyboard.type("Seguro viagem")
        page.keyboard.press("Enter")
        check("checklist: item adicionado", ev("document.querySelectorAll('#ndChecklistItems .bn-check-row').length") == 3)
        click('#ndChecklistItems .bn-check-row:last-child [data-nd-check-toggle]')
        check("checklist: marcar atualiza progresso", ev("document.querySelector('#ndChecklistItems .bn-check-row:last-child').classList.contains('is-done')") and "2 de 3" in ev("document.querySelector('#ndChecklistProgress').textContent"))
        page.locator('#ndChecklistItems .bn-check-row:nth-child(2) .bn-check-text').fill("Mala grande")
        page.locator("#ndTitle").click()
        page.wait_for_timeout(900)
        click('#ndChecklistItems .bn-check-row:last-child [data-nd-check-del]')
        check("checklist: remover", ev("document.querySelectorAll('#ndChecklistItems .bn-check-row').length") == 2)
        ev("document.querySelector('#toast .toast-action')?.click()")
        check("checklist: desfazer devolve o item", ev("document.querySelectorAll('#ndChecklistItems .bn-check-row').length") == 3)
        # prioridade e pasta
        click("#ndChips [data-nd-prio]")
        check("prioridade troca no chip", "Urgente" in ev("document.querySelector('#ndChips [data-nd-prio]').textContent"))
        click("#ndChips [data-nd-folder]")
        page.wait_for_timeout(200)
        check("pasta abre 'Mover para pasta'", ev("!!document.querySelector('#noteFolderSheet')"))
        click('#noteFolderSheet [data-move-folder="Entrada"]')
        page.wait_for_timeout(200)
        check("nota movida de pasta", "Entrada" in ev("document.querySelector('#ndChips [data-nd-folder]').textContent") and not ev("!!document.querySelector('#noteFolderSheet')"))
        # concluir / salvar
        page.wait_for_timeout(1200)
        ev("""(() => { const t = performance.now(); document.querySelector('#ndSaveBtn').click(); window.__closeMs = performance.now() - t; })()""")
        page.wait_for_timeout(700)
        close_ms = ev("window.__closeMs")
        check("Concluir/Salvar responde rápido", close_ms < 60, f"{close_ms:.1f} ms")
        if mobile:
            check("Concluir fecha a nota", ev("document.querySelector('#noteDetailModal').hidden"))
        else:
            check("Salvar no painel mantém aberta e mostra 'Salvo'", not ev("document.querySelector('#noteDetailModal').hidden") and ev("document.querySelector('#ndSaveLabel').textContent") == "Salvo")
        page.wait_for_timeout(1300)
        stored = ev("__t.stored()")
        note = next((n for n in (stored or {}).get("notes", []) if n.get("id") == nid), None)
        check("nota aberta: tudo gravado", bool(note) and "mais" in note.get("description", "") and note.get("priority") == "Urgente" and note.get("folder") == "Entrada"
              and [i["text"] for i in note.get("checklist", [])] == ["Passaporte", "Mala grande", "Seguro viagem"], json.dumps(note, ensure_ascii=False)[:300] if note else "")
        page.screenshot(path=str(SHOTS / f"notes_end_{mode}.png"))
        check("sem erros no console", not errors, "; ".join(errors[:3]))
        browser.close()


modes = ["mobile", "desktop"] if len(sys.argv) < 2 or sys.argv[1] == "all" else [sys.argv[1]]
for m in modes:
    run(m)
fails = [r for r in results if not r[0]]
print(f"\nTOTAL: {len(results) - len(fails)}/{len(results)} passaram")
sys.exit(1 if fails else 0)
