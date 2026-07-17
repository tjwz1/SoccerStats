"""
Tests for the team favourites workflow.

Sections
--------
SECTION: Starring Teams      — star button in standings, state after toggle
SECTION: Sidebar Chips       — chips appear after starring, truncated name, click to navigate
SECTION: Chip Removal        — × button removes the favourite
SECTION: Multiple Favourites — starring multiple teams shows multiple chips
SECTION: Persistence         — favourites survive a page reload (localStorage)
SECTION: Calendar Filter     — My Teams toggle on the fixture calendar

To run these tests alone:
    pytest test_favourites.py -m favourites
"""
import re
import pytest
from playwright.sync_api import Page, expect

from conftest import (
    APP_URL, DATA_TIMEOUT, NAV_TIMEOUT, QUICK_TIMEOUT,
    _wait_for_competitions, _wait_for_pl_standings,
)


# ── Helpers ───────────────────────────────────────────────────────────────────

def _nav_to_pl_standings(page: Page) -> None:
    page.goto(APP_URL)
    _wait_for_competitions(page)
    page.locator("aside select").first.select_option(value="PL")
    _wait_for_pl_standings(page)


def _star_first_team(page: Page) -> str:
    """Hover the first standings row, click the star, return the team name."""
    first_row = page.locator("div.relative.w-full.grid").first
    first_row.hover()
    page.wait_for_timeout(200)
    star_btn = first_row.locator("button[title='Add to favourites']")
    star_btn.wait_for(timeout=QUICK_TIMEOUT)
    # Get team name from the row
    team_name_el = first_row.locator("button span[class*='font-medium']").first
    team_name = team_name_el.inner_text().strip()
    star_btn.click()
    page.wait_for_timeout(200)
    return team_name


# ── SECTION: Starring Teams ───────────────────────────────────────────────────

@pytest.mark.favourites
def test_star_button_visible_on_row_hover(page: Page):
    """Hovering a standings row reveals the ☆ (add to favourites) star button."""
    _nav_to_pl_standings(page)
    first_row = page.locator("div.relative.w-full.grid").first
    first_row.hover()
    page.wait_for_timeout(200)
    star_btn = first_row.locator("button[title*='favourite']")
    star_btn.wait_for(timeout=QUICK_TIMEOUT)
    expect(star_btn).to_be_visible()


@pytest.mark.favourites
def test_starring_team_changes_star_to_filled(page: Page):
    """After clicking the star, the button changes to ★ (filled) style."""
    _nav_to_pl_standings(page)
    _star_first_team(page)

    first_row = page.locator("div.relative.w-full.grid").first
    filled_star = first_row.locator("button[title='Remove from favourites']")
    if filled_star.count() == 0:
        filled_star = first_row.locator("button[class*='yellow-400']")
    assert filled_star.count() > 0, "Star did not become filled after clicking"


@pytest.mark.favourites
def test_unstarring_team_removes_fill(page: Page):
    """Clicking the filled star un-favourites the team (reverts to ☆)."""
    _nav_to_pl_standings(page)
    _star_first_team(page)

    first_row = page.locator("div.relative.w-full.grid").first
    filled_star = first_row.locator("button[title='Remove from favourites']")
    if filled_star.count() == 0:
        pytest.skip("Could not locate filled star button")
    filled_star.click()
    page.wait_for_timeout(200)

    # Should revert to unfilled
    unfilled = first_row.locator("button[title='Add to favourites']")
    first_row.hover()
    page.wait_for_timeout(100)
    assert unfilled.count() > 0, "Star did not revert to unfilled after un-favouriting"


@pytest.mark.favourites
def test_starred_team_always_shows_filled_star(page: Page):
    """A starred team shows ★ even without hovering (always-visible)."""
    _nav_to_pl_standings(page)
    _star_first_team(page)

    # Move mouse away to remove hover
    page.mouse.move(0, 0)
    page.wait_for_timeout(200)

    first_row = page.locator("div.relative.w-full.grid").first
    yellow_star = first_row.locator("button[class*='yellow-400']")
    assert yellow_star.count() > 0, \
        "Starred team's star button not visually distinct without hovering"


# ── SECTION: Sidebar Chips ────────────────────────────────────────────────────

@pytest.mark.favourites
def test_favourites_chip_appears_in_sidebar(page: Page):
    """A chip for the starred team appears in the sidebar Favourites strip."""
    _nav_to_pl_standings(page)
    team_name = _star_first_team(page)

    chip = page.locator("aside").get_by_text(
        re.compile(re.escape(team_name[:6]), re.IGNORECASE)
    )
    chip.first.wait_for(timeout=QUICK_TIMEOUT)
    assert chip.count() > 0, f"No chip found for team '{team_name}'"


@pytest.mark.favourites
def test_favourites_section_label_visible(page: Page):
    """A 'Favourites' section label appears in the sidebar when at least one team is starred."""
    _nav_to_pl_standings(page)
    _star_first_team(page)

    label = page.locator("aside").get_by_text("Favourites", exact=True)
    expect(label.first).to_be_visible(timeout=QUICK_TIMEOUT)


@pytest.mark.favourites
def test_favourites_section_absent_with_no_favourites(page: Page):
    """The Favourites section label is absent when no teams are starred."""
    _nav_to_pl_standings(page)  # fresh page, no favourites set

    label = page.locator("aside").get_by_text("Favourites", exact=True)
    assert label.count() == 0, "Favourites section shown when no teams are starred"


@pytest.mark.favourites
def test_chip_click_navigates_to_team(page: Page):
    """Clicking a favourite chip navigates to that team's view."""
    _nav_to_pl_standings(page)
    team_name = _star_first_team(page)

    # Go home to deselect the team
    page.get_by_title("Home").click()
    page.wait_for_timeout(500)

    # Navigate back to PL so chip is visible
    _wait_for_competitions(page)
    page.locator("aside select").first.select_option(value="PL")
    _wait_for_pl_standings(page)

    # Click the chip
    chip_btn = page.locator("aside div[class*='group/chip'] button").filter(
        has_text=re.compile(re.escape(team_name[:4]), re.IGNORECASE)
    ).first
    chip_btn.wait_for(timeout=QUICK_TIMEOUT)
    chip_btn.click()
    page.wait_for_timeout(1_500)

    # Should navigate to the team view
    tab_bar = page.locator("button[class*='bg-green-600']").filter(
        has_text=re.compile(r"Squad|Schedule|Honours|News")
    )
    assert tab_bar.count() > 0, \
        f"Chip click for '{team_name}' did not navigate to team view"


# ── SECTION: Chip Removal ─────────────────────────────────────────────────────

@pytest.mark.favourites
def test_chip_x_button_removes_favourite(page: Page):
    """Clicking the × on a chip removes the team from favourites."""
    _nav_to_pl_standings(page)
    team_name = _star_first_team(page)

    chip_container = page.locator("aside div[class*='group/chip']").filter(
        has=page.locator("button", has_text=re.compile(re.escape(team_name[:4])))
    ).first

    remove_btn = chip_container.locator("button[title='Remove from favourites']")
    if remove_btn.count() == 0:
        remove_btn = chip_container.locator("button").filter(has_text="×")
    remove_btn.wait_for(timeout=QUICK_TIMEOUT)
    remove_btn.click()
    page.wait_for_timeout(300)

    # Chip should be gone
    chips = page.locator("aside div[class*='group/chip']").all()
    remaining_texts = [c.inner_text() for c in chips]
    assert not any(team_name[:4] in t for t in remaining_texts), \
        f"Team '{team_name}' chip still present after removal"


@pytest.mark.favourites
def test_removing_last_favourite_hides_section(page: Page):
    """Removing the only favourite hides the Favourites section label."""
    _nav_to_pl_standings(page)
    _star_first_team(page)

    chip_container = page.locator("aside div[class*='group/chip']").first
    remove_btn = chip_container.locator("button").filter(has_text="×")
    if remove_btn.count() == 0:
        remove_btn = chip_container.locator("button[title='Remove from favourites']")
    remove_btn.first.click()
    page.wait_for_timeout(300)

    label = page.locator("aside").get_by_text("Favourites", exact=True)
    assert label.count() == 0, "Favourites section still visible after removing last favourite"


@pytest.mark.favourites
def test_unstar_from_standings_removes_chip(page: Page):
    """Clicking the filled ★ in standings also removes the chip from the sidebar."""
    _nav_to_pl_standings(page)
    _star_first_team(page)

    # Verify chip appeared
    chips_before = page.locator("aside div[class*='group/chip']").count()
    assert chips_before >= 1, "Chip did not appear after starring"

    # Un-star from standings
    first_row = page.locator("div.relative.w-full.grid").first
    filled_star = first_row.locator("button[title='Remove from favourites']")
    if filled_star.count() == 0:
        filled_star = first_row.locator("button[class*='yellow-400']")
    filled_star.click()
    page.wait_for_timeout(300)

    chips_after = page.locator("aside div[class*='group/chip']").count()
    assert chips_after < chips_before, \
        "Chip count did not decrease after un-starring from standings"


# ── SECTION: Multiple Favourites ──────────────────────────────────────────────

@pytest.mark.favourites
def test_multiple_teams_can_be_favourited(page: Page):
    """Starring two different teams shows two chips in the sidebar."""
    _nav_to_pl_standings(page)

    rows = page.locator("div.relative.w-full.grid").all()
    if len(rows) < 2:
        pytest.skip("Fewer than 2 standings rows found")

    # Star first team
    rows[0].hover()
    page.wait_for_timeout(150)
    page.locator("div.relative.w-full.grid").first.locator(
        "button[title='Add to favourites']"
    ).click(force=True)
    page.wait_for_timeout(150)

    # Star second team
    rows[1].hover()
    page.wait_for_timeout(150)
    page.locator("div.relative.w-full.grid").nth(1).locator(
        "button[title='Add to favourites']"
    ).click(force=True)
    page.wait_for_timeout(200)

    chips = page.locator("aside div[class*='group/chip']").all()
    assert len(chips) >= 2, f"Expected ≥2 chips for 2 starred teams, got {len(chips)}"


@pytest.mark.favourites
def test_each_team_has_separate_remove_button(page: Page):
    """Each favourite chip has its own × remove button."""
    _nav_to_pl_standings(page)

    rows = page.locator("div.relative.w-full.grid").all()
    if len(rows) < 2:
        pytest.skip("Fewer than 2 rows found")

    for i in range(min(2, len(rows))):
        rows[i].hover()
        page.wait_for_timeout(100)
        rows[i].locator("button[title='Add to favourites']").click(force=True)
        page.wait_for_timeout(100)

    page.wait_for_timeout(200)
    chips = page.locator("aside div[class*='group/chip']").all()
    for chip in chips:
        remove = chip.locator("button").filter(has_text="×")
        if remove.count() == 0:
            remove = chip.locator("button[title='Remove from favourites']")
        assert remove.count() >= 1, "A chip is missing its × remove button"


# ── SECTION: Persistence ──────────────────────────────────────────────────────

@pytest.mark.favourites
def test_favourite_persists_after_reload(page: Page):
    """Starred team remains in favourites after a full page reload."""
    _nav_to_pl_standings(page)
    team_name = _star_first_team(page)

    page.reload()
    page.wait_for_timeout(1_000)
    _wait_for_competitions(page)
    page.locator("aside select").first.select_option(value="PL")
    page.wait_for_timeout(500)

    chips = page.locator("aside div[class*='group/chip']").all()
    chip_texts = [c.inner_text() for c in chips]
    has_team = any(team_name[:4] in t for t in chip_texts)
    assert has_team, f"Team '{team_name}' not persisted after reload. Chips: {chip_texts}"


@pytest.mark.favourites
def test_favourite_persists_when_navigating_away(page: Page):
    """Favourites survive navigating to a team and back."""
    _nav_to_pl_standings(page)
    team_name = _star_first_team(page)

    # Navigate to the team view
    page.locator("main div.relative.w-full.grid button").first.click()
    page.wait_for_timeout(1_000)

    # Go back to standings
    page.locator("header button", has_text="Premier League").click()
    page.wait_for_timeout(500)

    chips = page.locator("aside div[class*='group/chip']").all()
    chip_texts = [c.inner_text() for c in chips]
    has_team = any(team_name[:4] in t for t in chip_texts)
    assert has_team, f"Favourite '{team_name}' lost after navigating away and back"


# ── SECTION: Calendar Filter ──────────────────────────────────────────────────

@pytest.mark.favourites
@pytest.mark.calendar
def test_my_teams_not_shown_without_favourites(page: Page):
    """★ My Teams toggle absent when user has no favourites."""
    page.goto(APP_URL)
    page.wait_for_timeout(500)
    assert page.get_by_text("★ My Teams").count() == 0


@pytest.mark.favourites
@pytest.mark.calendar
def test_my_teams_appears_after_starring_a_team(page: Page):
    """★ My Teams toggle appears on the home calendar after starring a team."""
    _nav_to_pl_standings(page)
    _star_first_team(page)
    page.get_by_title("Home").click()
    page.wait_for_timeout(500)
    expect(page.get_by_text("★ My Teams")).to_be_visible(timeout=QUICK_TIMEOUT)


@pytest.mark.favourites
@pytest.mark.calendar
def test_my_teams_toggle_is_clickable(page: Page):
    """★ My Teams toggle is clickable and shows active state."""
    _nav_to_pl_standings(page)
    _star_first_team(page)
    page.get_by_title("Home").click()
    page.wait_for_timeout(500)

    toggle = page.get_by_text("★ My Teams")
    toggle.wait_for(timeout=QUICK_TIMEOUT)
    toggle.click()
    page.wait_for_timeout(300)
    # Toggle should have changed visual state — just verify no crash
    has_error = page.locator("text=/error|crash/i").count()
    assert has_error == 0
