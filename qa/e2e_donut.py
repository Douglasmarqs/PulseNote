import sys
import os
exec(open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "e2e_notes.py")).read().split("def run(mode):")[0])
for mobile in (True, False):
    print("=== donut", "mobile" if mobile else "desktop")
    with sync_playwright() as p:
        b = p.chromium.launch(args=["--no-sandbox"])
        ctx = b.new_context(viewport={"width":390,"height":844} if mobile else {"width":1440,"height":900}, has_touch=mobile)
        page = ctx.new_page(); page.route("**/*", route); errs=[]; page.on("pageerror", lambda e: errs.append(str(e)))
        page.goto(URL); page.wait_for_timeout(2500); ev = page.evaluate
        ev("document.querySelector('.bd-cats').scrollIntoView({block:'center'})"); page.wait_for_timeout(1200)
        def slice_point(i):
            return ev(f"""(() => {{ const svg=document.querySelector('.bd-donut svg'); const r=svg.getBoundingClientRect(); const seg=document.querySelector('.bd-donut-seg-g[data-cat-index="{i}"] .bd-donut-seg'); const L=seg.getTotalLength(); const pt=seg.getPointAtLength(L/2); const k=r.width/200; return [r.x+pt.x*k, r.y+pt.y*k]; }})()""")
        tap = (lambda x,y: page.touchscreen.tap(x,y)) if mobile else (lambda x,y: page.mouse.click(x,y))
        x,y = slice_point(0); tap(x,y); page.wait_for_timeout(300)
        check("tocar na fatia seleciona a categoria", "Moradia" in ev("document.querySelector('.bd-donut-center').innerText") and ev("document.querySelector('.bd-cat-row[data-cat-index=\"0\"]').getAttribute('aria-pressed')") == "true")
        check("só uma fatia ativa", ev("document.querySelectorAll('.bd-donut-seg-g.is-active').length") == 1 or not mobile)
        x,y = slice_point(2); tap(x,y); page.wait_for_timeout(300)
        check("tocar em outra troca a seleção", "Transporte" in ev("document.querySelector('.bd-donut-center').innerText") and ev("document.querySelectorAll('.bd-cat-row[aria-pressed=\"true\"]').length") == 1)
        tap(x,y); page.wait_for_timeout(300)
        if mobile:
            check("tocar de novo volta ao total", "Total gasto" in ev("document.querySelector('.bd-donut-center').innerText"))
        x,y = slice_point(1); tap(x,y); page.wait_for_timeout(200)
        c = ev("(()=>{const r=document.querySelector('.bd-donut-center').getBoundingClientRect();return [r.x+r.width/2,r.y+r.height/2]})()")
        tap(c[0], c[1]); page.wait_for_timeout(300)
        if mobile:
            check("tocar no centro volta ao total", "Total gasto" in ev("document.querySelector('.bd-donut-center').innerText"))
        # toque longo: sem seleção de texto
        if mobile:
            cdp = ctx.new_cdp_session(page)
            cdp.send("Input.dispatchTouchEvent", {"type":"touchStart","touchPoints":[{"x":c[0],"y":c[1]}]}); page.wait_for_timeout(900)
            cdp.send("Input.dispatchTouchEvent", {"type":"touchEnd","touchPoints":[]}); page.wait_for_timeout(200)
            check("toque longo não seleciona texto", ev("window.getSelection().toString()") == "")
        check("texto do gráfico não é selecionável", ev("getComputedStyle(document.querySelector('.bd-cats-viz')).userSelect") == "none")
        page.locator(".bd-cat-row[data-cat-index='3']").focus(); page.keyboard.press("Enter"); page.wait_for_timeout(200)
        check("teclado: Enter na legenda seleciona", ev("document.querySelector('.bd-cat-row[data-cat-index=\"3\"]').getAttribute('aria-pressed')") == "true")
        page.keyboard.press("ArrowDown"); page.wait_for_timeout(200)
        check("teclado: seta passa para a próxima", ev("document.querySelector('.bd-cat-row[data-cat-index=\"4\"]').getAttribute('aria-pressed')") == "true")
        page.keyboard.press("Escape"); page.wait_for_timeout(200)
        check("Esc volta ao total", ev("document.querySelectorAll('.bd-cat-row[aria-pressed=\"true\"]').length") == 0)
        ev("setView('planner')"); page.wait_for_timeout(200); ev("setView('dashboard')"); page.wait_for_timeout(200)
        check("sem erros", not errs, errs[:2])
        b.close()
fails=[r for r in results if not r[0]]; print(f"TOTAL: {len(results)-len(fails)}/{len(results)}"); sys.exit(1 if fails else 0)
