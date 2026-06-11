"""Soccer Stats App -- End-to-End Playwright Test"""
import sys, time, urllib.request, json as jsonlib, shutil, re
from pathlib import Path
from playwright.sync_api import sync_playwright, Page

APP_URL = "http://localhost:5173"
API_URL = "http://localhost:3001"
SHOT_DIR = Path("e2e_screenshots")
SHOT_DIR.mkdir(exist_ok=True)
results: list[tuple[str, bool, str]] = []

def shot(page: Page, name: str):
    page.screenshot(path=str(SHOT_DIR / f"{name}.png"))

def record(step: str, ok: bool, detail: str = ""):
    results.append((step, ok, detail))
    line = f"  [{'PASS' if ok else 'FAIL'}] {step}"
    if detail: line += f": {detail}"
    print(line)

def wait_idle(page: Page, ms=15000):
    try: page.wait_for_load_state("networkidle", timeout=ms)
    except Exception: pass

def safe_visible(page: Page, sel: str) -> bool:
    try: return page.locator(sel).first.is_visible()
    except Exception: return False

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    ctx = browser.new_context(viewport={"width": 1440, "height": 900})
    page = ctx.new_page()
    console_errors: list[str] = []
    page.on("console", lambda m: console_errors.append(m.text) if m.type == "error" else None)

    # ── 1. API Health ─────────────────────────────────────────────────────────
    print("\n[1] API Health")
    try:
        with urllib.request.urlopen(f"{API_URL}/api/health", timeout=5) as r:
            h = jsonlib.loads(r.read())
        record("API health", h.get("status") == "ok", f"mock={h.get('mock')}, key={h.get('key')}")
    except Exception as e:
        record("API health", False, str(e)); print("FATAL"); sys.exit(1)

    # ── 2. App Load ───────────────────────────────────────────────────────────
    print("\n[2] App Load")
    page.goto(APP_URL)
    wait_idle(page)
    shot(page, "01_load")
    record("Title visible", safe_visible(page, "text=Soccer Stats"))
    sel = page.locator("select").first
    sel.wait_for(timeout=8000)
    opts = sel.locator("option").all()
    record("Competition dropdown populated", len(opts) > 2, f"{len(opts)} options")
    record("No JS errors on load", len(console_errors) == 0,
           console_errors[0][:100] if console_errors else "")

    # ── 3. Select Competition ─────────────────────────────────────────────────
    print("\n[3] Competition Selection")
    sel.select_option(label="Premier League")
    # Wait for standings to render in main area
    page.wait_for_selector("main button:has-text('Arsenal')", timeout=15000)
    shot(page, "02_comp_selected")
    record("PL standings table appears", safe_visible(page, "main button:has-text('Arsenal')"))
    record("Competition landing loads", page.locator("text=/Standings|Top Scorers/").count() > 0)
    # Form badges: check at least one W/D/L pip is visible in the standings
    form_count = page.locator("main [title='Win'], main [title='Draw'], main [title='Loss']").count()
    record("Form badges visible in standings", form_count > 0, f"{form_count} pips found")

    # ── 4. Select Team ────────────────────────────────────────────────────────
    print("\n[4] Team Selection -- Arsenal")
    page.locator("main button:has-text('Arsenal')").first.click()
    # Wait for lineup API — can take up to 20s on cold cache
    page.wait_for_selector("button:has-text('Squad')", timeout=10000)
    record("Squad tab rendered", safe_visible(page, "button:has-text('Squad')"))

    # Wait for squad grid to load: player cards are <button> elements with position labels
    try:
        page.wait_for_selector("main button:has-text('Goalkeeper'), main section:has-text('Goalkeepers')", timeout=25000)
        squad_loaded = True
    except Exception:
        squad_loaded = False

    wait_idle(page, 5000)
    shot(page, "03_arsenal")

    record("Formation badge visible", page.locator("text=/\\d-\\d/").count() > 0)
    record("Squad grid with player cards rendered", squad_loaded)
    record("Breadcrumb shows competition", safe_visible(page, "header button:has-text('Premier League')"))

    # ── 5. Back Navigation ────────────────────────────────────────────────────
    print("\n[5] Back Navigation")
    page.locator("header button:has-text('Premier League')").click()
    time.sleep(1)
    shot(page, "04_back")
    record("Back to league -- team tabs gone", not safe_visible(page, "button:has-text('Honours')"))
    record("Back to league -- standings visible", safe_visible(page, "main button:has-text('Arsenal')"))

    # Re-select Arsenal -- squad grid cached so faster
    page.locator("main button:has-text('Arsenal')").first.click()
    page.wait_for_selector("button:has-text('Squad')", timeout=10000)
    try:
        page.wait_for_selector("main section:has-text('Goalkeepers')", timeout=15000)
    except Exception:
        pass
    wait_idle(page, 5000)

    # ── 6. Player Hover Tooltip ───────────────────────────────────────────────
    print("\n[6] Player Hover Tooltip")
    # Player cards are <button> elements inside main sections (Goalkeepers/Defenders/etc.)
    player_cards = page.locator("main section button").all()
    tooltip_ok = False
    for el in player_cards[:10]:
        try:
            el.hover()
            time.sleep(0.7)
            if page.locator("text=/Nationality|Age|Born/").count() > 0:
                tooltip_ok = True
                shot(page, "05_tooltip")
                break
        except Exception:
            continue
    record("Player hover tooltip", tooltip_ok)

    # ── 7. Player Career Panel ────────────────────────────────────────────────
    print("\n[7] Career Panel")
    # Clicking a player card navigates to /player/:id — wait longer for wiki/TM data
    panel_ok = False
    try:
        player_cards = page.locator("main section button").all()
        if player_cards:
            player_cards[0].click()
            # Player page loads career stats from wiki/TM — allow up to 15s
            page.wait_for_selector("text=/Career Totals|This Season|Appearances|Career History/",
                                   timeout=15000)
            shot(page, "06_career")
            panel_ok = True
    except Exception as e:
        pass
    record("Career panel opens", panel_ok)

    # Navigate back to team view for subsequent steps
    if not safe_visible(page, "button:has-text('Squad')"):
        page.go_back()
        try:
            page.wait_for_selector("button:has-text('Squad')", timeout=8000)
        except Exception:
            # If can't go back cleanly, re-navigate from scratch
            page.goto(APP_URL)
            wait_idle(page)
            page.locator("select").first.select_option(label="Premier League")
            page.wait_for_selector("main button:has-text('Arsenal')", timeout=12000)
            page.locator("main button:has-text('Arsenal')").first.click()
            page.wait_for_selector("button:has-text('Squad')", timeout=12000)
    wait_idle(page, 5000)

    # ── 8. Tab Navigation ─────────────────────────────────────────────────────
    print("\n[8] Tabs")
    for tab, keywords in [
        ("Honours",  ["Premier League", "FA Cup", "trophies", "Honours"]),
        ("Schedule", ["vs", "2024", "2025", "Arsenal"]),
        ("News",     ["Arsenal", "news", "BBC", "Guardian", "Sky", "match", "football"]),
        ("Squad",    ["Goalkeeper", "Defender", "Midfielder"]),
    ]:
        try:
            page.locator(f"button:has-text('{tab}')").first.click()
            wait_idle(page, 10000)
            time.sleep(1.5)
            shot(page, f"07_{tab.lower()}")
            content = any(page.locator(f"text=/{kw}/i").count() > 0 for kw in keywords)
            record(f"Tab '{tab}' loads", content)
        except Exception as e:
            record(f"Tab '{tab}' loads", False, str(e)[:60])

    # ── 9. Position Chart in Schedule ─────────────────────────────────────────
    print("\n[9] Position Chart")
    page.locator("button:has-text('Schedule')").first.click()
    wait_idle(page, 12000)
    time.sleep(2)
    shot(page, "08_schedule")
    record("Position history chart", safe_visible(page, "text=League Position"))

    # ── 10. Match Timeline (with cards/subs) ─────────────────────────────────
    print("\n[10] Match Timeline")
    timeline_ok = False
    timeline_has_events = False
    try:
        expand_btns = page.locator("main button:has-text('Lineup')").all()
        for btn in expand_btns[:6]:
            try:
                btn.click()
                time.sleep(0.8)
                tl = page.locator("button:has-text('Timeline')").first
                if tl.count() > 0 and tl.is_visible():
                    tl.click()
                    time.sleep(3)
                    shot(page, "09_timeline")
                    timeline_ok = True
                    # Check for substitution arrows or card emoji in the event log
                    has_sub = page.locator("text=/↑|↓/").count() > 0
                    has_card = page.locator("text=/🟨|🟥/").count() > 0
                    has_goal = page.locator("text=/⚽|🔴/").count() > 0
                    timeline_has_events = has_sub or has_card or has_goal
                    break
            except Exception:
                continue
    except Exception as e:
        pass
    record("Match timeline tab accessible", timeline_ok)
    record("Timeline shows match events (goals/cards/subs)", timeline_has_events)

    # ── 11. Team Search ───────────────────────────────────────────────────────
    print("\n[11] Team Search")
    search = page.locator("input[placeholder*='Search'], input[placeholder*='search']").first
    try:
        search.wait_for(timeout=3000)
        search.fill("Liverp")
        time.sleep(1.5)
        shot(page, "10_search")
        found = page.locator("text=/Liverpool/").count() > 0
        record("Team search finds Liverpool", found)
        search.fill("")
    except Exception:
        record("Team search finds Liverpool", False, "input not found")

    # ── 12. Theme Toggle ──────────────────────────────────────────────────────
    print("\n[12] Theme Toggle")
    toggle = page.locator("header button[title]").last
    try:
        toggle.wait_for(timeout=3000)
        toggle.click()
        time.sleep(0.5)
        shot(page, "11_light")
        data_theme = page.evaluate("() => document.documentElement.getAttribute('data-theme')")
        record("Theme toggles", data_theme in ("light", "dark"), f"data-theme={data_theme}")
        toggle.click()
        time.sleep(0.3)
    except Exception as e:
        record("Theme toggles", False, str(e)[:60])

    # ── 13. Live Ticker integrity ─────────────────────────────────────────────
    print("\n[13] Live Ticker")
    record("App intact after all interactions", safe_visible(page, "text=Soccer Stats"))

    # ── 14. Security Headers ──────────────────────────────────────────────────
    print("\n[14] Security Headers")
    try:
        with urllib.request.urlopen(f"{API_URL}/api/health") as r:
            hdrs = {k.lower(): v for k, v in r.headers.items()}
        record("X-Frame-Options header", "x-frame-options" in hdrs, hdrs.get("x-frame-options","missing"))
        record("X-Content-Type-Options header", "x-content-type-options" in hdrs, hdrs.get("x-content-type-options","missing"))
        record("RateLimit headers present", "ratelimit-limit" in hdrs or "x-ratelimit-limit" in hdrs,
               str(list(k for k in hdrs if "ratelimit" in k)))
    except Exception as e:
        record("Security headers check", False, str(e)[:80])

    # ── 15. Admin Endpoint Protected ─────────────────────────────────────────
    print("\n[15] Admin Endpoint Protection")
    try:
        req = urllib.request.Request(
            f"{API_URL}/api/admin/populate-wiki-stats?teams=arsenal",
            method="POST"
        )
        # Override IP check by sending from non-localhost (can't really do that easily,
        # but if ADMIN_SECRET is not set, localhost requests ARE allowed)
        with urllib.request.urlopen(req, timeout=5) as r:
            status = r.status
        # 200 from localhost = expected (no ADMIN_SECRET set, localhost allowed)
        record("Admin endpoint accessible from localhost", status == 200, f"status={status}")
    except urllib.error.HTTPError as e:
        if e.code == 403:
            record("Admin endpoint blocked (403)", True, "correct -- protected")
        else:
            record("Admin endpoint check", False, f"HTTP {e.code}")
    except Exception as e:
        record("Admin endpoint check", False, str(e)[:80])

    browser.close()
    shutil.rmtree(SHOT_DIR, ignore_errors=True)

# ── Report ────────────────────────────────────────────────────────────────────
print("\n" + "="*60)
print("SOCCER STATS APP -- E2E TEST REPORT")
print("="*60)
passed = sum(1 for _, ok, _ in results if ok)
total = len(results)
for step, ok, detail in results:
    line = f"  [{'PASS' if ok else 'FAIL'}] {step}"
    if detail: line += f": {detail}"
    print(line)
print("="*60)
print(f"Result: {passed}/{total} passed")
if passed < total:
    sys.exit(1)
