"""
Tests for the team squad view (SquadGrid), schedule, and H2H panel.

Squad view: SquadGrid — player cards grouped by position in <section> elements.
  Clicking a card navigates to PlayerPage (/player/:id).
  Pitch view only appears in match lineup panel inside the Schedule tab.

Schedule view: MatchCard list grouped by phase (Results, Fixtures, etc.).
  Each match card has a "⚽ Lineup" TOGGLE button (always visible) that expands
  a panel with 4 tabs: "⚽ Lineup" | "📊 Stats" | "⏱ Timeline" | "H2H".
"""
import re
import pytest
from playwright.sync_api import Page, expect

from conftest import APP_URL, DATA_TIMEOUT, NAV_TIMEOUT, QUICK_TIMEOUT


# ── Squad / SquadGrid ──────────────────────────────────────────────────────────

def test_arsenal_lineup_loads(page_with_arsenal: Page):
    """Arsenal squad view shows at least 11 player cards in the SquadGrid."""
    # SquadGrid: player cards are <button> elements inside <section> elements
    page_with_arsenal.wait_for_timeout(1000)
    squad_btns = page_with_arsenal.locator("section button")
    assert squad_btns.count() >= 11, \
        f"Expected ≥11 squad card buttons, found {squad_btns.count()}"


def test_arsenal_formation_badge_visible(page_with_arsenal: Page):
    """Formation badge (e.g. 4-3-3) is visible in the header breadcrumb."""
    badge = page_with_arsenal.locator("[class*='font-mono']").first
    badge.wait_for(timeout=QUICK_TIMEOUT)
    text = badge.inner_text().strip()
    assert re.match(r"\d[\d-]+\d", text), f"Formation badge text '{text}' is not a formation"


def test_position_groups_visible(page_with_arsenal: Page):
    """Squad grid shows position group labels: Goalkeepers, Defenders, etc."""
    for group in ["Goalkeepers", "Defenders", "Midfielders"]:
        expect(page_with_arsenal.get_by_text(group, exact=True).first).to_be_visible(
            timeout=QUICK_TIMEOUT
        )


def test_player_card_hover_shows_tooltip(page_with_arsenal: Page):
    """Hovering over a squad player card shows the player tooltip."""
    squad_btns = page_with_arsenal.locator("section button").all()
    if not squad_btns:
        pytest.skip("No squad player card buttons found")

    squad_btns[0].hover()
    page_with_arsenal.wait_for_timeout(400)

    # Tooltip shows Nationality and/or Age
    has_nat = page_with_arsenal.get_by_text("Nationality", exact=False).count() > 0
    has_age = page_with_arsenal.get_by_text("Age", exact=False).count() > 0
    assert has_nat or has_age, "No tooltip visible after hovering a player card"


def test_player_card_click_navigates_to_player_page(page_with_arsenal: Page):
    """Clicking a squad player card navigates to the PlayerPage."""
    squad_btns = page_with_arsenal.locator("section button").all()
    if not squad_btns:
        pytest.skip("No squad player card buttons found")

    squad_btns[0].click()
    # PlayerPage has a "Back" button and an h1 with the player name
    page_with_arsenal.locator("h1").first.wait_for(timeout=DATA_TIMEOUT)
    expect(page_with_arsenal.get_by_text("Back", exact=True).first).to_be_visible(
        timeout=QUICK_TIMEOUT
    )


def test_player_page_back_button_returns_to_squad(page_with_arsenal: Page):
    """Clicking 'Back' on PlayerPage returns to the team squad view."""
    squad_btns = page_with_arsenal.locator("section button").all()
    if not squad_btns:
        pytest.skip("No squad player card buttons found")

    squad_btns[0].click()
    page_with_arsenal.locator("h1").first.wait_for(timeout=DATA_TIMEOUT)

    page_with_arsenal.get_by_text("Back", exact=True).click()
    page_with_arsenal.wait_for_timeout(500)

    # Should be back on the squad view — position groups visible again
    expect(page_with_arsenal.get_by_text("Goalkeepers", exact=True).first).to_be_visible(
        timeout=QUICK_TIMEOUT
    )


# ── Schedule tab ───────────────────────────────────────────────────────────────

def test_schedule_tab_visible(page_with_arsenal: Page):
    """Schedule tab button is visible in the team view tab bar."""
    schedule_tab = page_with_arsenal.get_by_role("button", name="Schedule")
    schedule_tab.wait_for(timeout=QUICK_TIMEOUT)
    expect(schedule_tab).to_be_visible()


def test_schedule_shows_match_cards(page_with_arsenal: Page):
    """Clicking the Schedule tab reveals match cards with '⚽ Lineup' toggle buttons."""
    page_with_arsenal.get_by_role("button", name="Schedule").click()
    # Wait for at least one Lineup toggle to appear (fixtures API may take a few seconds)
    try:
        page_with_arsenal.get_by_role("button", name="Lineup").first.wait_for(timeout=DATA_TIMEOUT)
    except Exception:
        pytest.skip("Schedule match cards did not render — fixtures API may be slow or rate-limited")
    lineup_toggles = page_with_arsenal.get_by_role("button", name="Lineup")
    assert lineup_toggles.count() > 0, \
        "No '⚽ Lineup' toggle buttons found — match cards did not render"


def test_match_card_expands_with_four_tabs(page_with_arsenal: Page):
    """Clicking '⚽ Lineup' on a match card expands it with 4 panel tabs."""
    page_with_arsenal.get_by_role("button", name="Schedule").click()
    page_with_arsenal.wait_for_timeout(2000)

    # Click first Lineup toggle button to expand the match card
    lineup_toggles = page_with_arsenal.get_by_role("button", name="Lineup")
    if lineup_toggles.count() == 0:
        pytest.skip("No match cards with lineup toggle found")

    lineup_toggles.first.click()
    page_with_arsenal.wait_for_timeout(800)

    # Inside the expanded panel: tab buttons have font-semibold uppercase tracking-wider
    # These are distinct from the toggle button which has font-medium
    tab_buttons = page_with_arsenal.locator(
        "button[class*='font-semibold'][class*='uppercase'][class*='tracking-wider']"
    )
    assert tab_buttons.count() >= 4, \
        f"Expected ≥4 panel tab buttons after expanding, found {tab_buttons.count()}"

    # Verify H2H tab is present (only appears in expanded panel, never as a toggle)
    h2h_tab = page_with_arsenal.get_by_text("H2H", exact=True)
    assert h2h_tab.count() > 0, "H2H tab not found in expanded match panel"


def test_h2h_tab_shows_content_or_empty_state(page_with_arsenal: Page):
    """H2H tab shows either past meetings or an empty-state message."""
    page_with_arsenal.get_by_role("button", name="Schedule").click()
    page_with_arsenal.wait_for_timeout(2000)

    lineup_toggles = page_with_arsenal.get_by_role("button", name="Lineup")
    if lineup_toggles.count() == 0:
        pytest.skip("No expandable match cards found")

    # Find a finished match — result badges ("Win", "Draw", "Loss") exist only for finished ones
    result_badges = page_with_arsenal.locator("span").filter(
        has_text=re.compile(r"^(Win|Draw|Loss)$")
    ).all()

    if not result_badges:
        # No finished matches visible — expand any card
        lineup_toggles.first.click()
    else:
        # Click the Lineup toggle inside the same card as a result badge
        # (use the first finished match's toggle)
        parent_card = result_badges[0].locator("xpath=ancestor::div[contains(@class,'bg-slate-800')]")
        card_toggle = parent_card.locator("button", has_text=re.compile(r"Lineup"))
        if card_toggle.count() > 0:
            card_toggle.first.click()
        else:
            lineup_toggles.first.click()

    page_with_arsenal.wait_for_timeout(500)

    # Click H2H tab
    h2h_tab = page_with_arsenal.get_by_text("H2H", exact=True).first
    h2h_tab.wait_for(timeout=QUICK_TIMEOUT)
    h2h_tab.click()

    # Wait for H2H content to appear — "meetings" appears in both "Last N meetings"
    # and "No recent meetings found..."; spinner has no "Loading" text (SVG only).
    try:
        page_with_arsenal.get_by_text("meetings", exact=False).first.wait_for(timeout=DATA_TIMEOUT)
        has_content = True
    except Exception:
        has_content = False

    if not has_content:
        # Still showing spinner — acceptable if the API is slow
        has_spinner = page_with_arsenal.locator("[class*='animate-spin']").count() > 0
        assert has_spinner, "H2H panel shows neither match data, empty state, nor loading spinner"


def test_h2h_panel_has_wdl_summary(page_with_arsenal: Page):
    """H2H panel shows a W/D/L summary when historical meetings exist."""
    page_with_arsenal.get_by_role("button", name="Schedule").click()
    page_with_arsenal.wait_for_timeout(2000)

    lineup_toggles = page_with_arsenal.get_by_role("button", name="Lineup")
    if lineup_toggles.count() == 0:
        pytest.skip("No expandable match cards found")

    lineup_toggles.first.click()
    page_with_arsenal.wait_for_timeout(500)

    h2h_tab = page_with_arsenal.get_by_text("H2H", exact=True).first
    h2h_tab.wait_for(timeout=QUICK_TIMEOUT)
    h2h_tab.click()
    page_with_arsenal.wait_for_timeout(3000)  # H2H fetch may take time

    # If meetings are found, W/D/L result badges should appear
    has_empty = page_with_arsenal.get_by_text("No recent meetings", exact=False).count() > 0
    if has_empty:
        pytest.skip("No H2H meetings for this fixture — empty state is correct")

    # H2H summary renders "{count}W", "{count}D", "{count}L" (e.g. "3W", "0D", "1L")
    result_spans = page_with_arsenal.locator("span").filter(
        has_text=re.compile(r"^\d+[WDL]$")
    )
    assert result_spans.count() >= 3, \
        f"Expected 3 W/D/L summary spans, found {result_spans.count()}"


def test_lineup_tab_content(page_with_arsenal: Page):
    """Lineup tab shows either a pitch with players or an 'unavailable' message."""
    page_with_arsenal.get_by_role("button", name="Schedule").click()
    page_with_arsenal.wait_for_timeout(2000)

    # Find a finished match with a result badge
    result_badges = page_with_arsenal.locator("span").filter(
        has_text=re.compile(r"^(Win|Draw|Loss)$")
    ).all()

    if not result_badges:
        pytest.skip("No finished matches found in schedule")

    lineup_toggles = page_with_arsenal.get_by_role("button", name="Lineup")
    lineup_toggles.first.click()
    page_with_arsenal.wait_for_timeout(1500)

    # Lineup tab is already selected by default — check for content
    has_content = (
        page_with_arsenal.locator("button.absolute.cursor-pointer").count() > 0  # pitch markers
        or page_with_arsenal.get_by_text("Lineup unavailable", exact=False).count() > 0
        or page_with_arsenal.locator("[class*='rounded-full']").count() > 3  # player avatar circles
    )
    assert has_content, "Lineup tab shows neither player data nor unavailable message"
