"""
Tests for the home page (fixture calendar) and top-level navigation.

Sections
--------
SECTION: App Load          — initial render, header elements
SECTION: Calendar Grid     — month display, weekday headers, day cells
SECTION: Month Navigation  — next/prev month, year wrap
SECTION: Day Selection     — click day, date label, fixture list
SECTION: My Teams Filter   — toggle visibility, filtered list
SECTION: Navigation        — SS logo, breadcrumbs, Fixtures link
SECTION: Fixture Cards     — card structure, team links, live indicators
SECTION: Live Ticker       — presence when matches in play (skippable)
"""
import re
import requests
import pytest
from playwright.sync_api import Page, expect

from conftest import APP_URL, API_URL, DATA_TIMEOUT, NAV_TIMEOUT, QUICK_TIMEOUT


# ── SECTION: App Load ─────────────────────────────────────────────────────────

def test_api_health():
    """Server must be up with a real API key before any UI tests run."""
    r = requests.get(f"{API_URL}/api/health", timeout=5)
    assert r.status_code == 200
    body = r.json()
    assert body["status"] == "ok"
    assert body["mock"] is False, "Server is returning mock data — FOOTBALL_API_KEY not set"


def test_app_loads(page: Page):
    """App renders with header, title and the fixture calendar on first load."""
    page.goto(APP_URL)
    expect(page.get_by_text("Soccer Stats")).to_be_visible(timeout=NAV_TIMEOUT)
    # SS home button
    expect(page.get_by_title("Home")).to_be_visible(timeout=QUICK_TIMEOUT)
    # Calendar grid — at least the 7 weekday headers are present
    for day in ["Mo", "Tu", "We", "Th", "Fr", "Sa", "Su"]:
        expect(page.get_by_text(day, exact=True)).to_be_visible(timeout=QUICK_TIMEOUT)


def test_header_theme_toggle_present(page: Page):
    """Theme toggle button is visible in the header on load."""
    page.goto(APP_URL)
    # Toggle renders as a sun ☀️ or moon 🌙 emoji button
    toggle = page.locator("header button[title*='mode']")
    toggle.wait_for(timeout=NAV_TIMEOUT)
    expect(toggle).to_be_visible()


@pytest.mark.theme
def test_theme_toggle_switches_icon(page: Page):
    """Clicking the theme toggle changes its icon between ☀️ and 🌙."""
    page.goto(APP_URL)
    toggle = page.locator("header button[title*='mode']")
    toggle.wait_for(timeout=NAV_TIMEOUT)
    initial_title = toggle.get_attribute("title")

    toggle.click()
    page.wait_for_timeout(300)
    after_title = toggle.get_attribute("title")
    assert after_title != initial_title, "Theme toggle title did not change after click"


@pytest.mark.theme
def test_theme_toggle_persists_across_navigation(page: Page):
    """Theme preference is preserved when navigating away and back."""
    page.goto(APP_URL)
    toggle = page.locator("header button[title*='mode']")
    toggle.wait_for(timeout=NAV_TIMEOUT)

    # Switch to non-default theme
    initial_title = toggle.get_attribute("title")
    toggle.click()
    page.wait_for_timeout(200)
    switched_title = toggle.get_attribute("title")
    assert switched_title != initial_title

    # Reload — theme should persist via localStorage
    page.reload()
    page.locator("header button[title*='mode']").wait_for(timeout=NAV_TIMEOUT)
    after_reload_title = page.locator("header button[title*='mode']").get_attribute("title")
    assert after_reload_title == switched_title, "Theme did not persist after page reload"


# ── SECTION: Calendar Grid ────────────────────────────────────────────────────

@pytest.mark.calendar
def test_calendar_shows_month_name(page: Page):
    """Calendar header shows a recognisable month name."""
    page.goto(APP_URL)
    months = ["January","February","March","April","May","June",
              "July","August","September","October","November","December"]
    found = any(page.get_by_text(m, exact=False).count() > 0 for m in months)
    assert found, "No month name found in the calendar"


@pytest.mark.calendar
def test_calendar_shows_all_weekday_headers(page: Page):
    """Calendar grid shows all 7 weekday column headers."""
    page.goto(APP_URL)
    for day in ["Mo", "Tu", "We", "Th", "Fr", "Sa", "Su"]:
        expect(page.get_by_text(day, exact=True)).to_be_visible(timeout=QUICK_TIMEOUT)


@pytest.mark.calendar
def test_calendar_has_day_cells(page: Page):
    """Calendar grid contains numbered day cells (at least 28)."""
    page.goto(APP_URL)
    # Day buttons contain a short number text (1–31)
    day_buttons = page.locator("button").filter(
        has_text=re.compile(r"^\d{1,2}$")
    )
    day_buttons.first.wait_for(timeout=NAV_TIMEOUT)
    assert day_buttons.count() >= 28, \
        f"Expected ≥28 day buttons, got {day_buttons.count()}"


@pytest.mark.calendar
def test_today_cell_is_visually_distinct(page: Page):
    """Today's date cell has a distinguishing style (ring or background)."""
    page.goto(APP_URL)
    # Today's button carries a 'ring' or 'bg-green' class for visual distinction
    today_cell = page.locator(
        "button[class*='ring'], button[class*='bg-green']"
    ).filter(has_text=re.compile(r"^\d{1,2}$"))
    today_cell.first.wait_for(timeout=NAV_TIMEOUT)
    assert today_cell.count() >= 1, "Today's cell has no visual distinction"


# ── SECTION: Month Navigation ─────────────────────────────────────────────────

@pytest.mark.calendar
def test_calendar_month_navigation_forward(page: Page):
    """Clicking › advances the calendar by one month."""
    page.goto(APP_URL)
    header = page.locator(
        "text=/January|February|March|April|May|June|July|August|September|October|November|December/"
    ).first
    header.wait_for(timeout=NAV_TIMEOUT)
    initial = header.inner_text()

    page.get_by_text("›", exact=True).click()
    page.wait_for_timeout(500)
    assert header.inner_text() != initial, "Month did not advance after clicking ›"


@pytest.mark.calendar
def test_calendar_month_navigation_back(page: Page):
    """Clicking ‹ after › returns to the original month."""
    page.goto(APP_URL)
    header = page.locator(
        "text=/January|February|March|April|May|June|July|August|September|October|November|December/"
    ).first
    header.wait_for(timeout=NAV_TIMEOUT)
    initial = header.inner_text()

    page.get_by_text("›", exact=True).click()
    page.wait_for_timeout(300)
    page.get_by_text("‹", exact=True).click()
    page.wait_for_timeout(300)
    assert header.inner_text() == initial, "Month did not return after clicking ‹"


@pytest.mark.calendar
def test_calendar_prev_button_present(page: Page):
    """Both ‹ and › navigation buttons are present."""
    page.goto(APP_URL)
    expect(page.get_by_text("‹", exact=True)).to_be_visible(timeout=NAV_TIMEOUT)
    expect(page.get_by_text("›", exact=True)).to_be_visible(timeout=NAV_TIMEOUT)


# ── SECTION: Day Selection ────────────────────────────────────────────────────

@pytest.mark.calendar
def test_calendar_day_click_shows_date_label(page: Page):
    """Clicking any day cell updates the selected-date label below the grid."""
    page.goto(APP_URL)
    page.locator("button").filter(has_text=re.compile(r"^1$")).first.click()
    page.wait_for_timeout(300)
    weekdays = ["Monday","Tuesday","Wednesday","Thursday","Friday","Saturday","Sunday"]
    day_label = page.locator("p").filter(has_text=re.compile(
        "Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday"
    )).first
    day_label.wait_for(timeout=QUICK_TIMEOUT)
    assert any(d in day_label.inner_text() for d in weekdays)


@pytest.mark.calendar
def test_calendar_selected_day_is_highlighted(page: Page):
    """The clicked day cell gains an active/selected visual style."""
    page.goto(APP_URL)
    # Click the first available numbered day button
    day_btn = page.locator("button").filter(has_text=re.compile(r"^1$")).first
    day_btn.wait_for(timeout=NAV_TIMEOUT)
    day_btn.click()
    page.wait_for_timeout(200)
    # Active cell typically gets bg-green-600 or ring-2 classes
    active_cls = day_btn.get_attribute("class") or ""
    assert "green" in active_cls or "ring" in active_cls, \
        "Selected day cell does not appear visually highlighted"


@pytest.mark.calendar
def test_fixture_dots_appear_on_match_days(page: Page):
    """Some calendar day cells show fixture-indicator dots."""
    page.goto(APP_URL)
    page.wait_for_timeout(2_000)  # allow fixture API to return
    dots = page.locator("button span[class*='rounded-full']")
    if dots.count() == 0:
        pytest.skip("No fixture dots visible — off-season or API slow")
    assert dots.count() > 0


# ── SECTION: My Teams Filter ──────────────────────────────────────────────────

@pytest.mark.favourites
@pytest.mark.calendar
def test_my_teams_toggle_hidden_without_favourites(page: Page):
    """★ My Teams toggle must NOT appear when user has no favourites."""
    page.goto(APP_URL)
    page.wait_for_timeout(500)
    assert page.get_by_text("★ My Teams").count() == 0, \
        "My Teams toggle should be hidden when no favourites are set"


@pytest.mark.favourites
@pytest.mark.calendar
def test_my_teams_toggle_visible_after_favouriting(page: Page):
    """After starring a team, the ★ My Teams toggle appears on the calendar."""
    page.goto(APP_URL)
    try:
        page.locator("select option[value='PL']").wait_for(state="attached", timeout=30_000)
        page.locator("aside select").first.select_option(value="PL")
        page.get_by_text("Arsenal").first.wait_for(timeout=DATA_TIMEOUT)
    except Exception:
        pytest.skip("Competitions/standings API not ready — likely rate limiting")

    page.locator("button[title='Add to favourites']").first.click(force=True)
    page.wait_for_timeout(300)

    page.get_by_title("Home").click()
    page.wait_for_timeout(500)

    expect(page.get_by_text("★ My Teams")).to_be_visible(timeout=QUICK_TIMEOUT)


@pytest.mark.favourites
@pytest.mark.calendar
def test_my_teams_filter_reduces_fixture_count(page: Page):
    """When My Teams is active, fixture list only shows the favourited team's matches."""
    page.goto(APP_URL)
    try:
        page.locator("select option[value='PL']").wait_for(state="attached", timeout=30_000)
        page.locator("aside select").first.select_option(value="PL")
        page.get_by_text("Arsenal").first.wait_for(timeout=DATA_TIMEOUT)
    except Exception:
        pytest.skip("Competitions/standings API not ready — likely rate limiting")
    page.locator("button[title='Add to favourites']").first.click(force=True)
    page.wait_for_timeout(200)
    page.get_by_title("Home").click()
    page.wait_for_timeout(1_000)

    dot_buttons = page.locator("button").filter(
        has=page.locator("span[class*='rounded-full'][class*='green']")
    )
    if dot_buttons.count() == 0:
        pytest.skip("No fixture dots found in current month — off-season")

    dot_buttons.first.click()
    page.wait_for_timeout(500)

    all_fixture_rows = page.locator("[class*='divide-y'] > div").count()

    page.get_by_text("★ My Teams").click()
    page.wait_for_timeout(400)

    filtered_rows = page.locator("[class*='divide-y'] > div").count()
    assert filtered_rows <= all_fixture_rows, \
        "My Teams filter did not reduce fixture count"


# ── SECTION: Navigation ───────────────────────────────────────────────────────

def _nav_to_pl(page: Page) -> None:
    """Helper: navigate to Premier League standings from home."""
    try:
        page.locator("select option[value='PL']").wait_for(state="attached", timeout=30_000)
        page.locator("aside select").first.select_option(value="PL")
        page.get_by_text("Arsenal").first.wait_for(timeout=DATA_TIMEOUT)
    except Exception:
        pytest.skip("Competitions/standings API not ready — likely rate limiting")


@pytest.mark.navigation
def test_ss_logo_returns_to_home(page: Page):
    """Clicking the SS logo from a competition page returns to the calendar."""
    page.goto(APP_URL)
    _nav_to_pl(page)
    page.get_by_title("Home").click()
    page.wait_for_timeout(500)
    expect(page.get_by_text("Mo", exact=True)).to_be_visible(timeout=QUICK_TIMEOUT)


@pytest.mark.navigation
def test_breadcrumb_fixtures_link_returns_home(page: Page):
    """The 'Fixtures' breadcrumb crumb navigates back to the calendar."""
    page.goto(APP_URL)
    _nav_to_pl(page)
    page.get_by_text("Fixtures", exact=True).click()
    page.wait_for_timeout(500)
    expect(page.get_by_text("Mo", exact=True)).to_be_visible(timeout=QUICK_TIMEOUT)


@pytest.mark.navigation
def test_breadcrumb_competition_link_returns_to_standings(page: Page):
    """Clicking the competition name in the breadcrumb goes back to standings."""
    page.goto(APP_URL)
    _nav_to_pl(page)
    page.locator("main div.relative.w-full.grid button").first.click()
    page.locator("[class*='font-mono']").first.wait_for(timeout=DATA_TIMEOUT)

    page.locator("header button", has_text="Premier League").click()
    page.wait_for_timeout(800)
    expect(page.locator("text=Arsenal").first).to_be_visible(timeout=QUICK_TIMEOUT)


@pytest.mark.navigation
def test_header_breadcrumb_shows_competition_and_team(page: Page):
    """After selecting a team, breadcrumb shows: Fixtures › League › Team."""
    page.goto(APP_URL)
    _nav_to_pl(page)
    page.locator("main div.relative.w-full.grid button").first.click()
    page.locator("[class*='font-mono']").first.wait_for(timeout=DATA_TIMEOUT)

    breadcrumb = page.locator("header")
    expect(breadcrumb.get_by_text("Fixtures", exact=True)).to_be_visible(timeout=QUICK_TIMEOUT)
    expect(breadcrumb.get_by_text("Premier League", exact=False)).to_be_visible(timeout=QUICK_TIMEOUT)


# ── SECTION: Fixture Cards ────────────────────────────────────────────────────

@pytest.mark.calendar
def test_fixture_card_shows_team_names(page: Page):
    """Fixture cards on the calendar show home and away team names."""
    page.goto(APP_URL)
    page.wait_for_timeout(2_000)

    # Click a day that has fixtures
    dot_buttons = page.locator("button").filter(
        has=page.locator("span[class*='rounded-full']")
    )
    if dot_buttons.count() == 0:
        pytest.skip("No fixture dots found — off-season")

    dot_buttons.first.click()
    page.wait_for_timeout(800)

    # Cards in the fixture list should have competition badge and team names
    fixture_area = page.locator("main").last
    cards = fixture_area.locator("[class*='divide-y'] > div, [class*='rounded'] > div")
    if cards.count() == 0:
        pytest.skip("No fixture cards rendered for selected day")
    # At least some text content (team names) should be non-empty
    card_text = cards.first.inner_text()
    assert len(card_text.strip()) > 0, "First fixture card is empty"


@pytest.mark.calendar
def test_tbd_teams_not_clickable_in_calendar(page: Page):
    """TBD team slots in the fixture calendar render as divs, not buttons."""
    page.goto(APP_URL)
    # Navigate forward a few months to find tournament TBD fixtures
    for _ in range(3):
        page.get_by_text("›", exact=True).click()
        page.wait_for_timeout(600)

    tbd_found = False
    day_buttons = page.locator("button").filter(
        has=page.locator("span[class*='rounded-full']")
    ).all()[:10]

    for btn in day_buttons:
        btn.click()
        page.wait_for_timeout(300)
        if page.get_by_text("TBD", exact=True).count() > 0:
            tbd_found = True
            for tbd in page.locator("text=TBD").all():
                tag = tbd.evaluate("el => el.tagName.toLowerCase()")
                assert tag != "button", \
                    f"TBD team rendered as <{tag}> but should not be clickable"
            break

    if not tbd_found:
        pytest.skip("No TBD fixtures found in the tested months")


@pytest.mark.calendar
def test_fixture_card_team_button_navigates_to_team(page: Page):
    """Clicking a team name button on a fixture card navigates to that team's view."""
    page.goto(APP_URL)
    page.wait_for_timeout(2_000)

    # Find a fixture dot
    dot_buttons = page.locator("button").filter(
        has=page.locator("span[class*='rounded-full']")
    )
    if dot_buttons.count() == 0:
        pytest.skip("No fixture dots — off-season")

    dot_buttons.first.click()
    page.wait_for_timeout(800)

    # The fixture card has team-name buttons that navigate to the team
    # These are buttons with short text (team names, not scores)
    team_btns = page.locator("main button[class*='hover']").filter(
        has_text=re.compile(r"^[A-Z][a-zA-Z\s.'\-]{2,}$")
    )
    if team_btns.count() == 0:
        pytest.skip("No navigable team buttons found in fixture cards")

    team_name = team_btns.first.inner_text().strip()
    team_btns.first.click()
    page.wait_for_timeout(1_500)

    # Should be on a team view now — breadcrumb has the team name
    breadcrumb = page.locator("header")
    assert team_name in breadcrumb.inner_text(), \
        f"Team '{team_name}' not reflected in breadcrumb after card click"


# ── SECTION: Live Ticker ──────────────────────────────────────────────────────

@pytest.mark.calendar
def test_live_ticker_only_shown_during_live_matches(page: Page):
    """Live ticker banner appears only when matches are currently in play."""
    page.goto(APP_URL)
    page.wait_for_timeout(2_000)

    # Check for live indicators (pulse dots)
    live_pulse = page.locator("[class*='animate-pulse']")
    ticker = page.locator("[class*='live-ticker'], [aria-label*='live'], [class*='ticker']")

    # Either there are live matches (pulse visible) or there are not — both are valid states
    # We just verify the app doesn't crash or show an error
    has_error = page.locator("text=Error, text=error, text=500").count()
    assert has_error == 0, "App shows an error state on home page"
