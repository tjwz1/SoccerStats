"""
Tests for competition standings — zone indicators, navigation, and season selector.
"""
import pytest
from playwright.sync_api import Page, expect

from conftest import APP_URL, DATA_TIMEOUT, NAV_TIMEOUT, QUICK_TIMEOUT  # noqa: F401


def test_pl_standings_load(page_with_pl_standings: Page):
    """Premier League standings table loads with at least 15 rows."""
    # Each data row has class 'relative w-full grid' (the absolute-position zone indicator rows)
    rows = page_with_pl_standings.locator("div.relative.w-full.grid").all()
    assert len(rows) >= 15, f"Expected ≥15 standings rows, got {len(rows)}"


def test_pl_standings_columns_visible(page_with_pl_standings: Page):
    """Column headers P, W, D, L, GD, Pts are all visible."""
    for col in ["P", "W", "D", "L", "GD", "Pts"]:
        expect(page_with_pl_standings.get_by_text(col, exact=True).first).to_be_visible()


def test_pl_zone_indicators_present(page_with_pl_standings: Page):
    """Zone indicator spans (absolute positioned, w-1) are present for UCL rows."""
    # UCL rows have a bg-blue-500 span as first child of each data row
    rows = page_with_pl_standings.locator("div.relative.w-full.grid").all()
    assert len(rows) >= 4, f"Need ≥4 rows to check, got {len(rows)}"
    ucl_count = 0
    for row in rows[:4]:
        indicator = row.locator("span.absolute")
        if indicator.count() > 0:
            cls = indicator.first.get_attribute("class") or ""
            if "bg-blue-500" in cls:
                ucl_count += 1
    assert ucl_count >= 4, \
        f"Expected ≥4 UCL (bg-blue-500) zone spans in top 4 rows, found {ucl_count}"


def test_pl_last_place_has_relegation_indicator(page_with_pl_standings: Page):
    """The 20th row (last place) must have a red relegation indicator span."""
    # Get all standing rows (exclude header)
    rows = page_with_pl_standings.locator("div.relative.w-full.grid").all()
    assert len(rows) >= 20, f"Expected ≥20 rows, got {len(rows)}"

    last_row = rows[19]  # 0-indexed, position 20
    # The row should contain a span with bg-red-500 (relegation)
    rel_span = last_row.locator("span.absolute.bg-red-500")
    assert rel_span.count() > 0, \
        "Last place row does not have a relegation (bg-red-500) zone indicator"


def test_pl_18th_19th_20th_have_relegation(page_with_pl_standings: Page):
    """Positions 18, 19, and 20 (indices 17-19) must all have bg-red-500 indicators."""
    rows = page_with_pl_standings.locator("div.relative.w-full.grid").all()
    assert len(rows) >= 20

    for idx in [17, 18, 19]:
        row = rows[idx]
        rel_span = row.locator("span.absolute.bg-red-500")
        assert rel_span.count() > 0, \
            f"Row at index {idx} (position {idx+1}) missing relegation indicator"


def test_pl_positions_1_to_4_have_ucl_indicator(page_with_pl_standings: Page):
    """Positions 1-4 must have bg-blue-500 (UCL) zone indicators."""
    rows = page_with_pl_standings.locator("div.relative.w-full.grid").all()
    assert len(rows) >= 4

    for idx in range(4):
        row = rows[idx]
        ucl_span = row.locator("span.absolute.bg-blue-500")
        assert ucl_span.count() > 0, \
            f"Row at index {idx} (position {idx+1}) missing UCL (bg-blue-500) indicator"


def test_pl_position_5_has_uel_indicator(page_with_pl_standings: Page):
    """Position 5 must have bg-orange-500 (UEL) zone indicator."""
    rows = page_with_pl_standings.locator("div.relative.w-full.grid").all()
    assert len(rows) >= 5

    row = rows[4]  # position 5, index 4
    uel_span = row.locator("span.absolute.bg-orange-500")
    assert uel_span.count() > 0, \
        "Position 5 missing Europa League (bg-orange-500) indicator"


def test_pl_position_7_has_no_indicator(page_with_pl_standings: Page):
    """Position 7 (mid-table) should have no zone indicator span."""
    rows = page_with_pl_standings.locator("div.relative.w-full.grid").all()
    assert len(rows) >= 7

    row = rows[6]  # position 7, index 6
    all_indicators = row.locator("span.absolute.left-0")
    assert all_indicators.count() == 0, \
        f"Position 7 should have no zone indicator, found {all_indicators.count()}"


def test_zone_legend_visible(page_with_pl_standings: Page):
    """Zone legend below the table shows UCL, UEL, ECL, and Relegation labels."""
    # Scope to main to avoid matching hidden <option> elements in the sidebar select dropdown
    main = page_with_pl_standings.locator("main")
    for label in ["Champions League", "Europa League", "Conference League", "Relegation"]:
        expect(main.get_by_text(label, exact=False).first).to_be_visible()


def test_team_crest_visible_in_standings(page_with_pl_standings: Page):
    """At least some team crests (img tags) are rendered in the standings table."""
    crests = page_with_pl_standings.locator("div.relative.w-full.grid img")
    assert crests.count() > 0, "No team crest images found in standings rows"


def test_form_pips_visible(page_with_pl_standings: Page):
    """Form pip elements (W/D/L squares) are visible for at least one row."""
    # Form pips have class like bg-green-600/80 or bg-red-700/70
    pips = page_with_pl_standings.locator("span[class*='rounded-sm'][class*='text-']").all()
    assert len(pips) > 0, "No form pips found in standings table"


def test_season_selector_present(page_with_pl_standings: Page):
    """A season dropdown is visible in the PL standings header."""
    selector = page_with_pl_standings.locator("select")
    assert selector.count() > 0, "No season selector found on competition page"


def test_clicking_team_navigates_to_squad(page_with_pl_standings: Page):
    """Clicking Arsenal in standings opens the team squad/lineup view."""
    # Click Arsenal's row button in the MAIN standings table (not sidebar stat leaders)
    page_with_pl_standings.locator("main div.relative.w-full.grid button span").filter(
        has_text="Arsenal"
    ).first.click()
    # Wait for formation badge (proves squad view loaded)
    page_with_pl_standings.locator("[class*='font-mono']").first.wait_for(timeout=DATA_TIMEOUT)
    expect(page_with_pl_standings.locator("[class*='font-mono']").first).to_be_visible()


def test_bundesliga_has_relegation_playoff_zone(page: Page):
    """Bundesliga (BL1) has a yellow playoff zone indicator at position 16."""
    page.goto(APP_URL)
    try:
        page.locator("select option[value='BL1']").wait_for(state="attached", timeout=30_000)
    except Exception:
        pytest.skip("Competitions API not ready — likely rate limiting")
    page.locator("select").first.select_option(value="BL1")
    # Wait for standings
    page.wait_for_timeout(2000)
    rows = page.locator("div.relative.w-full.grid").all()
    if len(rows) < 16:
        pytest.skip("Bundesliga standings not loaded or fewer than 16 rows")

    # Position 16 (index 15) should have bg-yellow-500 (playoff)
    row16 = rows[15]
    playoff_span = row16.locator("span.absolute.bg-yellow-500")
    assert playoff_span.count() > 0, \
        "Bundesliga position 16 missing playoff (bg-yellow-500) indicator"
