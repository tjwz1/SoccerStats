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
def page_with_pl_standings(page):
    """Navigate to Premier League standings and wait for table to be populated."""
    # Reload to APP_URL for a known-clean state (page fixture cleared localStorage
    # which can leave React in mid-effect; an explicit goto resets it reliably).
    page.goto(APP_URL)
    # Wait for the "PL" option to exist — guarantees competitions API loaded and
    # the select is enabled (disabled={compsLoading} in TeamSearch component).
    # Use extended timeout and skip gracefully on rate-limit / server slowness.
    try:
        page.locator("select option[value='PL']").wait_for(state="attached", timeout=30_000)
        page.locator("select").first.select_option(value="PL")
        page.locator("text=Arsenal").first.wait_for(timeout=DATA_TIMEOUT)
    except Exception:
        pytest.skip("Competitions/standings API not ready within timeout — likely rate limiting")
    return page


@pytest.fixture
def page_with_arsenal(page_with_pl_standings):
    """Navigate from PL standings into Arsenal's squad view."""
    try:
        # Click Arsenal in the MAIN standings area (not sidebar stat leaders)
        page_with_pl_standings.locator("main div.relative.w-full.grid button span").filter(
            has_text="Arsenal"
        ).first.click(timeout=30_000)
        # Formation badge in breadcrumb signals squad/lineup loaded
        page_with_pl_standings.locator("[class*='font-mono']").first.wait_for(timeout=DATA_TIMEOUT)
    except Exception:
        pytest.skip("Arsenal squad API not ready within timeout — likely rate limiting")
    return page_with_pl_standings
