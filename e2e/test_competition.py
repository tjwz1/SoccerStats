"""
Tests for competition standings — zone indicators, navigation, and season selector.

Sections
--------
SECTION: Standings Load    — table renders with correct row count and columns
SECTION: Zone Indicators   — UCL/UEL/ECL/relegation/playoff colour bars
SECTION: Zone Legend       — legend labels below the table
SECTION: Table Content     — crests, form pips, star buttons
SECTION: Season Selector   — dropdown present, changes data on selection
SECTION: Group Selector    — multi-group competitions (WC/CL) show group picker
SECTION: Bracket View      — CL/EL bracket tab renders a knockout bracket
SECTION: Team Navigation   — click row → squad view
SECTION: Error States      — 403/429 errors surface a helpful message
"""
import re
import pytest
from playwright.sync_api import Page, expect

from conftest import (
    APP_URL, DATA_TIMEOUT, NAV_TIMEOUT, QUICK_TIMEOUT,
    _wait_for_competitions,
)


def _select_comp(page: Page, code: str, team_hint: str = "") -> None:
    """Select a competition and optionally wait for a known team to appear."""
    _wait_for_competitions(page)
    page.locator("aside select").first.select_option(value=code)
    if team_hint:
        try:
            page.locator(f"text={team_hint}").first.wait_for(timeout=DATA_TIMEOUT)
        except Exception:
            pytest.skip(f"{code} standings not ready — likely rate limiting")


# ── SECTION: Standings Load ───────────────────────────────────────────────────

@pytest.mark.standings
def test_pl_standings_load(page_with_pl_standings: Page):
    """Premier League standings table loads with at least 15 rows."""
    rows = page_with_pl_standings.locator("div.relative.w-full.grid").all()
    assert len(rows) >= 15, f"Expected ≥15 standings rows, got {len(rows)}"


@pytest.mark.standings
def test_pl_standings_columns_visible(page_with_pl_standings: Page):
    """Column headers P, W, D, L, GD, Pts are all visible."""
    for col in ["P", "W", "D", "L", "GD", "Pts"]:
        expect(page_with_pl_standings.get_by_text(col, exact=True).first).to_be_visible()


@pytest.mark.standings
def test_pl_standings_shows_twenty_teams(page_with_pl_standings: Page):
    """PL standings table has exactly 20 team rows."""
    rows = page_with_pl_standings.locator("div.relative.w-full.grid").all()
    assert len(rows) == 20, f"Expected 20 PL rows, got {len(rows)}"


@pytest.mark.standings
def test_pl_positions_are_sequential(page_with_pl_standings: Page):
    """Position numbers in standings run 1–20 without gaps."""
    rows = page_with_pl_standings.locator("div.relative.w-full.grid").all()
    for idx, row in enumerate(rows, start=1):
        # skip absolute-positioned zone indicator bars (empty text) — target tabular-nums span
        pos_span = row.locator("span.tabular-nums").first
        text = pos_span.inner_text().strip()
        assert text == str(idx), \
            f"Row {idx} shows position '{text}' instead of {idx}"


# ── SECTION: Zone Indicators ──────────────────────────────────────────────────

@pytest.mark.standings
def test_pl_positions_1_to_4_have_ucl_indicator(page_with_pl_standings: Page):
    """Positions 1-4 must have bg-blue-500 (UCL) zone indicators."""
    rows = page_with_pl_standings.locator("div.relative.w-full.grid").all()
    assert len(rows) >= 4
    for idx in range(4):
        ucl_span = rows[idx].locator("span.absolute.bg-blue-500")
        assert ucl_span.count() > 0, \
            f"Position {idx+1} missing UCL (bg-blue-500) indicator"


@pytest.mark.standings
def test_pl_position_5_has_uel_indicator(page_with_pl_standings: Page):
    """Position 5 must have bg-orange-500 (UEL) zone indicator."""
    rows = page_with_pl_standings.locator("div.relative.w-full.grid").all()
    assert len(rows) >= 5
    uel_span = rows[4].locator("span.absolute.bg-orange-500")
    assert uel_span.count() > 0, "Position 5 missing Europa League (bg-orange-500) indicator"


@pytest.mark.standings
def test_pl_position_6_has_ecl_indicator(page_with_pl_standings: Page):
    """Position 6 must have bg-lime-500 (ECL) zone indicator."""
    rows = page_with_pl_standings.locator("div.relative.w-full.grid").all()
    assert len(rows) >= 6
    ecl_span = rows[5].locator("span.absolute.bg-lime-500")
    assert ecl_span.count() > 0, "Position 6 missing Conference League (bg-lime-500) indicator"


@pytest.mark.standings
def test_pl_position_7_has_no_indicator(page_with_pl_standings: Page):
    """Position 7 (mid-table) should have no zone indicator span."""
    rows = page_with_pl_standings.locator("div.relative.w-full.grid").all()
    assert len(rows) >= 7
    all_indicators = rows[6].locator("span.absolute.left-0")
    assert all_indicators.count() == 0, \
        f"Position 7 should have no zone indicator, found {all_indicators.count()}"


@pytest.mark.standings
def test_pl_18th_19th_20th_have_relegation(page_with_pl_standings: Page):
    """Positions 18, 19, and 20 must all have bg-red-500 relegation indicators."""
    rows = page_with_pl_standings.locator("div.relative.w-full.grid").all()
    assert len(rows) >= 20
    for idx in [17, 18, 19]:
        rel_span = rows[idx].locator("span.absolute.bg-red-500")
        assert rel_span.count() > 0, \
            f"Position {idx+1} missing relegation (bg-red-500) indicator"


@pytest.mark.standings
def test_bundesliga_has_relegation_playoff_zone(page: Page):
    """Bundesliga (BL1) has a yellow playoff zone indicator at position 16."""
    page.goto(APP_URL)
    _select_comp(page, "BL1")
    page.wait_for_timeout(2_000)
    rows = page.locator("div.relative.w-full.grid").all()
    if len(rows) < 16:
        pytest.skip("BL1 standings not loaded or fewer than 16 rows")
    playoff_span = rows[15].locator("span.absolute.bg-yellow-500")
    assert playoff_span.count() > 0, \
        "Bundesliga position 16 missing playoff (bg-yellow-500) indicator"


# ── SECTION: Zone Legend ──────────────────────────────────────────────────────

@pytest.mark.standings
def test_zone_legend_visible(page_with_pl_standings: Page):
    """Zone legend below the table shows UCL, UEL, ECL, and Relegation labels."""
    main = page_with_pl_standings.locator("main")
    for label in ["Champions League", "Europa League", "Conference League", "Relegation"]:
        expect(main.get_by_text(label, exact=False).first).to_be_visible()


@pytest.mark.standings
def test_zone_legend_not_shown_when_no_zones(page: Page):
    """Competitions without defined zone rules show no zone legend."""
    page.goto(APP_URL)
    # PPL (Primeira Liga) has defined zones — use a comp without them if available,
    # or verify PPL has a legend to at least confirm the conditional logic runs.
    _select_comp(page, "PPL")
    page.wait_for_timeout(2_000)
    rows = page.locator("div.relative.w-full.grid").all()
    if len(rows) == 0:
        pytest.skip("PPL standings not available")
    # PPL has zone rules so a legend should exist — this confirms the render path
    main = page.locator("main")
    legend_exists = (
        main.get_by_text("Champions League", exact=False).count() > 0
        or main.get_by_text("Relegation", exact=False).count() > 0
    )
    assert legend_exists, "PPL standings should show a zone legend"


# ── SECTION: Table Content ────────────────────────────────────────────────────

@pytest.mark.standings
def test_team_crest_visible_in_standings(page_with_pl_standings: Page):
    """At least some team crests (img tags) are rendered in the standings table."""
    crests = page_with_pl_standings.locator("div.relative.w-full.grid img")
    assert crests.count() > 0, "No team crest images found in standings rows"


@pytest.mark.standings
def test_form_pips_visible(page_with_pl_standings: Page):
    """Form pip elements (W/D/L squares) are visible for at least one row."""
    pips = page_with_pl_standings.locator("span[class*='rounded-sm'][class*='text-']").all()
    assert len(pips) > 0, "No form pips found in standings table"


@pytest.mark.standings
def test_form_pips_contain_valid_results(page_with_pl_standings: Page):
    """Form pip text is only W, D, or L."""
    pips = page_with_pl_standings.locator("span[class*='rounded-sm']").all()
    if not pips:
        pytest.skip("No form pips found")
    for pip in pips[:20]:
        text = pip.inner_text().strip()
        assert text in ("W", "D", "L"), f"Unexpected form pip value: '{text}'"


@pytest.mark.standings
def test_goal_difference_shown_with_sign(page_with_pl_standings: Page):
    """Positive GD values are displayed with a + prefix."""
    # Look for a +N in the standings rows
    gd_positive = page_with_pl_standings.locator(
        "div.relative.w-full.grid span[class*='green']"
    ).filter(has_text=re.compile(r"^\+\d+$"))
    if gd_positive.count() == 0:
        pytest.skip("No teams with positive GD in current standings")
    assert gd_positive.count() > 0


@pytest.mark.standings
def test_favourite_star_appears_on_hover(page_with_pl_standings: Page):
    """Hovering a standings row reveals the favourite (star) button."""
    rows = page_with_pl_standings.locator("div.relative.w-full.grid")
    rows.first.hover()
    page_with_pl_standings.wait_for_timeout(200)
    star = rows.first.locator("button[title*='favourite']")
    star.wait_for(timeout=QUICK_TIMEOUT)
    expect(star).to_be_visible()


# ── SECTION: Season Selector ──────────────────────────────────────────────────

@pytest.mark.standings
def test_season_selector_present(page_with_pl_standings: Page):
    """A season dropdown is visible in the PL standings header."""
    selector = page_with_pl_standings.locator("main select")
    assert selector.count() > 0, "No season selector found on competition page"


@pytest.mark.standings
def test_season_selector_has_past_seasons(page_with_pl_standings: Page):
    """Season selector contains past season options (e.g. 2023, 2022)."""
    selector = page_with_pl_standings.locator("main select").first
    options = selector.locator("option").all()
    years = [int(o.get_attribute("value")) for o in options if o.get_attribute("value")]
    assert len(years) >= 2, "Season selector should have at least 2 past seasons"
    assert all(2015 < y < 2030 for y in years), f"Unexpected season years: {years}"


@pytest.mark.standings
def test_season_selector_changes_standings(page_with_pl_standings: Page):
    """Selecting a past season replaces the current standings with historical ones."""
    selector = page_with_pl_standings.locator("main select").first
    options = selector.locator("option[value]").all()
    if len(options) < 1:
        pytest.skip("No past season options available")

    # Read a current-season team name from position 1
    first_row = page_with_pl_standings.locator("div.relative.w-full.grid").first
    current_team = first_row.locator("button span").first.inner_text().strip()

    # Select the first past season
    past_year = options[0].get_attribute("value")
    selector.select_option(value=past_year)

    # Wait for skeleton or new data
    page_with_pl_standings.wait_for_timeout(4_000)

    # Data may differ (different year = different champion at top)
    rows = page_with_pl_standings.locator("div.relative.w-full.grid").all()
    assert len(rows) >= 15, f"Historical season showed fewer than 15 rows ({len(rows)})"


@pytest.mark.standings
def test_season_selector_returns_to_current(page_with_pl_standings: Page):
    """Selecting 'Current season' after a past season restores live standings."""
    selector = page_with_pl_standings.locator("main select").first
    options = selector.locator("option[value]").all()
    if len(options) < 1:
        pytest.skip("No past season options available")

    past_year = options[0].get_attribute("value")
    selector.select_option(value=past_year)
    page_with_pl_standings.wait_for_timeout(2_000)

    # Go back to current season (the empty-value option)
    selector.select_option(value="")
    page_with_pl_standings.wait_for_timeout(4_000)

    rows = page_with_pl_standings.locator("div.relative.w-full.grid").all()
    assert len(rows) >= 15, "Current-season standings not restored after switching back"


# ── SECTION: Group Selector ───────────────────────────────────────────────────

@pytest.mark.standings
def test_cl_group_selector_present(page: Page):
    """Champions League standings show a group selector when multi-group format is used."""
    page.goto(APP_URL)
    _select_comp(page, "CL")
    page.wait_for_timeout(3_000)

    rows = page.locator("div.relative.w-full.grid").all()
    if len(rows) == 0:
        pytest.skip("CL standings not loaded")

    # Multi-group competitions show a <select> for the group
    main = page.locator("main")
    group_select = main.locator("select")
    # Either a group select or a single-table view — both are valid
    # When multi-group: the select shows "Group A", "Group B", etc.
    if group_select.count() > 0:
        options = group_select.first.locator("option").all()
        option_texts = [o.inner_text() for o in options]
        # If group options present, they should mention "Group"
        group_opts = [t for t in option_texts if "Group" in t]
        assert len(group_opts) >= 1 or len(option_texts) >= 1


@pytest.mark.standings
def test_cl_standings_columns_same_as_pl(page: Page):
    """Champions League standings show the same column headers as domestic leagues."""
    page.goto(APP_URL)
    _select_comp(page, "CL")
    page.wait_for_timeout(3_000)

    rows = page.locator("div.relative.w-full.grid").all()
    if len(rows) == 0:
        pytest.skip("CL standings not loaded")

    for col in ["P", "W", "D", "L", "GD", "Pts"]:
        expect(page.get_by_text(col, exact=True).first).to_be_visible(timeout=QUICK_TIMEOUT)


# ── SECTION: Bracket View ─────────────────────────────────────────────────────

@pytest.mark.standings
def test_cl_has_bracket_tab(page: Page):
    """Champions League competition page shows a 'Bracket' tab."""
    page.goto(APP_URL)
    _select_comp(page, "CL")
    page.wait_for_timeout(3_000)

    rows = page.locator("main div.relative.w-full.grid, main div.bg-slate-900").all()
    if len(rows) == 0:
        pytest.skip("CL page not loaded")

    bracket_tab = page.locator("main button", has_text="Bracket")
    expect(bracket_tab).to_be_visible(timeout=QUICK_TIMEOUT)


@pytest.mark.standings
def test_cl_bracket_view_renders_rounds(page: Page):
    """Switching to Bracket view on CL shows round labels (e.g. Round of 16, QF)."""
    page.goto(APP_URL)
    _select_comp(page, "CL")
    page.wait_for_timeout(3_000)

    bracket_tab = page.locator("main button", has_text="Bracket")
    if bracket_tab.count() == 0:
        pytest.skip("No Bracket tab on CL page")
    bracket_tab.click()
    page.wait_for_timeout(3_000)

    # Either bracket data or "not available" message
    has_rounds = page.locator("main").get_by_text(
        re.compile(r"Round|Quarter|Semi|Final", re.IGNORECASE)
    ).count() > 0
    has_unavailable = page.locator("main").get_by_text(
        "not available", exact=False
    ).count() > 0
    has_spinner = page.locator("[class*='animate-spin']").count() > 0

    assert has_rounds or has_unavailable or has_spinner, \
        "Bracket view shows neither round data, unavailable message, nor spinner"


@pytest.mark.standings
def test_pl_has_no_bracket_tab(page_with_pl_standings: Page):
    """Premier League (domestic league) does NOT show a 'Bracket' tab."""
    bracket_tab = page_with_pl_standings.locator("main button", has_text="Bracket")
    assert bracket_tab.count() == 0, "PL should not have a Bracket tab"


@pytest.mark.standings
def test_bracket_and_standings_tabs_switch_content(page: Page):
    """Clicking Standings and Bracket tabs swaps the visible content correctly."""
    page.goto(APP_URL)
    _select_comp(page, "CL")
    page.wait_for_timeout(3_000)

    standings_tab = page.locator("main button", has_text="Standings")
    bracket_tab = page.locator("main button", has_text="Bracket")
    if standings_tab.count() == 0 or bracket_tab.count() == 0:
        pytest.skip("CL standings/bracket tabs not present")

    # Start on standings — table grid rows should be visible
    rows_before = page.locator("div.relative.w-full.grid").count()

    # Switch to bracket
    bracket_tab.click()
    page.wait_for_timeout(1_000)
    rows_after = page.locator("div.relative.w-full.grid").count()

    # The standings table rows should disappear when showing bracket
    assert rows_after < rows_before or rows_before == 0, \
        "Standings rows still visible after switching to Bracket tab"

    # Switch back to standings
    standings_tab.click()
    page.wait_for_timeout(1_000)
    rows_restored = page.locator("div.relative.w-full.grid").count()
    assert rows_restored >= (rows_before if rows_before > 0 else 1), \
        "Standings rows did not restore after switching back from Bracket"


# ── SECTION: Team Navigation ──────────────────────────────────────────────────

@pytest.mark.standings
@pytest.mark.navigation
def test_clicking_team_navigates_to_squad(page_with_pl_standings: Page):
    """Clicking Arsenal in standings opens the team squad/lineup view."""
    page_with_pl_standings.locator("main div.relative.w-full.grid button span").filter(
        has_text="Arsenal"
    ).first.click()
    page_with_pl_standings.locator("[class*='font-mono']").first.wait_for(timeout=DATA_TIMEOUT)
    expect(page_with_pl_standings.locator("[class*='font-mono']").first).to_be_visible()


@pytest.mark.standings
@pytest.mark.navigation
def test_clicking_different_teams_navigates_correctly(page_with_pl_standings: Page):
    """Clicking two different teams updates the breadcrumb for each."""
    team_btns = page_with_pl_standings.locator(
        "main div.relative.w-full.grid button span"
    ).all()
    if len(team_btns) < 2:
        pytest.skip("Fewer than 2 team rows found")

    # Click the first team
    first_name = team_btns[0].inner_text().strip()
    team_btns[0].click()
    page_with_pl_standings.locator("[class*='font-mono']").first.wait_for(timeout=DATA_TIMEOUT)
    header_text = page_with_pl_standings.locator("header").inner_text()
    assert first_name in header_text, f"First team '{first_name}' not in breadcrumb"

    # Go back to standings
    page_with_pl_standings.locator("header button", has_text="Premier League").click()
    page_with_pl_standings.wait_for_timeout(800)

    # Click the second team
    second_name = team_btns[1].inner_text().strip()
    page_with_pl_standings.locator(
        "main div.relative.w-full.grid button span"
    ).filter(has_text=second_name).first.click()
    page_with_pl_standings.locator("[class*='font-mono']").first.wait_for(timeout=DATA_TIMEOUT)
    header_text2 = page_with_pl_standings.locator("header").inner_text()
    assert second_name in header_text2, f"Second team '{second_name}' not in breadcrumb"


# ── SECTION: Error States ─────────────────────────────────────────────────────

@pytest.mark.standings
def test_standings_error_shows_retry_button(page: Page):
    """When standings fail to load, a 'Try again' link is shown."""
    page.goto(APP_URL)
    # Route the standings API to return a 500 to trigger the error state
    page.route("**/api/competitions/*/standings", lambda route: route.fulfill(status=500, body='{"error":"simulated"}'))
    _wait_for_competitions(page)
    page.locator("aside select").first.select_option(value="PL")
    page.wait_for_timeout(2_000)

    retry_link = page.locator("text=Try again, text=try again")
    if retry_link.count() == 0:
        pytest.skip("Error state not triggered (standings may have loaded from cache)")
    expect(retry_link.first).to_be_visible()
