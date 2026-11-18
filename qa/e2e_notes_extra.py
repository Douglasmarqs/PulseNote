"""E2E complementar das Notas: combinações, perda de foco (iPhone), biblioteca, favoritos,
excluir/desfazer, virar tarefa, troca de nota no painel, voltar do celular e Limpar."""
import json
import os
import sys
import pathlib

src = open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "e2e_notes.py")).read().split("def run(mode):")[0]
exec(src)


def run(mode):
    mobile = mode == "mobile"
    print(f"\n=== Notas (extra) — {mode} ===")
    errors = []
    with sync_playwright() as p:
        browser = p.chromium.launch(args=["--no-sandbox"])
        ctx = browser.new_context(viewport={"width": 390, "height": 844} if mobile else {"width": 1440, "height": 900}, has_touch=mobile)
        ctx.add_init_script(JS_HELPERS)
        page = ctx.new_page()
        page.route("**/*", route)
        page.on("pageerror", lambda e: errors.append(str(e)))
        page.goto(URL)
        page.wait_for_timeout(2500)
        click = (lambda sel: page.locator(sel).first.tap()) if mobile else (lambda sel: page.locator(sel).first.click())
        ev = page.evaluate
        ev("setView('notes')")
        page.wait_for_timeout(500)
        if mobile:
            click("#notesOpenForm")
            page.wait_for_timeout(350)

        # combinação legítima: negrito + itálico juntos
        page.locator("#noteEditor").click()
        click('#noteEditorTools [data-ne-cmd="bold"]')
        click('#noteEditorTools [data-ne-cmd="italic"]')
        check("negrito + itálico juntos aparecem juntos", sorted(ev("__t.pressed('#noteEditorTools')")) == ["bold", "italic"], ev("__t.pressed('#noteEditorTools')"))
        page.keyboard.type("duplo")
        h = ev("__t.html('#noteEditor')")
        check("texto sai negrito e itálico", ("<b><i>duplo</i></b>" in h) or ("<i><b>duplo</b></i>" in h), h)

        # perda de foco (como no iPhone): seleção é restaurada antes de formatar
        page.keyboard.type(" alvo")
        ev("__t.selectText(document.querySelector('#noteEditor'), 'alvo')")
        page.wait_for_timeout(80)
        ev("document.querySelector('#noteTitle').focus()")  # editor perde o foco
        click('#noteEditorTools [data-ne-cmd="underline"]')
        check("formata o trecho certo mesmo após perder o foco", "<u>alvo</u>" in ev("__t.html('#noteEditor')"), ev("__t.html('#noteEditor')"))

        # Limpar reseta tudo
        page.locator("#noteTitle").fill("Rascunho")
        click('#notePrioritySeg [data-prio="Urgente"]')
        click("#noteChecklistAdd"); page.keyboard.type("algo")
        click("#resetNoteForm")
        check("Limpar zera título, texto, prioridade, checklist e pasta",
              ev("document.querySelector('#noteTitle').value") == "" and ev("document.querySelector('#noteEditor').textContent") == ""
              and ev("document.querySelector('#notePrioritySeg [aria-checked=\"true\"]').dataset.prio") == "Media"
              and ev("document.querySelectorAll('#noteChecklistItems .bn-clb-row').length") == 0
              and ev("document.querySelector('#noteFolderPicker [aria-checked=\"true\"]').dataset.folder") == "Entrada")
        if mobile:
            click("#notesCloseForm")
            page.wait_for_timeout(300)
            check("X fecha a folha", not ev("document.querySelector('#noteFormWrap').classList.contains('is-open')"))

        # biblioteca: busca e pastas
        if mobile:
            click("#notesOpenLibrary")
        page.locator("#notesSearch").fill("Reunião")
        page.wait_for_timeout(300)
        check("busca filtra os cartões", ev("document.querySelectorAll('#notesList .bn-card').length") == 1)
        page.locator("#notesSearch").fill("")
        page.wait_for_timeout(300)
        click('#noteFolders [data-note-folder="Trabalho"]')
        check("pasta filtra e fica marcada sozinha", ev("document.querySelectorAll('#noteFolders [aria-pressed=\"true\"]').length") == 1 and ev("[...document.querySelectorAll('#notesList .bn-card')].length") == 3)
        click('#noteFolders [data-note-folder="all"]')
        click("#noteFolders [data-new-folder]")
        page.wait_for_timeout(300)
        check("'+ Pasta' abre a nova nota com o campo de pasta", ev("!document.querySelector('#noteFolderNewRow').hidden") and ev("document.activeElement?.id") == "noteFolderNewInput")
        page.keyboard.press("Escape")
        check("Esc cancela a nova pasta", ev("document.querySelector('#noteFolderNewRow').hidden"))
        if mobile:
            click("#notesCloseForm"); page.wait_for_timeout(300)

        # favorito no cartão
        first = ev("document.querySelector('#notesList .bn-card').dataset.noteId")
        was = ev(f"document.querySelector('#notesList .bn-card[data-note-id=\"{first}\"] .bn-star').getAttribute('aria-pressed')")
        click(f'#notesList .bn-card[data-note-id="{first}"] .bn-star')
        page.wait_for_timeout(200)
        now = ev(f"document.querySelector('#notesList .bn-card[data-note-id=\"{first}\"] .bn-star').getAttribute('aria-pressed')")
        check("estrela favorita alterna", was != now)
        if not mobile:
            check("estrela não abre/fecha a nota por engano", ev("!document.querySelector('#noteDetailModal').hidden"))

        # painel (computador): trocar de nota salva a anterior
        cards = ev("[...document.querySelectorAll('#notesList .bn-card')].map(c => c.dataset.noteId)")
        if mobile:
            ev(f"openNoteDetail('{cards[1]}')")
        else:
            page.locator(f'#notesList .bn-card[data-note-id="{cards[1]}"]').click()
        page.wait_for_timeout(300)
        ev("__t.caretEnd(document.querySelector('#ndBody'))")
        page.keyboard.type(" EDITADO")
        if mobile:
            # voltar do celular (gesto/botão) fecha e guarda
            page.go_back()
            page.wait_for_timeout(700)
            check("voltar do celular fecha a nota", ev("document.querySelector('#noteDetailModal').hidden"))
        else:
            page.locator(f'#notesList .bn-card[data-note-id="{cards[2]}"]').click()
            page.wait_for_timeout(300)
            check("troca de nota no painel abre a outra", ev("document.querySelector('#notesList .bn-card.is-selected')?.dataset.noteId") == cards[2])
        page.wait_for_timeout(1300)
        stored = ev("__t.stored()")
        n1 = next((n for n in stored["notes"] if n["id"] == cards[1]), {})
        check("edição da nota anterior foi guardada", "EDITADO" in n1.get("description", ""), n1.get("description", "")[:80])

        # excluir com desfazer
        if mobile:
            ev(f"openNoteDetail('{cards[2]}')")
            page.wait_for_timeout(300)
        total = ev("document.querySelectorAll('#notesList .bn-card').length")
        click("#ndMenuBtn")
        check("menu ⋮ abre", ev("!document.querySelector('#ndMenu').hidden"))
        click("#ndDeleteBtn")
        page.wait_for_timeout(700)
        check("excluir tira a nota", ev("document.querySelectorAll('#notesList .bn-card').length") == total - 1)
        ev("document.querySelector('#toast .toast-action')?.click()")
        page.wait_for_timeout(300)
        check("desfazer devolve a nota", ev("document.querySelectorAll('#notesList .bn-card').length") == total)

        # virar tarefa
        if mobile:
            ev(f"openNoteDetail('{cards[0]}')")
        else:
            page.locator(f'#notesList .bn-card[data-note-id="{cards[0]}"]').click()
        page.wait_for_timeout(300)
        click("#ndConvertTaskBtn")
        page.wait_for_timeout(800)
        check("virar tarefa leva ao Planner", ev("document.body.dataset.activeView") == "planner")
        check("nota fechou antes de trocar de tela", ev("document.querySelector('#noteDetailModal').hidden") or not mobile)

        # estado vazio: botão "Nova nota" funciona
        ev("setView('notes')")
        page.wait_for_timeout(300)
        page.locator("#notesSearch").fill("zzzz-nada")
        page.wait_for_timeout(300)
        check("busca sem resultado mostra estado vazio", "Nada por aqui" in ev("document.querySelector('#notesList').innerText"))
        page.locator("#notesSearch").fill("")
        check("sem erros de página", not errors, "; ".join(errors[:3]))
        browser.close()


for m in (["mobile", "desktop"] if len(sys.argv) < 2 else [sys.argv[1]]):
    run(m)
fails = [r for r in results if not r[0]]
print(f"\nTOTAL: {len(results) - len(fails)}/{len(results)} passaram")
sys.exit(1 if fails else 0)
