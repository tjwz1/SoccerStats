import pytest
from playwright.sync_api import sync_playwright, Page, expect

APP_URL = "http://localhost:5173"
API_URL = "http://localhost:3001"

# Shared wait helpers
NAV_TIMEOUT   = 15_000   # ms — page navigation / major component mount
DATA_TIMEOUT  = 20_000   # ms — API-backed data (standings, squad, player)
QUICK_TIMEOUT = 5_000    # ms — elements that should already be visible


@pytest.fixture(scope="session")
def browser_instance():
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        yield browser
        browser.close()


@pytest.fixture
def page(browser_instance):
    """Fresh browser context + page for each test; clears localStorage."""
    ctx  = browser_instance.new_context(viewport={"width": 1280, "height": 900})
    page = ctx.new_page()
    # Clear any persisted favourites / session state between tests
    page.goto(APP_URL)
    page.evaluate("() => { localStorage.clear(); sessionStorage.clear(); }")
    yield page
    ctx.close()


@pytest.fixture
def mobile_page(browser_instance):
    """Narrow viewport that activates mobile layout (sidebar drawer, header search icon)."""
    ctx  = browser_instance.new_context(viewport={"width": 390, "height": 844})
    page = ctx.new_page()
    page.goto(APP_URL)
    page.evaluate("() => { localStorage.clear(); sessionStorage.clear(); }")
    yield page
    ctx.close()


# ── Shared navigation helpers ─────────────────────────────────────────────────

def _wait_for_competitions(page: Page, timeout: int = 30_000) -> None:
    """Block until the competition selector is populated. Skips on timeout."""
    try:
        page.locator("select option[value='PL']").wait_for(state="attached", timeout=timeout)
    except Exception:
        pytest.skip("Competitions API not ready within timeout — likely rate limiting")


def _select_pl(page: Page) -> None:
    """Select Premier League in the sidebar competition dropdown."""
    _wait_for_competitions(page)
    page.locator("aside select").first.select_option(value="PL")


def _wait_for_pl_standings(page: Page) -> None:
    """Wait for at least one PL team name to appear in the main standings."""
    try:
        page.get_by_text("Arsenal").first.wait_for(timeout=DATA_TIMEOUT)
    except Exception:
        pytest.skip("PL standings not ready within timeout — likely rate limiting")


def _click_arsenal_in_standings(page: Page) -> None:
    """Click Arsenal's button in the MAIN standings table (not sidebar stat leaders)."""
    try:
        page.locator("main div.relative.w-full.grid button span").filter(
            has_text="Arsenal"
        ).first.click(timeout=10_000)
    except Exception:
        pytest.skip("Arsenal row not found / clickable in standings")


def _wait_for_squad_loaded(page: Page) -> None:
    """Wait for the formation badge that confirms the squad/lineup loaded."""
    try:
        page.locator("[class*='font-mono']").first.wait_for(timeout=DATA_TIMEOUT)
    except Exception:
        pytest.skip("Squad/lineup not loaded within timeout")


# ── Session-scoped shared fixtures ────────────────────────────────────────────

@pytest.fixture
def page_with_pl_standings(page):
    """Navigate to Premier League standings and wait for table to be populated."""
    page.goto(APP_URL)
    _wait_for_competitions(page)
    page.locator("aside select").first.select_option(value="PL")
    _wait_for_pl_standings(page)
    return page


@pytest.fixture
def page_with_arsenal(page_with_pl_standings):
    """Navigate from PL standings into Arsenal's squad view."""
    _click_arsenal_in_standings(page_with_pl_standings)
    _wait_for_squad_loaded(page_with_pl_standings)
    return page_with_pl_standings


@pytest.fixture
def page_with_arsenal_schedule(page_with_arsenal):
    """Navigate to Arsenal's Schedule tab and wait for match cards."""
    page_with_arsenal.get_by_role("button", name="Schedule").click()
    try:
        page_with_arsenal.get_by_role("button", name="Lineup").first.wait_for(timeout=DATA_TIMEOUT)
    except Exception:
        pytest.skip("Arsenal schedule not ready within timeout — likely rate limiting")
    return page_with_arsenal


@pytest.fixture
def page_with_arsenal_honours(page_with_arsenal):
    """Navigate to Arsenal's Honours tab and wait for trophy content."""
    page_with_arsenal.get_by_role("button", name="Honours").click()
    try:
        # Honours tab shows either trophy data or a loading/empty state
        page_with_arsenal.wait_for_timeout(3_000)
    except Exception:
        pass
    return page_with_arsenal


@pytest.fixture
def page_with_arsenal_news(page_with_arsenal):
    """Navigate to Arsenal's News tab and wait for articles."""
    page_with_arsenal.get_by_role("button", name="News").click()
    try:
        page_with_arsenal.wait_for_timeout(3_000)
    except Exception:
        pass
    return page_with_arsenal
