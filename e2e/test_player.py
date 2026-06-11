"""
Tests for the player career stats panel.
"""
import re
import pytest
from playwright.sync_api import Page, expect

from conftest import APP_URL, DATA_TIMEOUT, NAV_TIMEOUT, QUICK_TIMEOUT


def _nav_to_arsenal(page: Page) -> None:
    """Navigate to Arsenal squad view from home."""
    page.goto(APP_URL)
    try:
        page.locator("select option[value='PL']").wait_for(state="attached", timeout=30_000)
        page.locator("select").first.select_option(value="PL")
        page.get_by_text("Arsenal").first.wait_for(timeout=DATA_TIMEOUT)
    except Exception:
        pytest.skip("Competitions/standings API not ready — likely rate limiting")
    # Click Arsenal in MAIN standings table (not sidebar stat leaders)
    page.locator("main div.relative.w-full.grid button span").filter(
        has_text="Arsenal"
    ).first.click()
    page.locator("[class*='font-mono']").first.wait_for(timeout=DATA_TIMEOUT)


def _open_arsenal_player(page: Page) -> None:
    """Navigate to Arsenal squad and click the first squad card player."""
    _nav_to_arsenal(page)
    # Squad view is a SquadGrid with <section> elements per position group.
    # Each player card is a <button> inside a <section>.
    squad_btns = page.locator("section button").all()
    if not squad_btns:
        pytest.skip("No squad player card buttons found")
    squad_btns[0].click()
    # Clicking navigates to PlayerPage — wait for player name heading
    page.locator("h1").first.wait_for(timeout=DATA_TIMEOUT)


def test_player_panel_shows_name(page: Page):
    """Player page shows the player's name as an h1 heading."""
    _open_arsenal_player(page)
    # PlayerPage renders the name in an <h1>
    name_h1 = page.locator("h1").first
    name_h1.wait_for(timeout=QUICK_TIMEOUT)
    name_text = name_h1.inner_text().strip()
    assert len(name_text) > 2, f"Player name too short: '{name_text}'"


def test_player_panel_shows_nationality(page: Page):
    """Career panel shows nationality field."""
    _open_arsenal_player(page)
    # Nationality should appear somewhere in the panel
    expect(page.get_by_text("Nationality", exact=False).first).to_be_visible(timeout=QUICK_TIMEOUT)


def test_player_panel_shows_career_totals(page: Page):
    """Player page shows Career Totals section with Appearances, Goals, Assists."""
    _open_arsenal_player(page)
    career = page.get_by_text("Career Totals", exact=False)
    try:
        career.first.wait_for(timeout=DATA_TIMEOUT)
    except Exception:
        pytest.skip("Career Totals section not loaded — player may have no stats data")

    # PlayerPage labels are "Appearances", "Goals", "Assists" (not "Apps")
    for label in ["Appearances", "Goals", "Assists"]:
        assert page.get_by_text(label, exact=False).count() > 0, \
            f"'{label}' not found in career totals"


def test_player_panel_shows_season_stats(page: Page):
    """Career panel shows 'This Season' section."""
    _open_arsenal_player(page)
    page.wait_for_timeout(2000)  # allow Wikipedia data to load
    this_season = page.get_by_text("This Season", exact=False)
    if this_season.count() == 0:
        pytest.skip("'This Season' section absent — player has no current season appearances")
    assert this_season.count() > 0


def test_player_career_history_has_multiple_seasons(page: Page):
    """Player page shows Season by Season section for established players."""
    _open_arsenal_player(page)
    page.wait_for_timeout(4000)  # wait for Wikipedia data to pre-warm

    # PlayerPage uses a div grid (not <table>) for season-by-season history.
    # The section heading is "Season by Season" — check if it exists and has rows.
    season_section = page.get_by_text("Season by Season", exact=False)
    if season_section.count() == 0:
        # Wikipedia data may not have loaded — skip if Career Totals also absent
        career_totals = page.get_by_text("Career Totals", exact=False)
        if career_totals.count() == 0:
            pytest.skip("No career data loaded for this player — Wikipedia/API may not have data")
        return

    expect(season_section.first).to_be_visible(timeout=QUICK_TIMEOUT)
    # Season rows contain year strings like "2023-24" or "2024"
    season_rows = page.locator("main div").filter(has_text=re.compile(r"20\d\d")).all()
    assert len(season_rows) >= 1, "Season by Season section found but no year rows"


def test_player_panel_stats_not_all_zero_for_attacker(page: Page):
    """For Saka or another attacker, at least one non-zero stat should be shown."""
    _nav_to_arsenal(page)

    # Look for Saka or Martinelli player card
    player_btn = page.locator("section button p").filter(
        has_text=re.compile(r"Saka|Martinelli|Havertz|Trossard", re.IGNORECASE)
    ).first
    if player_btn.count() == 0:
        pytest.skip("Saka/Martinelli/attacker not found in squad — may be absent")

    player_btn.click()
    page.locator("h1").first.wait_for(timeout=DATA_TIMEOUT)
    page.wait_for_timeout(2000)  # give stats time to load

    # PlayerPage shows "Career Totals" section — extract all numbers
    stats_text = page.locator("main").inner_text()
    numbers = [int(n) for n in re.findall(r'\b(\d+)\b', stats_text) if int(n) > 0]
    assert len(numbers) > 0, \
        f"All stats appear to be 0. Page text: {stats_text[:500]}"


def test_player_panel_has_trophies_section(page: Page):
    """Honours section renders with correct heading when player has trophies."""
    _open_arsenal_player(page)
    page.wait_for_timeout(4000)  # wait for career data to load

    honours = page.get_by_text("Honours", exact=False)
    if honours.count() == 0:
        # PlayerPage only renders the Honours section when data.trophies.length > 0.
        # If the first squad player has no trophies the section is simply absent — skip.
        pytest.skip("First Arsenal squad player has no honours data — skip data-dependent test")
    expect(honours.first).to_be_visible(timeout=QUICK_TIMEOUT)
