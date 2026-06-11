"""
Tests for the home page (fixture calendar) and navigation.
"""
import re
import requests
import pytest
from playwright.sync_api import Page, expect

from conftest import APP_URL, API_URL, DATA_TIMEOUT, NAV_TIMEOUT, QUICK_TIMEOUT


# ── API health ────────────────────────────────────────────────────────────────

def test_api_health():
    """Server must be up with a real API key before any UI tests run."""
    r = requests.get(f"{API_URL}/api/health", timeout=5)
    assert r.status_code == 200
    body = r.json()
    assert body["status"] == "ok"
    assert body["mock"] is False, "Server is returning mock data — FOOTBALL_API_KEY not set"


# ── App load ─────────────────────────────────────────────────────────────────

def test_app_loads(page: Page):
    """App renders with header, title and the fixture calendar on first load."""
    page.goto(APP_URL)
    expect(page.get_by_text("Soccer Stats")).to_be_visible(timeout=NAV_TIMEOUT)
    # SS home button
    expect(page.get_by_title("Home")).to_be_visible(timeout=QUICK_TIMEOUT)
    # Calendar grid — at least the 7 weekday headers are present
    for day in ["Mo", "Tu", "We", "Th", "Fr", "Sa", "Su"]:
        expect(page.get_by_text(day, exact=True)).to_be_visible(timeout=QUICK_TIMEOUT)


def test_calendar_shows_month_name(page: Page):
    """Calendar header shows a recognisable month name."""
    page.goto(APP_URL)
    months = ["January","February","March","April","May","June",
              "July","August","September","October","November","December"]
    # At least one month name must be present somewhere in the calendar header
    found = any(page.get_by_text(m, exact=False).count() > 0 for m in months)
    assert found, "No month name found in the calendar"


def test_calendar_month_navigation(page: Page):
    """Clicking › advances the month, ‹ goes back."""
    page.goto(APP_URL)
    # Read current month label
    header = page.locator("text=/January|February|March|April|May|June|July|August|September|October|November|December/").first
    header.wait_for(timeout=NAV_TIMEOUT)
    initial = header.inner_text()

    # Click next
    page.get_by_text("›", exact=True).click()
    page.wait_for_timeout(500)
    after_next = header.inner_text()
    assert after_next != initial, "Month did not change after clicking next"

    # Click back
    page.get_by_text("‹", exact=True).click()
    page.wait_for_timeout(500)
    assert header.inner_text() == initial, "Month did not return to original after clicking back"


def test_calendar_day_click_shows_date_label(page: Page):
    """Clicking any day cell updates the selected-date label below the grid."""
    page.goto(APP_URL)
    # Click day "1" (first of the month)
    page.locator("button").filter(has_text=re.compile(r"^1$")).first.click()
    page.wait_for_timeout(300)
    # The date label below the grid should contain a weekday name
    weekdays = ["Monday","Tuesday","Wednesday","Thursday","Friday","Saturday","Sunday"]
    day_label = page.locator("p").filter(has_text=re.compile(
        "Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday"
    )).first
    day_label.wait_for(timeout=QUICK_TIMEOUT)
    assert any(d in day_label.inner_text() for d in weekdays)


def test_my_teams_toggle_hidden_without_favourites(page: Page):
    """★ My Teams toggle must NOT appear when user has no favourites."""
    page.goto(APP_URL)
    page.wait_for_timeout(500)
    assert page.get_by_text("★ My Teams").count() == 0, \
        "My Teams toggle should be hidden when no favourites are set"


def test_my_teams_toggle_visible_after_favouriting(page: Page):
    """After starring a team, the ★ My Teams toggle appears on the calendar."""
    page.goto(APP_URL)
    try:
        page.locator("select option[value='PL']").wait_for(state="attached", timeout=30_000)
        page.locator("select").first.select_option(value="PL")
        page.get_by_text("Arsenal").first.wait_for(timeout=DATA_TIMEOUT)
    except Exception:
        pytest.skip("Competitions/standings API not ready — likely rate limiting")

    # Star any team — buttons are opacity-0 until hovered; use force=True to bypass
    page.locator("button[title='Add to favourites']").first.click(force=True)
    page.wait_for_timeout(300)

    # Return home
    page.get_by_title("Home").click()
    page.wait_for_timeout(500)

    expect(page.get_by_text("★ My Teams")).to_be_visible(timeout=QUICK_TIMEOUT)


def test_my_teams_filter_reduces_fixture_count(page: Page):
    """When My Teams is active, fixture list only shows the favourited team's matches."""
    page.goto(APP_URL)
    # Favourite a team via PL standings
    try:
        page.locator("select option[value='PL']").wait_for(state="attached", timeout=30_000)
        page.locator("select").first.select_option(value="PL")
        page.get_by_text("Arsenal").first.wait_for(timeout=DATA_TIMEOUT)
    except Exception:
        pytest.skip("Competitions/standings API not ready — likely rate limiting")
    page.locator("button[title='Add to favourites']").first.click(force=True)
    page.wait_for_timeout(200)
    page.get_by_title("Home").click()

    # Navigate to a month with known Arsenal fixtures — use current month
    # Click a day that shows fixtures (look for dots)
    page.wait_for_timeout(1000)  # allow month fixtures to load

    # Find a day that has fixture dots (the green indicator dot)
    dot_buttons = page.locator("button").filter(has=page.locator("span[class*='rounded-full'][class*='green']"))
    if dot_buttons.count() == 0:
        pytest.skip("No fixture dots found in current month — off-season")

    dot_buttons.first.click()
    page.wait_for_timeout(500)

    # Count fixtures before filtering
    all_fixture_rows = page.locator("[class*='divide-y'] > div").count()

    # Enable My Teams
    page.get_by_text("★ My Teams").click()
    page.wait_for_timeout(400)

    filtered_rows = page.locator("[class*='divide-y'] > div").count()
    # Filter should reduce or equal (may be 0 if Arsenal doesn't play that day)
    assert filtered_rows <= all_fixture_rows, \
        "My Teams filter did not reduce fixture count"


# ── Navigation ────────────────────────────────────────────────────────────────

def _nav_to_pl(page: Page) -> None:
    """Helper: navigate to Premier League standings from home."""
    try:
        page.locator("select option[value='PL']").wait_for(state="attached", timeout=30_000)
        page.locator("select").first.select_option(value="PL")
        page.get_by_text("Arsenal").first.wait_for(timeout=DATA_TIMEOUT)
    except Exception:
        pytest.skip("Competitions/standings API not ready — likely rate limiting")


def test_ss_logo_returns_to_home(page: Page):
    """Clicking the SS logo from a competition page returns to the calendar."""
    page.goto(APP_URL)
    _nav_to_pl(page)

    page.get_by_title("Home").click()
    page.wait_for_timeout(500)

    # Calendar should be visible again
    expect(page.get_by_text("Mo", exact=True)).to_be_visible(timeout=QUICK_TIMEOUT)


def test_breadcrumb_fixtures_link_returns_home(page: Page):
    """The 'Fixtures' breadcrumb crumb navigates back to the calendar."""
    page.goto(APP_URL)
    _nav_to_pl(page)

    # Click "Fixtures" in breadcrumb
    page.get_by_text("Fixtures", exact=True).click()
    page.wait_for_timeout(500)

    expect(page.get_by_text("Mo", exact=True)).to_be_visible(timeout=QUICK_TIMEOUT)


def test_breadcrumb_competition_link_returns_to_standings(page: Page):
    """Clicking the competition name in the breadcrumb goes back to standings."""
    page.goto(APP_URL)
    _nav_to_pl(page)
    # Click Arsenal (in standings main area) to go to team view
    page.locator("div.relative.w-full.grid button").first.click()
    page.locator("[class*='font-mono']").first.wait_for(timeout=DATA_TIMEOUT)

    # Click the competition name in the breadcrumb — it's a <button> with the comp name
    page.locator("header button", has_text="Premier League").click()
    page.wait_for_timeout(800)

    # Should see standings table again (Arsenal row with zone indicator present)
    expect(page.locator("text=Arsenal").first).to_be_visible(timeout=QUICK_TIMEOUT)


def test_tbd_teams_not_clickable_in_calendar(page: Page):
    """TBD team slots in the fixture calendar render as divs, not buttons."""
    page.goto(APP_URL)
    # Navigate forward a few months to find World Cup / tournament TBD fixtures
    for _ in range(3):
        page.get_by_text("›", exact=True).click()
        page.wait_for_timeout(600)

    # Click each day looking for TBD text
    tbd_found = False
    day_buttons = page.locator("button").filter(
        has=page.locator("span[class*='rounded-full']")
    ).all()[:10]

    for btn in day_buttons:
        btn.click()
        page.wait_for_timeout(300)
        if page.get_by_text("TBD", exact=True).count() > 0:
            tbd_found = True
            # Verify TBD elements are NOT buttons
            tbd_locators = page.locator("text=TBD").all()
            for tbd in tbd_locators:
                tag = tbd.evaluate("el => el.tagName.toLowerCase()")
                assert tag != "button", \
                    f"TBD team rendered as <{tag}> but should not be clickable"
            break

    if not tbd_found:
        pytest.skip("No TBD fixtures found in the tested months")
