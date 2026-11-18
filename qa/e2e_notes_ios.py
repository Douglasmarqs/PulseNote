"""Notas: comportamento estilo iPhone — botão acende no toque (antes de digitar),
cor pendente, foco que pisca ao tocar na barra e texto x checklist sem sobrepor."""
import sys, os
exec(open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "e2e_notes.py")).read().split("def run(mode):")[0])

LONG = '<ul><li>vvvbbbbb<b>vvgggddd</b><i>xdvvvvvv</i> <mark>cccccccc rnthjrhfff j</mark> kkkkkkkkjjjjjjjjjjjjjjjjjjjjjjjjjj. jjjjjjjjjkllllllkkjjkkkkkkkllllllllllllllleejjdjdjkrkdj djdj <mark>kkkkkkkkk</mark>kmk</li><li>kkkkkkkkkkkkk</li></ul><ol><li>kkkkkk</li><li>kkk</li></ol><span style="color: rgb(139, 92, 246);">jdjsjsjdjdkkdkdkdkk</span><span style="color: rgb(255, 55, 95);">djrjejjrjrjrkj</span><span style="color: rgb(48, 209, 88);">xxxxxxxxxjdjdjdjdjdjddjdjjdjxjjdjdjdjdjdjdjdjdjdjdjdjd</span>'

for theme in ("aurora", "light"):
    for mobile in (True, False):
        print(f"=== iPhone-like — {'mobile' if mobile else 'desktop'} / {theme}")
        with sync_playwright() as p:
            b = p.chromium.launch(args=["--no-sandbox"], **({"executable_path": "/usr/bin/google-chrome"} if os.path.exists("/usr/bin/google-chrome") else {}))
            ctx = b.new_context(viewport={"width": 390, "height": 844} if mobile else {"width": 1440, "height": 900}, has_touch=mobile)
            ctx.add_init_script(JS_HELPERS)
            ctx.add_init_script(f"try{{localStorage.setItem('pulsenote-theme','{theme}')}}catch(e){{}}")
            page = ctx.new_page(); page.route("**/*", route); errs = []; page.on("pageerror", lambda e: errs.append(str(e)))
            page.goto(URL); page.wait_for_timeout(2500); ev = page.evaluate
            click = (lambda sel: page.locator(sel).first.tap()) if mobile else (lambda sel: page.locator(sel).first.click())
            ev("setView('notes')"); page.wait_for_timeout(300)
            nid = ev("document.querySelector('#notesList .bn-card').dataset.noteId")
            ev(f"openNoteDetail('{nid}')"); page.wait_for_timeout(400)

            # texto longo + checklist: não podem se sobrepor
            ev(f"(() => {{ const b = document.querySelector('#ndBody'); b.innerHTML = {LONG!r}; b.dispatchEvent(new Event('input')); }})()")
            page.wait_for_timeout(200)
            gap = ev("""(() => { const b = document.querySelector('#ndBody').getBoundingClientRect(); const c = document.querySelector('#ndChecklistSection'); if (c.hidden) return 999; return c.getBoundingClientRect().top - b.bottom; })()""")
            fits = ev("(() => { const b = document.querySelector('#ndBody'); return b.scrollHeight <= b.clientHeight + 1; })()")
            check("texto longo não passa por cima do checklist", gap >= 0 and fits, f"gap={gap} fits={fits}")

            # cada botão acende NO TOQUE, mesmo se o iPhone "mudar a forma" do cursor
            ev("__t.caretEnd(document.querySelector('#ndBody'))")
            for cmd in ["bold", "italic", "underline", "strike"]:
                click(f'#noteDetailToolbar [data-nd-cmd="{cmd}"]')
                # iPhone: reposiciona o mesmo ponto de outro jeito (nó pai + índice)
                ev("""(() => { const s = getSelection(); const r = s.getRangeAt(0); const n = r.startContainer;
                  if (n.nodeType === 3 && r.startOffset === n.length) { const parent = n.parentNode; const idx = [...parent.childNodes].indexOf(n) + 1; const r2 = document.createRange(); r2.setStart(parent, idx); r2.collapse(true); s.removeAllRanges(); s.addRange(r2); } })()""")
                page.wait_for_timeout(60)
                check(f"{cmd}: acende na hora do toque (antes de digitar)", ev("__t.pressed('#noteDetailToolbar')") == [cmd], ev("__t.pressed('#noteDetailToolbar')"))
                click(f'#noteDetailToolbar [data-nd-cmd="{cmd}"]')
                check(f"{cmd}: apaga no segundo toque", ev("__t.pressed('#noteDetailToolbar')") == [], ev("__t.pressed('#noteDetailToolbar')"))

            # foco "pisca" ao tocar na barra (iPhone): estado continua certo
            ev("document.querySelector('#ndBody').blur()")
            ev("__t.caretEnd(document.querySelector('#ndBody'))")
            click('#noteDetailToolbar [data-nd-cmd="italic"]')
            ev("document.querySelector('#ndBody').blur()"); page.wait_for_timeout(50)
            ev("document.querySelector('#ndBody').focus()"); page.wait_for_timeout(50)
            check("itálico continua aceso depois do foco piscar", "italic" in ev("__t.pressed('#noteDetailToolbar')"), ev("__t.pressed('#noteDetailToolbar')"))
            page.keyboard.type("ital")
            check("e o texto sai itálico", "ital</i>" in ev("__t.html('#ndBody')"))
            click('#noteDetailToolbar [data-nd-cmd="italic"]')

            # cor: acende na hora (painel e traço no Aa), antes de digitar
            ev("__t.caretEnd(document.querySelector('#ndBody'))")
            click('#noteDetailToolbar [data-nd-cmd="more"]')
            click('#noteDetailToolbar [data-nd-color="#ff375f"]')
            page.wait_for_timeout(60)
            check("cor: amostra marcada na hora do toque", ev("document.querySelector('[data-nd-color=\"#ff375f\"]').getAttribute('aria-pressed')") == "true")
            check("cor: 'Aa' mostra a cor escolhida", ev("document.querySelector('[data-nd-cmd=\"more\"]').classList.contains('has-color')"))
            check("só uma amostra marcada", ev("document.querySelectorAll('[data-nd-color][aria-pressed=\"true\"]').length") == 1)
            page.keyboard.type("vermelho")
            h = ev("__t.html('#ndBody')")
            check("texto digitado sai na cor", "vermelho" in h and ("255, 55, 95" in h or "ff375f" in h.lower()), h[-160:])
            click('#noteDetailToolbar [data-nd-color="#0a84ff"]')
            check("trocar de cor marca só a nova", ev("[...document.querySelectorAll('[data-nd-color][aria-pressed=\"true\"]')].map(e=>e.dataset.ndColor)") == ["#0a84ff"])
            page.keyboard.type("azul")
            check("nova cor aplicada no que vem depois", "azul" in ev("__t.html('#ndBody')") and ("10, 132, 255" in ev("__t.html('#ndBody')") or "0a84ff" in ev("__t.html('#ndBody')").lower()))

            # marca-texto + cor pendente
            ev("__t.caretEnd(document.querySelector('#ndBody'))")
            click('#noteDetailToolbar [data-nd-cmd="highlight"]')
            check("marca-texto acende na hora", "highlight" in ev("__t.pressed('#noteDetailToolbar')"))
            click('#noteDetailToolbar [data-nd-cmd="highlight"]')

            # checklist: remover todos os itens esconde a área
            items = ev("document.querySelectorAll('#ndChecklistItems .bn-check-row').length")
            for _ in range(items):
                click('#ndChecklistItems .bn-check-row:last-child [data-nd-check-del]')
                page.wait_for_timeout(80)
            page.wait_for_timeout(250)
            check("sem itens, a área da checklist some", ev("document.querySelector('#ndChecklistSection').hidden"))
            page.screenshot(path=f"/home/claude/shots/ios_{'m' if mobile else 'd'}_{theme}.png")
            check("sem erros", not errs, errs[:2])
            b.close()
fails = [r for r in results if not r[0]]; print(f"TOTAL: {len(results)-len(fails)}/{len(results)}"); sys.exit(1 if fails else 0)
