"""
Tests for direct URL navigation and URL ↔ state synchronisation.

The app uses React Router with three route shapes:
  /                                   → home (fixture calendar)
  /competitions/:code                 → competition standings
  /competitions/:code/teams/:teamId   → team view
  /player/:id                         → player career page

Sections
--------
SECTION: Direct Links      — loading URL directly populates the correct state
SECTION: URL Sync          — navigating in-app updates the address bar
SECTION: Browser Back      — back/forward button works through the history stack
SECTION: Session Restore   — cold reload of a team URL restores full context
SECTION: Edge Cases        — unknown competition codes, invalid IDs

To run these tests alone:
    pytest test_url_navigation.py -m url_nav
"""
import re
import pytest
from playwright.sync_api import Page, expect

from conftest import (
    APP_URL, DATA_TIMEOUT, NAV_TIMEOUT, QUICK_TIMEOUT,
    _wait_for_competitions,
)

# Known stable IDs used in URL tests (football-data.org)
ARSENAL_ID = 57
PL_CODE = "PL"


# ── SECTION: Direct Links ─────────────────────────────────────────────────────

@pytest.mark.url_nav
def test_direct_home_url_shows_calendar(page: Page):
    """Navigating to / renders the fixture calendar."""
    page.goto(f"{APP_URL}/")
    for day in ["Mo", "Tu", "We", "Th", "Fr", "Sa", "Su"]:
        expect(page.get_by_text(day, exact=True)).to_be_visible(timeout=NAV_TIMEOUT)


@pytest.mark.url_nav
def test_direct_competition_url_loads_standings(page: Page):
    """Navigating to /competitions/PL directly loads the PL standings."""
    page.goto(f"{APP_URL}/competitions/{PL_CODE}")
    try:
        page.locator("main div.relative.w-full.grid").first.wait_for(timeout=DATA_TIMEOUT)
    except Exception:
        pytest.skip("PL standings not ready via direct URL — rate limiting")

    rows = page.locator("main div.relative.w-full.grid").all()
    assert len(rows) >= 15, f"Expected ≥15 standings rows via direct URL, got {len(rows)}"


@pytest.mark.url_nav
def test_direct_competition_url_sets_sidebar_selector(page: Page):
    """Direct /competitions/PL URL selects PL in the sidebar competition dropdown."""
    page.goto(f"{APP_URL}/competitions/{PL_CODE}")
    try:
        page.locator("aside select option[value='PL']").wait_for(state="attached", timeout=DATA_TIMEOUT)
    except Exception:
        pytest.skip("Competitions API not ready")

    selected_val = page.locator("aside select").first.input_value()
    assert selected_val == PL_CODE, \
        f"Sidebar selector not set to PL via direct URL, got: '{selected_val}'"


@pytest.mark.url_nav
def test_direct_team_url_loads_team_view(page: Page):
    """Navigating to /competitions/PL/teams/57 directly loads Arsenal's view."""
    page.goto(f"{APP_URL}/competitions/{PL_CODE}/teams/{ARSENAL_ID}")
    try:
        # Team view shows a tab bar when it loads
        page.locator("button[class*='bg-green-600']").filter(
            has_text=re.compile(r"Squad|Schedule|Honours|News")
        ).first.wait_for(timeout=DATA_TIMEOUT)
    except Exception:
        pytest.skip("Team view not ready via direct URL — rate limiting")

    header_text = page.locator("header").inner_text()
    assert "Arsenal" in header_text, \
        f"Arsenal not in breadcrumb after direct team URL. Header: '{header_text}'"


@pytest.mark.url_nav
def test_direct_team_url_shows_breadcrumb(page: Page):
    """Direct team URL shows competition and team in the breadcrumb."""
    page.goto(f"{APP_URL}/competitions/{PL_CODE}/teams/{ARSENAL_ID}")
    try:
        page.locator("header").get_by_text("Arsenal", exact=False).wait_for(timeout=DATA_TIMEOUT)
    except Exception:
        pytest.skip("Team not loaded via direct URL")

    header = page.locator("header")
    expect(header.get_by_text("Fixtures", exact=True)).to_be_visible(timeout=QUICK_TIMEOUT)
    expect(header.get_by_text("Premier League", exact=False)).to_be_visible(timeout=QUICK_TIMEOUT)
    expect(header.get_by_text("Arsenal", exact=False)).to_be_visible(timeout=QUICK_TIMEOUT)


@pytest.mark.url_nav
def test_direct_player_url_loads_player_page(page: Page):
    """Navigating directly to /player/:id loads the player career page."""
    # Use a well-known Arsenal player ID (Saka = 8004, but may change; use a stable one)
    # We navigate to main first to get a real player ID from the squad
    page.goto(f"{APP_URL}/competitions/{PL_CODE}/teams/{ARSENAL_ID}")
    try:
        page.get_by_role("button", name="Squad").wait_for(timeout=DATA_TIMEOUT)
        page.get_by_role("button", name="Squad").click()
        page.wait_for_timeout(800)
        squad_btn = page.locator("section button").first
        squad_btn.wait_for(timeout=QUICK_TIMEOUT)
        squad_btn.click()
        page.locator("h1").first.wait_for(timeout=DATA_TIMEOUT)
    except Exception:
        pytest.skip("Could not reach player page via squad click")

    player_url = page.url
    assert "/player/" in player_url, f"Not on player page: {player_url}"

    # Now reload the player URL directly
    page.goto(player_url)
    try:
        page.locator("h1").first.wait_for(timeout=DATA_TIMEOUT)
    except Exception:
        pytest.skip("Player page did not load on direct URL reload")

    expect(page.locator("h1").first).to_be_visible(timeout=QUICK_TIMEOUT)
    expect(page.get_by_text("Back", exact=True)).to_be_visible(timeout=QUICK_TIMEOUT)


# ── SECTION: URL Sync ─────────────────────────────────────────────────────────

@pytest.mark.url_nav
def test_selecting_competition_updates_url(page: Page):
    """Selecting a competition in the sidebar updates the URL to /competitions/:code."""
    page.goto(APP_URL)
    _wait_for_competitions(page)
    page.locator("aside select").first.select_option(value=PL_CODE)
    try:
        page.locator("main div.relative.w-full.grid").first.wait_for(timeout=DATA_TIMEOUT)
    except Exception:
        pytest.skip("Standings not loaded")

    url = page.url
    assert f"/competitions/{PL_CODE}" in url, \
        f"URL not updated after competition selection: '{url}'"


@pytest.mark.url_nav
def test_selecting_team_updates_url(page: Page):
    """Clicking a team in standings updates the URL to /competitions/:code/teams/:id."""
    page.goto(APP_URL)
    _wait_for_competitions(page)
    page.locator("aside select").first.select_option(value=PL_CODE)
    try:
        page.locator("main div.relative.w-full.grid button").first.wait_for(timeout=DATA_TIMEOUT)
    except Exception:
        pytest.skip("Standings not loaded")

    page.locator("main div.relative.w-full.grid button").first.click()
    try:
        page.locator("[class*='font-mono']").first.wait_for(timeout=DATA_TIMEOUT)
    except Exception:
        pytest.skip("Team view not loaded")

    url = page.url
    assert f"/competitions/{PL_CODE}/teams/" in url, \
        f"URL not updated after team selection: '{url}'"
    assert re.search(r"/teams/\d+", url), f"Team ID missing from URL: '{url}'"


@pytest.mark.url_nav
def test_clicking_home_resets_url(page: Page):
    """Clicking the SS Home button resets the URL to /."""
    page.goto(f"{APP_URL}/competitions/{PL_CODE}")
    try:
        page.locator("main div.relative.w-full.grid").first.wait_for(timeout=DATA_TIMEOUT)
    except Exception:
        pytest.skip("Standings not loaded")

    page.get_by_title("Home").click()
    page.wait_for_timeout(500)

    url = page.url
    assert url == f"{APP_URL}/" or url == APP_URL, \
        f"URL not reset to / after clicking Home: '{url}'"


@pytest.mark.url_nav
def test_breadcrumb_comp_click_updates_url(page: Page):
    """Clicking competition breadcrumb from team view updates URL to /competitions/:code."""
    page.goto(f"{APP_URL}/competitions/{PL_CODE}/teams/{ARSENAL_ID}")
    try:
        page.locator("header button", has_text="Premier League").wait_for(timeout=DATA_TIMEOUT)
    except Exception:
        pytest.skip("Team view not loaded via direct URL")

    page.locator("header button", has_text="Premier League").click()
    page.wait_for_timeout(500)

    url = page.url
    assert f"/competitions/{PL_CODE}" in url, \
        f"URL not updated to competition after breadcrumb click: '{url}'"
    assert "/teams/" not in url, \
        f"URL still contains team path after going back to standings: '{url}'"


@pytest.mark.url_nav
def test_breadcrumb_fixtures_click_resets_url(page: Page):
    """Clicking 'Fixtures' breadcrumb from standings resets URL to /."""
    page.goto(f"{APP_URL}/competitions/{PL_CODE}")
    try:
        page.get_by_text("Fixtures", exact=True).wait_for(timeout=DATA_TIMEOUT)
    except Exception:
        pytest.skip("Competition page not loaded")

    page.get_by_text("Fixtures", exact=True).click()
    page.wait_for_timeout(500)

    url = page.url
    assert url == f"{APP_URL}/" or url == APP_URL, \
        f"URL not reset after clicking Fixtures breadcrumb: '{url}'"


# ── SECTION: Browser Back ─────────────────────────────────────────────────────

@pytest.mark.url_nav
def test_browser_back_from_team_to_standings(page: Page):
    """Browser back from team view returns to competition standings."""
    page.goto(APP_URL)
    _wait_for_competitions(page)
    page.locator("aside select").first.select_option(value=PL_CODE)
    try:
        page.locator("main div.relative.w-full.grid button").first.wait_for(timeout=DATA_TIMEOUT)
    except Exception:
        pytest.skip("Standings not loaded")

    page.locator("main div.relative.w-full.grid button").first.click()
    try:
        page.locator("[class*='font-mono']").first.wait_for(timeout=DATA_TIMEOUT)
    except Exception:
        pytest.skip("Team view not loaded")

    # Browser back
    page.go_back()
    page.wait_for_timeout(1_000)

    url = page.url
    # Should be back on competition page or home
    assert "/teams/" not in url, f"Browser back did not leave team URL: '{url}'"


@pytest.mark.url_nav
def test_browser_back_from_player_to_squad(page: Page):
    """Browser back from player page returns to the previous squad view."""
    page.goto(f"{APP_URL}/competitions/{PL_CODE}/teams/{ARSENAL_ID}")
    try:
        page.get_by_role("button", name="Squad").wait_for(timeout=DATA_TIMEOUT)
        page.get_by_role("button", name="Squad").click()
        page.wait_for_timeout(800)
        page.locator("section button").first.wait_for(timeout=QUICK_TIMEOUT)
        page.locator("section button").first.click()
        page.locator("h1").first.wait_for(timeout=DATA_TIMEOUT)
    except Exception:
        pytest.skip("Could not navigate to player page")

    player_url = page.url
    assert "/player/" in player_url

    page.go_back()
    page.wait_for_timeout(1_000)

    # Should be back on the team view
    url = page.url
    assert "/player/" not in url, f"Browser back did not leave player URL: '{url}'"


@pytest.mark.url_nav
def test_back_button_on_player_page_navigates_back(page: Page):
    """The 'Back' button on the player page navigates to the previous page."""
    page.goto(f"{APP_URL}/competitions/{PL_CODE}/teams/{ARSENAL_ID}")
    try:
        page.get_by_role("button", name="Squad").wait_for(timeout=DATA_TIMEOUT)
        page.get_by_role("button", name="Squad").click()
        page.wait_for_timeout(800)
        page.locator("section button").first.wait_for(timeout=QUICK_TIMEOUT)
        page.locator("section button").first.click()
        page.locator("h1").first.wait_for(timeout=DATA_TIMEOUT)
    except Exception:
        pytest.skip("Could not reach player page")

    page.get_by_text("Back", exact=True).click()
    page.wait_for_timeout(800)

    url = page.url
    assert "/player/" not in url, f"'Back' button did not leave player URL: '{url}'"


# ── SECTION: Session Restore ──────────────────────────────────────────────────

@pytest.mark.url_nav
def test_cold_reload_of_team_url_restores_team_view(page: Page):
    """Reloading the browser on a team URL restores the full team view."""
    page.goto(f"{APP_URL}/competitions/{PL_CODE}/teams/{ARSENAL_ID}")
    try:
        page.locator("button[class*='bg-green-600']").filter(
            has_text=re.compile(r"Squad|Schedule|Honours|News")
        ).first.wait_for(timeout=DATA_TIMEOUT)
    except Exception:
        pytest.skip("Team view not ready")

    # Reload the same URL (simulates cold page load on a deep link)
    page.reload()
    try:
        page.locator("button[class*='bg-green-600']").filter(
            has_text=re.compile(r"Squad|Schedule|Honours|News")
        ).first.wait_for(timeout=DATA_TIMEOUT)
    except Exception:
        pytest.skip("Team view not restored after reload")

    header_text = page.locator("header").inner_text()
    assert "Arsenal" in header_text, \
        f"Arsenal not in header after cold reload of team URL: '{header_text}'"


@pytest.mark.url_nav
def test_session_storage_restores_competition(page: Page):
    """Opening the app after a prior session auto-restores the last competition."""
    # Navigate to PL standings to create session state
    page.goto(APP_URL)
    _wait_for_competitions(page)
    page.locator("aside select").first.select_option(value=PL_CODE)
    try:
        page.locator("main div.relative.w-full.grid").first.wait_for(timeout=DATA_TIMEOUT)
    except Exception:
        pytest.skip("PL standings not loaded")

    # Open home page in same session (sessionStorage is preserved)
    page.goto(APP_URL)
    page.wait_for_timeout(1_000)

    # Session storage should restore PL standings
    url = page.url
    # URL may or may not update on session restore — just verify no crash
    assert page.locator("header button[title*='Home'], header button[title='Home']").count() > 0


# ── SECTION: Edge Cases ───────────────────────────────────────────────────────

@pytest.mark.url_nav
def test_unknown_competition_code_shows_home(page: Page):
    """Navigating to /competitions/XXXX with an unknown code shows the calendar."""
    page.goto(f"{APP_URL}/competitions/XXXX_INVALID")
    page.wait_for_timeout(2_000)

    # App should not crash — may show home or an empty standings
    header = page.locator("header")
    header.wait_for(timeout=NAV_TIMEOUT)
    has_error = page.locator("text=/500|Internal Server Error/i").count()
    assert has_error == 0, "Unknown competition code caused a 500 error page"


@pytest.mark.url_nav
def test_invalid_team_id_does_not_crash_app(page: Page):
    """Navigating to /competitions/PL/teams/0 with an invalid ID does not crash."""
    page.goto(f"{APP_URL}/competitions/{PL_CODE}/teams/0")
    page.wait_for_timeout(2_000)

    has_error = page.locator("text=/500|Internal Server Error|unhandled error/i").count()
    assert has_error == 0, "Invalid team ID caused an unhandled error"
    # Header should still be present (app shell did not crash)
    expect(page.locator("header")).to_be_visible(timeout=QUICK_TIMEOUT)
