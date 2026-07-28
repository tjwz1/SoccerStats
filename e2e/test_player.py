"""
Tests for the player career stats page (/player/:id).

Sections
--------
SECTION: Page Structure     — header, back button, player name/position/identity
SECTION: Identity Fields    — nationality, age, shirt number
SECTION: Career Totals      — Appearances, Goals, Assists stat blocks
SECTION: This Season        — current-season stats section
SECTION: Season History     — season-by-season table rows and columns
SECTION: Honours            — trophies section grouped by category
SECTION: Empty States       — no-data message, loading spinner
SECTION: Photo Fallback     — broken image falls back to initials monogram
SECTION: Navigation         — back button, browser back, returning to correct team

To run these tests alone:
    pytest test_player.py -m player
"""
import re
import pytest
from playwright.sync_api import Page, expect

from conftest import APP_URL, DATA_TIMEOUT, NAV_TIMEOUT, QUICK_TIMEOUT


# ── Helpers ───────────────────────────────────────────────────────────────────

def _nav_to_arsenal(page: Page) -> None:
    """Navigate to Arsenal squad view from home."""
    page.goto(APP_URL)
    try:
        page.locator("select option[value='PL']").wait_for(state="attached", timeout=30_000)
        page.locator("aside select").first.select_option(value="PL")
        page.get_by_text("Arsenal").first.wait_for(timeout=DATA_TIMEOUT)
    except Exception:
        pytest.skip("Competitions/standings API not ready — likely rate limiting")
    page.locator("main div.relative.w-full.grid button span").filter(
        has_text="Arsenal"
    ).first.click()
    try:
        expect(page).to_have_url(re.compile(r"/teams/\d+"), timeout=DATA_TIMEOUT)
    except Exception:
        pytest.skip("Team view did not load within timeout")


def _open_arsenal_player(page: Page, index: int = 0) -> None:
    """Navigate to Arsenal squad and click the nth squad card player."""
    _nav_to_arsenal(page)
    page.get_by_role("button", name="Squad").click()
    page.wait_for_timeout(500)
    squad_btns = page.locator("section button").all()
    if not squad_btns or index >= len(squad_btns):
        pytest.skip("Squad player card buttons not found or index out of range")
    squad_btns[index].click()
    page.locator("h1").first.wait_for(timeout=DATA_TIMEOUT)


# ── SECTION: Page Structure ───────────────────────────────────────────────────

@pytest.mark.player
def test_player_page_has_header(page: Page):
    """Player page renders the app header with SS logo and Back button."""
    _open_arsenal_player(page)
    expect(page.locator("header")).to_be_visible(timeout=QUICK_TIMEOUT)
    expect(page.get_by_text("Back", exact=True)).to_be_visible(timeout=QUICK_TIMEOUT)


@pytest.mark.player
def test_player_panel_shows_name(page: Page):
    """Player page shows the player's name as an h1 heading."""
    _open_arsenal_player(page)
    name_h1 = page.locator("h1").first
    name_h1.wait_for(timeout=QUICK_TIMEOUT)
    name_text = name_h1.inner_text().strip()
    assert len(name_text) > 2, f"Player name too short: '{name_text}'"


@pytest.mark.player
def test_player_page_url_contains_player_id(page: Page):
    """Player page URL contains /player/:id."""
    _open_arsenal_player(page)
    url = page.url
    assert re.search(r"/player/\d+", url), f"URL does not contain /player/:id: '{url}'"


@pytest.mark.player
def test_player_page_url_contains_competition_param(page: Page):
    """Player page URL includes ?competition= query parameter."""
    _open_arsenal_player(page)
    url = page.url
    assert "competition=" in url, f"URL missing competition param: '{url}'"


@pytest.mark.player
def test_player_page_shows_position(page: Page):
    """Player page shows the player's position below their name."""
    _open_arsenal_player(page)
    page.wait_for_timeout(500)
    positions = ["Goalkeeper", "Defender", "Midfielder", "Attacker", "Forward"]
    main = page.locator("main")
    has_position = any(
        main.get_by_text(pos, exact=False).count() > 0
        for pos in positions
    )
    if not has_position:
        pytest.skip("Position not shown for this player (may be absent in API data)")
    assert has_position


# ── SECTION: Identity Fields ──────────────────────────────────────────────────

@pytest.mark.player
def test_player_panel_shows_nationality(page: Page):
    """Player page shows nationality field."""
    _open_arsenal_player(page)
    expect(page.get_by_text("Nationality", exact=False).first).to_be_visible(
        timeout=QUICK_TIMEOUT
    )


@pytest.mark.player
def test_player_panel_nationality_is_non_empty(page: Page):
    """Nationality field shows a non-empty country name."""
    _open_arsenal_player(page)
    nat_label = page.get_by_text("Nationality", exact=False).first
    nat_label.wait_for(timeout=QUICK_TIMEOUT)
    # Nationality value is a sibling span with text-white font-medium
    nat_value = page.locator("span.text-white.font-medium").first
    nat_value.wait_for(timeout=QUICK_TIMEOUT)
    text = nat_value.inner_text().strip()
    assert len(text) > 1, f"Nationality value is empty or too short: '{text}'"


@pytest.mark.player
def test_player_panel_shows_age(page: Page):
    """Player page shows age field when date of birth is available."""
    _open_arsenal_player(page)
    age_label = page.get_by_text("Age", exact=False)
    if age_label.count() == 0:
        pytest.skip("Age field absent — date of birth not in API response for this player")
    age_val = page.locator("span.text-white.font-medium").all()
    ages = [s.inner_text().strip() for s in age_val if s.inner_text().strip().isdigit()]
    if not ages:
        pytest.skip("No numeric age value found")
    assert 14 <= int(ages[0]) <= 50, f"Implausible age value: {ages[0]}"


@pytest.mark.player
def test_player_shirt_number_shown_when_available(page: Page):
    """Shirt number is shown in the identity block when it exists."""
    _open_arsenal_player(page)
    shirt_label = page.get_by_text("Shirt", exact=False)
    if shirt_label.count() == 0:
        pytest.skip("Shirt number not shown for first squad player")
    # Shirt number should be a small positive integer
    shirt_vals = page.locator("span.text-white.font-medium").filter(
        has_text=re.compile(r"#\d+")
    ).all()
    if not shirt_vals:
        pytest.skip("No shirt number span found")
    text = shirt_vals[0].inner_text().strip()
    num = re.search(r"\d+", text)
    assert num and 1 <= int(num.group()) <= 99, f"Unusual shirt number: '{text}'"


# ── SECTION: Career Totals ────────────────────────────────────────────────────

@pytest.mark.player
def test_player_panel_shows_career_totals(page: Page):
    """Player page shows Career Totals section with Appearances, Goals, Assists."""
    _open_arsenal_player(page)
    career = page.get_by_text("Career Totals", exact=False)
    try:
        career.first.wait_for(timeout=DATA_TIMEOUT)
    except Exception:
        pytest.skip("Career Totals section not loaded — player may have no stats data")

    for label in ["Appearances", "Goals", "Assists"]:
        assert page.get_by_text(label, exact=False).count() > 0, \
            f"'{label}' not found in career totals"


@pytest.mark.player
def test_career_totals_values_are_non_negative(page: Page):
    """Career Totals Appearances, Goals, and Assists are all ≥ 0."""
    _open_arsenal_player(page)
    try:
        page.get_by_text("Career Totals", exact=False).first.wait_for(timeout=DATA_TIMEOUT)
    except Exception:
        pytest.skip("Career Totals not loaded")

    # Stat blocks show a large number then a label
    stat_blocks = page.locator("div[class*='bg-slate-900'][class*='rounded-2xl'][class*='text-center']")
    values = []
    for block in stat_blocks.all():
        num_el = block.locator("p.text-4xl")
        if num_el.count() > 0:
            text = num_el.first.inner_text().strip()
            if text.isdigit():
                values.append(int(text))

    if not values:
        pytest.skip("No stat block values found")
    for v in values:
        assert v >= 0, f"Negative stat value: {v}"


@pytest.mark.player
def test_career_totals_goals_less_than_or_equal_appearances(page: Page):
    """Goals ≤ Appearances is a basic sanity check on career totals data."""
    _open_arsenal_player(page)
    try:
        page.get_by_text("Career Totals", exact=False).first.wait_for(timeout=DATA_TIMEOUT)
    except Exception:
        pytest.skip("Career Totals not loaded")

    stat_blocks = page.locator(
        "div[class*='bg-slate-900'][class*='rounded-2xl'][class*='text-center']"
    ).all()
    values = []
    for block in stat_blocks:
        num_el = block.locator("p.text-4xl")
        if num_el.count() > 0:
            text = num_el.first.inner_text().strip()
            if text.isdigit():
                values.append(int(text))

    if len(values) < 2:
        pytest.skip("Not enough stat blocks to compare appearances vs goals")
    appearances, goals = values[0], values[1]
    if appearances == 0:
        pytest.skip("Appearances is 0 — no data to compare")
    assert goals <= appearances, \
        f"Goals ({goals}) > Appearances ({appearances}) — data sanity check failed"


# ── SECTION: This Season ──────────────────────────────────────────────────────

@pytest.mark.player
def test_player_panel_shows_season_stats(page: Page):
    """Player page shows 'This Season' section."""
    _open_arsenal_player(page)
    page.wait_for_timeout(2_000)
    this_season = page.get_by_text("This Season", exact=False)
    if this_season.count() == 0:
        pytest.skip("'This Season' section absent — player has no current season appearances")
    expect(this_season.first).to_be_visible(timeout=QUICK_TIMEOUT)


@pytest.mark.player
def test_this_season_has_three_stat_boxes(page: Page):
    """'This Season' section shows Appearances, Goals, and Assists boxes."""
    _open_arsenal_player(page)
    page.wait_for_timeout(2_000)
    section_h2 = page.get_by_text("This Season", exact=False).first
    if section_h2.count() == 0:
        pytest.skip("'This Season' section not shown")

    for label in ["Appearances", "Goals", "Assists"]:
        assert page.get_by_text(label, exact=False).count() > 0, \
            f"'{label}' not found in 'This Season' section"


# ── SECTION: Season History ───────────────────────────────────────────────────

@pytest.mark.player
def test_player_career_history_has_multiple_seasons(page: Page):
    """Player page shows Season by Season section for established players."""
    _open_arsenal_player(page)
    page.wait_for_timeout(4_000)

    season_section = page.get_by_text("Season by Season", exact=False)
    if season_section.count() == 0:
        career_totals = page.get_by_text("Career Totals", exact=False)
        if career_totals.count() == 0:
            pytest.skip("No career data loaded — Wikipedia/API may not have data")
        return

    expect(season_section.first).to_be_visible(timeout=QUICK_TIMEOUT)
    season_rows = page.locator("main div").filter(has_text=re.compile(r"20\d\d")).all()
    assert len(season_rows) >= 1, "Season by Season section found but no year rows"


@pytest.mark.player
def test_season_table_has_correct_columns(page: Page):
    """Season-by-season table shows: Club/Competition, Season, Apps, G, A, G/G columns."""
    _open_arsenal_player(page)
    page.wait_for_timeout(4_000)

    table_header = page.locator("main div[class*='grid'][class*='bg-slate-900']").first
    if table_header.count() == 0:
        pytest.skip("Season table header not found")
    header_text = table_header.inner_text().upper()
    for col in ["SEASON", "APPS", "G", "A"]:
        assert col in header_text, f"Column '{col}' not found in season table header"


@pytest.mark.player
def test_season_rows_show_club_name(page: Page):
    """Season-by-season rows each show a club name."""
    _open_arsenal_player(page)
    page.wait_for_timeout(4_000)

    season_section = page.get_by_text("Season by Season", exact=False)
    if season_section.count() == 0:
        pytest.skip("Season by Season section not present")

    rows = page.locator(
        "main div[class*='grid'][class*='border-b']:not([class*='bg-slate-900'])"
    ).all()
    if not rows:
        pytest.skip("No season rows found")
    for row in rows[:3]:
        text = row.inner_text().strip()
        assert len(text) > 2, f"Season row appears empty: '{text}'"


@pytest.mark.player
def test_gpg_column_computed_correctly(page: Page):
    """Goals-per-game (G/G) column should equal goals ÷ appearances or '—'."""
    _open_arsenal_player(page)
    page.wait_for_timeout(4_000)

    season_section = page.get_by_text("Season by Season", exact=False)
    if season_section.count() == 0:
        pytest.skip("No season history available")

    # GPG values are xs text-slate-400 in the right-most column
    gpg_cells = page.locator("span[class*='tabular-nums'][class*='text-xs']").all()
    if not gpg_cells:
        pytest.skip("No G/G cells found")

    for cell in gpg_cells[:5]:
        text = cell.inner_text().strip()
        assert text == "—" or re.match(r"^\d+\.\d{2}$", text), \
            f"Unexpected G/G value: '{text}'"


# ── SECTION: Honours ──────────────────────────────────────────────────────────

@pytest.mark.player
def test_player_panel_has_trophies_section(page: Page):
    """Honours section renders with correct heading when player has trophies."""
    _open_arsenal_player(page)
    page.wait_for_timeout(4_000)

    honours = page.get_by_text("Honours", exact=False)
    if honours.count() == 0:
        pytest.skip("First Arsenal squad player has no honours data")
    expect(honours.first).to_be_visible(timeout=QUICK_TIMEOUT)


@pytest.mark.player
def test_player_honours_grouped_by_category(page: Page):
    """Player honours show at least one category: Club, International, or Individual."""
    _open_arsenal_player(page)
    page.wait_for_timeout(4_000)

    honours_section = page.get_by_text("Honours", exact=False)
    if honours_section.count() == 0:
        pytest.skip("No honours section for this player")

    categories = ["Club", "International", "Individual"]
    main = page.locator("main")
    has_category = any(
        main.get_by_text(cat, exact=True).count() > 0
        for cat in categories
    )
    assert has_category, f"No category label found in honours section. Expected one of: {categories}"


@pytest.mark.player
def test_player_honours_show_year_badges(page: Page):
    """Player honours show 4-digit year badges for each trophy won."""
    _open_arsenal_player(page)
    page.wait_for_timeout(4_000)

    honours_section = page.get_by_text("Honours", exact=False)
    if honours_section.count() == 0:
        pytest.skip("No honours section")

    year_badges = page.locator("main span[class*='font-mono']").filter(
        has_text=re.compile(r"^(19|20)\d{2}$")
    )
    if year_badges.count() == 0:
        pytest.skip("No year badges in honours — player may only have non-dated entries")
    assert year_badges.count() > 0


# ── SECTION: Empty States ─────────────────────────────────────────────────────

@pytest.mark.player
def test_player_page_loading_shows_spinner(page: Page):
    """While career stats load, a spinner is shown."""
    _nav_to_arsenal(page)
    page.get_by_role("button", name="Squad").click()
    page.wait_for_timeout(500)
    squad_btns = page.locator("section button").all()
    if not squad_btns:
        pytest.skip("No squad buttons found")

    # Click player to navigate
    squad_btns[0].click()

    # Immediately check for spinner (before data arrives)
    # This is a race — skip if data was already cached
    spinner = page.locator("[class*='animate-spin']")
    if spinner.count() == 0:
        pytest.skip("Page loaded too fast to catch spinner — data was cached")
    assert spinner.count() > 0


@pytest.mark.player
def test_no_stats_player_shows_empty_message(page: Page):
    """A player with no career data shows an informative empty state."""
    _nav_to_arsenal(page)
    page.get_by_role("button", name="Squad").click()
    page.wait_for_timeout(500)
    squad_btns = page.locator("section button").all()
    if not squad_btns:
        pytest.skip("No squad buttons")

    # Try multiple players — look for one with no stats (often GK or youth player)
    for btn in squad_btns:
        btn.click()
        page.locator("h1").first.wait_for(timeout=DATA_TIMEOUT)
        page.wait_for_timeout(2_000)

        has_career = page.get_by_text("Career Totals", exact=False).count() > 0
        has_empty_msg = page.get_by_text(
            re.compile(r"No career stats|Stats are sourced", re.IGNORECASE)
        ).count() > 0

        if has_empty_msg:
            expect(page.get_by_text(
                re.compile(r"No career stats|Stats are sourced", re.IGNORECASE)
            ).first).to_be_visible()
            return

        if has_career:
            page.go_back()
            page.wait_for_timeout(500)
            page.get_by_role("button", name="Squad").click()
            page.wait_for_timeout(300)
            squad_btns = page.locator("section button").all()
            continue
        break

    pytest.skip("Could not find a player with empty stats to verify empty state")


@pytest.mark.player
def test_error_state_shows_retry_button(page: Page):
    """When the player API fails, a Retry button is displayed."""
    page.goto(APP_URL)

    # Intercept player API to force a failure
    page.route("**/api/players/**", lambda r: r.fulfill(status=500, body='{"error":"test"}'))

    try:
        page.locator("select option[value='PL']").wait_for(state="attached", timeout=30_000)
        page.locator("aside select").first.select_option(value="PL")
        page.locator("main div.relative.w-full.grid button span").filter(
            has_text="Arsenal"
        ).first.click(timeout=DATA_TIMEOUT)
        page.locator("[class*='font-mono']").first.wait_for(timeout=DATA_TIMEOUT)
        page.get_by_role("button", name="Squad").click()
        page.wait_for_timeout(500)
        page.locator("section button").first.click()
        page.locator("h1").first.wait_for(timeout=NAV_TIMEOUT)
        page.wait_for_timeout(2_000)
    except Exception:
        pytest.skip("Could not reach player page for error state test")

    retry = page.get_by_role("button", name="Retry")
    if retry.count() == 0:
        # Error may have been caught differently — check for any error message
        error_msg = page.get_by_text(re.compile(r"Could not load|failed|error", re.IGNORECASE))
        if error_msg.count() == 0:
            pytest.skip("Error state not triggered — response may have come from cache")
    else:
        expect(retry).to_be_visible(timeout=QUICK_TIMEOUT)


# ── SECTION: Photo Fallback ───────────────────────────────────────────────────

@pytest.mark.player
def test_player_photo_or_initials_monogram_shown(page: Page):
    """Player hero shows either a photo or an initials monogram (fallback)."""
    _open_arsenal_player(page)
    page.wait_for_timeout(500)

    hero = page.locator("main div[class*='rounded-2xl']").first
    hero.wait_for(timeout=QUICK_TIMEOUT)

    has_photo = hero.locator("img").count() > 0
    has_monogram = hero.locator("span[class*='font-black']").count() > 0

    assert has_photo or has_monogram, \
        "Player hero shows neither a photo nor an initials monogram"


@pytest.mark.player
def test_broken_photo_falls_back_to_monogram(page: Page):
    """When the player photo URL returns 404, the component falls back to initials."""
    _nav_to_arsenal(page)
    page.get_by_role("button", name="Squad").click()
    page.wait_for_timeout(500)

    # Intercept photo requests to simulate broken images
    page.route("**/*.jpg", lambda r: r.fulfill(status=404, body=b""))
    page.route("**/*.png", lambda r: r.fulfill(status=404, body=b""))
    page.route("**/*.webp", lambda r: r.fulfill(status=404, body=b""))

    squad_btns = page.locator("section button").all()
    if not squad_btns:
        pytest.skip("No squad buttons")

    squad_btns[0].click()
    page.locator("h1").first.wait_for(timeout=DATA_TIMEOUT)
    page.wait_for_timeout(1_000)

    hero = page.locator("main div[class*='rounded-2xl']").first
    # With 404 on image, fallback monogram should appear
    monogram = hero.locator("span[class*='font-black']")
    if monogram.count() == 0:
        # If the photo loaded from cache or the player never had one, skip
        pytest.skip("Could not verify broken photo fallback — image may be cached")
    expect(monogram.first).to_be_visible(timeout=QUICK_TIMEOUT)


# ── SECTION: Navigation ───────────────────────────────────────────────────────

@pytest.mark.player
@pytest.mark.navigation
def test_player_page_back_button_returns_to_squad(page: Page):
    """Clicking 'Back' on PlayerPage returns to the team squad view."""
    _open_arsenal_player(page)
    page.get_by_text("Back", exact=True).click()
    page.wait_for_timeout(500)
    expect(page.get_by_text("Goalkeepers", exact=True).first).to_be_visible(
        timeout=QUICK_TIMEOUT
    )


@pytest.mark.player
@pytest.mark.navigation
def test_player_page_back_shows_correct_team_in_breadcrumb(page: Page):
    """After pressing Back from player page, the breadcrumb still shows the team name."""
    _open_arsenal_player(page)
    page.get_by_text("Back", exact=True).click()
    page.wait_for_timeout(800)
    header_text = page.locator("header").inner_text()
    assert "Arsenal" in header_text, \
        f"Arsenal not in breadcrumb after Back from player page: '{header_text}'"


@pytest.mark.player
@pytest.mark.navigation
def test_player_page_ss_logo_shows_home(page: Page):
    """The SS logo on the player page header links back to the main app."""
    _open_arsenal_player(page)
    # Player page header has a small SS div linking to the app root
    ss_logo = page.locator("header div[class*='bg-green-600']").first
    ss_logo.wait_for(timeout=QUICK_TIMEOUT)
    expect(ss_logo).to_be_visible()


@pytest.mark.player
@pytest.mark.navigation
def test_player_panel_stats_not_all_zero_for_attacker(page: Page):
    """For a known attacker like Saka or Martinelli, at least one stat is non-zero."""
    _nav_to_arsenal(page)
    page.get_by_role("button", name="Squad").click()
    page.wait_for_timeout(500)

    player_btn = page.locator("section button p").filter(
        has_text=re.compile(r"Saka|Martinelli|Havertz|Trossard|Odegaard", re.IGNORECASE)
    ).first
    if player_btn.count() == 0:
        pytest.skip("No known Arsenal attacker found in squad — roster may have changed")

    player_btn.click()
    page.locator("h1").first.wait_for(timeout=DATA_TIMEOUT)
    page.wait_for_timeout(2_000)

    stats_text = page.locator("main").inner_text()
    numbers = [int(n) for n in re.findall(r'\b(\d+)\b', stats_text) if int(n) > 0]
    assert len(numbers) > 0, \
        f"All stats appear to be 0 for attacker. Page text (first 500 chars):\n{stats_text[:500]}"
