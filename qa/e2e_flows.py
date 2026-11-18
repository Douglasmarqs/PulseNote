"""E2E de Início, Pulsinho, Planner e Finanças (celular + computador) e virada do dia."""
import os
import sys
src = open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "e2e_notes.py")).read().split("def run(mode):")[0]
exec(src)


def open_page(p, mobile, clock=None):
    browser = p.chromium.launch(args=["--no-sandbox"])
    ctx = browser.new_context(viewport={"width": 390, "height": 844} if mobile else {"width": 1440, "height": 900}, has_touch=mobile, timezone_id="America/Sao_Paulo")
    ctx.add_init_script(JS_HELPERS)
    page = ctx.new_page()
    if clock:
        page.clock.install(time=clock)
    page.route("**/*", route)
    errors = []
    page.on("pageerror", lambda e: errors.append(str(e)))
    page.goto(URL)
    page.wait_for_timeout(2500)
    return browser, page, errors


def run(mode):
    mobile = mode == "mobile"
    print(f"\n=== Fluxos — {mode} ===")
    with sync_playwright() as p:
        browser, page, errors = open_page(p, mobile)
        ev = page.evaluate
        click = (lambda sel: page.locator(sel).first.tap()) if mobile else (lambda sel: page.locator(sel).first.click())

        # ── Início x Planner ─────────────────────────────────
        home = ev("""(() => { const chips = [...document.querySelectorAll('#bdTodaySummary .bd-ts')].map(c => c.innerText.replace(/\\s+/g,' ').trim()); return chips; })()""")
        ev("setView('planner')"); page.wait_for_timeout(300)
        click("[data-planner-tab=day]"); page.wait_for_timeout(300)
        day_tasks = ev("document.querySelectorAll('#plannerDayAllday .bp-task').length")
        day_done = ev("document.querySelectorAll('#plannerDayAllday .bp-task.is-done').length")
        day_events = ev("document.querySelectorAll('#plannerDayTimeline [data-event-id]').length")
        overdue = ev("(() => { setPlannerTab ? 0 : 0; return 0; })()") if False else None
        click("[data-planner-tab=list]"); page.wait_for_timeout(300)
        overdue = ev("document.querySelectorAll('[data-group=\"overdue\"] .bp-task').length")
        check("Início: compromissos = Planner (Dia)", any(c.startswith(f"{day_events} compromisso") for c in home), f"{home} vs {day_events}")
        check("Início: tarefas feitas/total = Planner (Dia)", any(c.startswith(f"{day_done}/{day_tasks} tarefa") for c in home), f"{home} vs {day_done}/{day_tasks}")
        check("Início: atrasadas = grupo Atrasadas do Planner", any(c.startswith(f"{overdue} atrasada") for c in home) if overdue else not any("atrasada" in c for c in home), f"{home} vs {overdue}")
        check("Início: sem chip de contas quando nada vence hoje", not any("conta" in c for c in home), home)
        ev("setView('dashboard')"); page.wait_for_timeout(300)
        click("#bdTodaySummary .bd-ts.tone-blue")
        page.wait_for_timeout(400)
        check("chip de compromissos abre o Planner no Dia de hoje", ev("document.body.dataset.activeView") == "planner" and ev("document.querySelector('[data-planner-subview=\"day\"]').classList.contains('active')") and ev("document.querySelector('#plannerDayToday').hidden"))

        # ── Planner: Dia, Semana, Mês ────────────────────────
        click("#plannerDayNext")
        check("fora de hoje aparece a pílula 'Hoje'", not ev("document.querySelector('#plannerDayToday').hidden") and "Amanhã" in ev("document.querySelector('#plannerDayLabel').textContent"))
        click("#plannerDayToday")
        check("'Hoje' volta e some", ev("document.querySelector('#plannerDayToday').hidden") and "Hoje" in ev("document.querySelector('#plannerDayLabel').textContent"))
        click("[data-planner-tab=week]"); page.wait_for_timeout(200)
        check("Semana atual marcada e sem botão extra", "Esta semana" in ev("document.querySelector('#plannerWeekLabel').textContent") and ev("document.querySelector('#plannerWeekToday').hidden"))
        click("#plannerWeekNext")
        check("outra semana mostra 'Hoje'", not ev("document.querySelector('#plannerWeekToday').hidden"))
        click("#plannerWeekToday")
        click("[data-planner-tab=month]"); page.wait_for_timeout(200)
        today = ev("document.querySelector('#plannerMonthGrid .planner-month-cell.is-today').dataset.monthDay")
        check("mês abre com hoje selecionado", ev("document.querySelector('#plannerMonthGrid .is-selected').dataset.monthDay") == today)
        other = ev("[...document.querySelectorAll('#plannerMonthGrid [data-month-day]')].find(c => c.dataset.monthDay !== '%s' && c.classList.contains('has-items')).dataset.monthDay" % today)
        click(f'#plannerMonthGrid [data-month-day="{other}"]')
        check("tocar num dia seleciona só ele", ev("document.querySelectorAll('#plannerMonthGrid .is-selected').length") == 1 and ev("document.querySelector('#plannerMonthGrid .is-selected').dataset.monthDay") == other)
        check("agenda do dia tocado aparece embaixo", ev("document.querySelectorAll('#plannerMonthDay .bp-task, #plannerMonthDay .bp-event').length") > 0)
        click("#plannerMonthDay [data-month-add]"); page.wait_for_timeout(300)
        check("'+' do dia cria com a data do dia tocado", ev("document.querySelector('#pqaTaskDue').value") == other)
        ev("document.querySelector('#plannerQuickAddModal .icon-button, #plannerQuickAddClose')?.click()"); page.wait_for_timeout(200)
        if not ev("document.querySelector('#plannerQuickAddModal').hidden"):
            page.keyboard.press("Escape"); page.wait_for_timeout(200)
        click(f'#plannerMonthGrid [data-month-day="{other}"]')
        page.wait_for_timeout(300)
        check("segundo toque no dia abre a lente Dia", ev("document.querySelector('[data-planner-subview=\"day\"]').classList.contains('active')"))
        click("[data-planner-tab=month]")
        click("#plannerMonthNext")
        check("outro mês mostra 'Hoje'", not ev("document.querySelector('#plannerMonthToday').hidden"))
        click("#plannerMonthToday")
        check("'Hoje' volta ao mês atual", ev("document.querySelector('#plannerMonthToday').hidden"))

        # ── Foco da semana ───────────────────────────────────
        click("[data-planner-tab=list]"); page.wait_for_timeout(200)
        # segunda meta (via formulário real) para testar a troca automática
        ev("openPlannerQuickAdd('goal')"); page.wait_for_timeout(200)
        page.locator("#pqaTitle").fill("Correr 20 km")
        page.locator("#plannerQuickAddForm [type=submit]").click(); page.wait_for_timeout(400)
        check("pager aparece com 2 metas", "/2" in ev("document.querySelector('.wf-pager')?.innerText || ''"))
        if ev("document.querySelector('.wf').dataset.goal") != "preview-goal-1":
            click(".wf [data-focus-action=next]")
        check("pager leva à meta do relatório", ev("document.querySelector('.wf').dataset.goal") == "preview-goal-1")
        p0 = ev("document.querySelector('.wf-ring').getAttribute('aria-label')")
        click(".wf [data-focus-action=expand]")
        check("Ver etapas abre a lista", ev("document.querySelectorAll('.wf-list .wf-item').length") > 0)
        click(".wf [data-focus-action=expand]")
        check("Ocultar etapas fecha", ev("document.querySelectorAll('.wf-list').length") == 0)
        goal_before = ev("document.querySelector('.wf').dataset.goal")
        click(".wf-advance")
        page.wait_for_timeout(300)
        check("Concluir etapa avança o anel", ev("document.querySelector('.wf-ring').getAttribute('aria-label')") != p0)
        check("meta concluída mostra 'Meta concluída'", "Meta concluída" in ev("document.querySelector('.wf-main p').textContent"))
        page.wait_for_timeout(3000)
        check("foco passa sozinho para a próxima meta aberta", ev("document.querySelector('.wf').dataset.goal") != goal_before)
        click(".wf [data-focus-action=prev]")
        check("pager volta para a meta anterior", ev("document.querySelector('.wf').dataset.goal") == goal_before)
        click(".wf .wf-icon[data-focus-action=step]")
        check("desfazer etapa reabre a meta", "Meta concluída" not in ev("document.querySelector('.wf-main p').textContent"))
        # grupos
        click('[data-group-toggle="today"]')
        check("grupo recolhe", ev("document.querySelector('[data-group=\"today\"]').classList.contains('is-collapsed')"))
        click('[data-group-toggle="today"]')
        check("grupo abre", not ev("document.querySelector('[data-group=\"today\"]').classList.contains('is-collapsed')"))
        check("sem botão flutuante no Planner", ev("!document.querySelector('#plannerFab')"))

        # ── Pulsinho ─────────────────────────────────────────
        ev("setView('dashboard')"); page.wait_for_timeout(300)
        if mobile:
            check("balão visível no Início", ev("getComputedStyle(document.querySelector('#bdChatTeaser')).display") != "none")
            check("campo do chat escondido no balão", ev("getComputedStyle(document.querySelector('#pulseCommandForm')).display") == "none")
            check("chamada contextual com saudação", "," in ev("document.querySelector('#bdChatTeaserText').textContent"))
            ev("document.querySelector('#bdChat').scrollIntoView({block:'center'})"); page.wait_for_timeout(200)
            click("#bdChatTeaserOpen"); page.wait_for_timeout(600)
            check("tocar no balão abre a conversa", ev("document.querySelector('#bdChat').classList.contains('is-convo')"))
            box = ev("(() => { const r = document.querySelector('#bdChat').getBoundingClientRect(); return [r.top, r.height]; })()")
            check("conversa ocupa a tela", box[0] < 30 and box[1] > 700, box)
            check("sugestões aparecem na conversa", not ev("document.querySelector('#bdChatSuggest').hidden") or ev("document.querySelectorAll('.bd-msg--user').length") > 0)
            page.keyboard.press("Escape"); page.wait_for_timeout(600)
            check("Esc fecha e volta ao balão", not ev("document.querySelector('#bdChat').classList.contains('is-convo')") and ev("!document.querySelector('#bdChatPlaceholder')"))
            users_before = ev("document.querySelectorAll('#pulseCommandResponse .bd-msg--user').length")
            click("#bdChatTeaserActions [data-teaser-action='0']"); page.wait_for_timeout(900)
            check("atalho do balão abre e envia/prefill", ev("document.querySelector('#bdChat').classList.contains('is-convo')") and (ev("document.querySelectorAll('#pulseCommandResponse .bd-msg--user').length") > users_before or ev("document.querySelector('#pulseCommandInput').value") != ""))
            click("#bdChatClose"); page.wait_for_timeout(600)
            check("botão ⌄ fecha", not ev("document.querySelector('#bdChat').classList.contains('is-convo')"))
            check("rolagem destravada", not ev("document.documentElement.classList.contains('pn-scroll-locked')"))
        else:
            check("computador: painel do chat completo, sem balão", ev("getComputedStyle(document.querySelector('#bdChatTeaser')).display") == "none" and ev("getComputedStyle(document.querySelector('#pulseCommandForm')).display") != "none")
        check("sem mãozinha 👋", "👋" not in ev("document.querySelector('#bdChat').innerHTML"))

        # ── Finanças ─────────────────────────────────────────
        ev("setView('finances')"); page.wait_for_timeout(500)
        check("Receitas com linha do mês e bolinha", ev("document.querySelector('#finKpis .bf-kpi--in').classList.contains('has-pulse')") and ev("!!document.querySelector('.bf-spark-dot')"))
        inside = ev("""(() => { const d = document.querySelector('.bf-spark-dot').getBoundingClientRect(); const c = document.querySelector('.bf-kpi--in').getBoundingClientRect(); return d.left >= c.left && d.right <= c.right && d.top >= c.top && d.bottom <= c.bottom; })()""")
        check("bolinha inteira dentro do cartão (não corta)", inside)
        ev("document.querySelector('#finMonthNext').click()"); page.wait_for_timeout(300)
        check("mês futuro sem lançamentos: sem linha", not ev("document.querySelector('#finKpis .bf-kpi--in').classList.contains('has-pulse')"))
        ev("document.querySelector('#finMonthPrev').click()"); page.wait_for_timeout(300)
        ev("setView('dashboard')"); page.wait_for_timeout(300)
        dot_ok = ev("""(() => { const s = document.querySelector('#bdEvoChart svg'); const d = s.querySelector('.dot'); const r = d.getBoundingClientRect(); const h = document.querySelector('#bdEvoChart').getBoundingClientRect(); return r.left >= h.left && r.right <= h.right && r.top >= h.top && r.bottom <= h.bottom; })()""")
        check("bolinha do gráfico de saldo inteira", dot_ok)
        check("sem erros de página", not errors, "; ".join(errors[:3]))
        browser.close()


def run_midnight():
    print("\n=== Virada do dia (app aberto) ===")
    with sync_playwright() as p:
        browser, page, errors = open_page(p, True, clock="2026-11-18T23:59:20-03:00")
        ev = page.evaluate
        d0 = ev("document.querySelector('#bdDateText')?.textContent || ''")
        ev("setView('planner')")
        ev("document.querySelector('[data-planner-tab=day]').click()")
        label0 = ev("document.querySelector('#plannerDayLabel').textContent")
        page.clock.run_for(70_000)
        page.wait_for_timeout(300)
        label1 = ev("document.querySelector('#plannerDayLabel').textContent")
        check("lente Dia vira para o novo dia sozinha", "19" in label1 and "Hoje" in label1, f"{label0} -> {label1}")
        check("sem erros", not errors, "; ".join(errors[:2]))
        browser.close()


for m in (["mobile", "desktop"] if len(sys.argv) < 2 else [sys.argv[1]]):
    run(m)
run_midnight()
fails = [r for r in results if not r[0]]
print(f"\nTOTAL: {len(results) - len(fails)}/{len(results)} passaram")
sys.exit(1 if fails else 0)
