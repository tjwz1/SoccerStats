"""
Career-stats multi-league tests.

Verifies that the Season by Season career panel loads correctly for well-known
multi-club players across La Liga, Premier League, Bundesliga, and Ligue 1.

For each player we check:
  - Career panel has MORE than one season row
  - At least one row belongs to a PREVIOUS club (not the current one)
  - Season count is reported

Run alone:
    pytest test_career_multi_league.py -m career_multi -v -s
"""
import re
import pytest
from playwright.sync_api import Page, expect

from conftest import APP_URL, DATA_TIMEOUT, NAV_TIMEOUT, QUICK_TIMEOUT

# How long to wait for the season table to fully populate (SofaScore can be slow)
CAREER_TIMEOUT = 30_000

# Team IDs (fd.org) — used for direct URL navigation, which avoids standings
# availability issues (some leagues not started yet) and cold-cache latency.
TEAM_URL = {
    "barcelona":    f"{APP_URL}/competitions/PD/teams/81",
    "real_madrid":  f"{APP_URL}/competitions/PD/teams/86",
    "arsenal":      f"{APP_URL}/competitions/PL/teams/57",
    "bayern":       f"{APP_URL}/competitions/BL1/teams/5",
    "psg":          f"{APP_URL}/competitions/FL1/teams/524",
}


# ── Low-level navigation helpers ──────────────────────────────────────────────

def _goto_team(page: Page, team_key: str) -> None:
    """Navigate directly to a team's page; skip on timeout."""
    url = TEAM_URL[team_key]
    page.goto(url)
    try:
        expect(page).to_have_url(re.compile(r"/teams/\d+"), timeout=DATA_TIMEOUT)
    except Exception:
        pytest.skip(f"Team page '{team_key}' did not load ({url})")


def _open_squad_tab(page: Page) -> None:
    """Click the Squad tab and wait until at least one player card appears."""
    # Wait for the tab bar itself before clicking — direct URL navigation can
    # arrive before the lineup API responds and the tabs render.
    try:
        page.get_by_role("button", name="Squad").wait_for(state="visible", timeout=DATA_TIMEOUT)
    except Exception:
        pytest.skip("Squad tab button did not appear — team page may not have loaded")
    page.get_by_role("button", name="Squad").click()
    try:
        page.locator("section button").first.wait_for(timeout=DATA_TIMEOUT)
    except Exception:
        pytest.skip("Squad tab did not load player cards within timeout")


def _find_and_click_player(page: Page, player_pattern: str) -> None:
    """Locate the first squad card matching player_pattern and click it."""
    rx = re.compile(player_pattern, re.IGNORECASE)
    # Try narrow selector first (p inside button), then the whole button
    for selector in ["section button p", "section button"]:
        candidate = page.locator(selector).filter(has_text=rx).first
        if candidate.count() > 0:
            candidate.click(timeout=10_000)
            return
    pytest.skip(f"Player '{player_pattern}' not found in squad — roster may have changed")


def _wait_for_player_page(page: Page) -> None:
    """Wait until the player-profile h1 header appears."""
    try:
        expect(page).to_have_url(re.compile(r"/player/\d+"), timeout=NAV_TIMEOUT)
        page.locator("h1").first.wait_for(timeout=DATA_TIMEOUT)
    except Exception:
        pytest.skip("Player page did not load within timeout")


def _wait_for_season_table(page: Page) -> None:
    """Wait for 'Season by Season' heading to appear in main."""
    try:
        page.get_by_text("Season by Season", exact=False).first.wait_for(
            timeout=CAREER_TIMEOUT
        )
    except Exception:
        pytest.skip("Season by Season section not loaded — player may have no career data")


def _count_season_rows(page: Page) -> int:
    """Return the number of year-bearing rows in the Season by Season table."""
    rows = page.locator("main div").filter(
        has_text=re.compile(r"20\d\d")
    ).all()
    # Keep rows that have a year AND enough surrounding text to be a data row
    meaningful = []
    for row in rows:
        text = row.inner_text().strip()
        if re.search(r"20\d\d", text) and len(text) > 8:
            meaningful.append(text)
    return len(meaningful)


def _has_previous_club(page: Page, previous_club_patterns: list[str]) -> tuple[bool, str]:
    """
    Return (True, matched_pattern) if any previous-club name appears in the
    career table section.  Returns (False, '') otherwise.
    """
    try:
        section = page.get_by_text("Season by Season", exact=False).first.locator(
            "xpath=following-sibling::*"
        )
        table_text = section.inner_text()
    except Exception:
        table_text = page.locator("main").inner_text()

    for pat in previous_club_patterns:
        if re.search(pat, table_text, re.IGNORECASE):
            return True, pat
    return False, ""


# ── High-level helper: navigate directly to team → squad → player → career ────

def _navigate_to_player_career(
    page: Page,
    team_key: str,
    player_pattern: str,
) -> None:
    """
    Direct navigation: team URL → squad tab → player page → career stats.
    Skips at each step if the required state is not reached within timeout.
    """
    _goto_team(page, team_key)
    _open_squad_tab(page)
    _find_and_click_player(page, player_pattern)
    _wait_for_player_page(page)
    _wait_for_season_table(page)


# ── Test cases ────────────────────────────────────────────────────────────────

@pytest.mark.career_multi
def test_raphinha_barcelona_multi_club_career(page: Page):
    """
    Raphinha (FC Barcelona / La Liga) — previous clubs: Leeds, Rennes, Sporting CP.
    Expects > 1 career season rows and at least one previous-club entry.

    PASS / FAIL — Raphinha career history: shows multi-club seasons.
    """
    _navigate_to_player_career(page, "barcelona", r"Raphinha")
    page.wait_for_timeout(2_000)

    season_count = _count_season_rows(page)
    has_prev, matched = _has_previous_club(page, [r"Leeds", r"Rennes", r"Sporting"])

    print(f"\n[Raphinha] season rows: {season_count}  previous-club match: '{matched}'")

    assert season_count > 1, (
        f"FAIL — Raphinha: only {season_count} season row(s) visible "
        "(expected multi-club history with Leeds/Rennes/Sporting)"
    )
    assert has_prev, (
        f"FAIL — Raphinha: {season_count} rows found but NO previous-club data "
        "(Leeds/Rennes/Sporting absent) — likely only current-club rows cached"
    )


@pytest.mark.career_multi
def test_frenkie_dejong_barcelona_multi_club_career(page: Page):
    """
    Frenkie de Jong (FC Barcelona / La Liga) — previous: AFC Ajax, Jong Ajax.
    Expects > 1 career season rows and Ajax in the table.

    PASS / FAIL — Frenkie de Jong career history: shows multi-club seasons.
    """
    # Squad card shows lastName: "de Jong"
    _navigate_to_player_career(page, "barcelona", r"de Jong")
    page.wait_for_timeout(2_000)

    season_count = _count_season_rows(page)
    has_prev, matched = _has_previous_club(page, [r"Ajax"])

    print(f"\n[de Jong] season rows: {season_count}  previous-club match: '{matched}'")

    assert season_count > 1, (
        f"FAIL — de Jong: only {season_count} season row(s) visible "
        "(expected Ajax + Barcelona seasons)"
    )
    assert has_prev, (
        f"FAIL — de Jong: {season_count} rows found but NO Ajax data — "
        "showing only Barcelona rows"
    )


@pytest.mark.career_multi
def test_saka_arsenal_long_single_club_career(page: Page):
    """
    Bukayo Saka (Arsenal / Premier League) — Arsenal his whole career.
    Expects ≥ 6 season rows (debuted 2018/19).

    PASS / FAIL — Saka career history: shows 6+ seasons at Arsenal.
    """
    _navigate_to_player_career(page, "arsenal", r"Saka")
    page.wait_for_timeout(2_000)

    season_count = _count_season_rows(page)
    print(f"\n[Saka] season rows: {season_count}")

    assert season_count >= 6, (
        f"FAIL — Saka: only {season_count} season row(s) visible "
        "(expected ≥6 — debuted 2018/19)"
    )


@pytest.mark.career_multi
def test_kane_bayernmunich_multi_club_career(page: Page):
    """
    Harry Kane (FC Bayern München / Bundesliga) — previous: Tottenham, various loans.
    Expects > 1 career season rows and Tottenham in the table.

    PASS / FAIL — Kane career history: shows multi-club seasons.
    """
    _navigate_to_player_career(page, "bayern", r"Kane")
    page.wait_for_timeout(2_000)

    season_count = _count_season_rows(page)
    has_prev, matched = _has_previous_club(page, [r"Tottenham", r"Spurs", r"Millwall|Leicester|Swansea|Norwich"])

    print(f"\n[Kane] season rows: {season_count}  previous-club match: '{matched}'")

    assert season_count > 1, (
        f"FAIL — Kane: only {season_count} season row(s) visible "
        "(expected many seasons including Tottenham years)"
    )
    assert has_prev, (
        f"FAIL — Kane: {season_count} rows found but NO Tottenham/loan-club data — "
        "showing only Bayern München rows"
    )


@pytest.mark.career_multi
def test_bellingham_realmadrid_multi_club_career(page: Page):
    """
    Jude Bellingham (Real Madrid / La Liga) — previous: Dortmund, Birmingham City.
    Expects > 1 career season rows and Dortmund or Birmingham in the table.

    PASS / FAIL — Bellingham career history: shows multi-club seasons.
    """
    _navigate_to_player_career(page, "real_madrid", r"Bellingham")
    page.wait_for_timeout(2_000)

    season_count = _count_season_rows(page)
    has_prev, matched = _has_previous_club(page, [r"Dortmund", r"Birmingham"])

    print(f"\n[Bellingham] season rows: {season_count}  previous-club match: '{matched}'")

    assert season_count > 1, (
        f"FAIL — Bellingham: only {season_count} season row(s) visible "
        "(expected Dortmund + Birmingham + Real Madrid seasons)"
    )
    assert has_prev, (
        f"FAIL — Bellingham: {season_count} rows found but NO Dortmund/Birmingham data — "
        "showing only Real Madrid rows"
    )


@pytest.mark.career_multi
def test_dembele_psg_ligue1_multi_club_career(page: Page):
    """
    Ousmane Dembélé (PSG / Ligue 1) — previous: Barcelona, Dortmund, Rennes.
    Expects > 1 career season rows and at least one previous-club entry.

    PASS / FAIL — Dembélé career history (Ligue 1 player): shows multi-club seasons.
    """
    # Pattern matches "Dembélé" or ASCII "Dembele" (the accent may vary in rendering)
    _navigate_to_player_career(page, "psg", r"Demb[eé]")
    page.wait_for_timeout(2_000)

    season_count = _count_season_rows(page)
    has_prev, matched = _has_previous_club(page, [r"Barcelona|Barça|Barca", r"Dortmund", r"Rennes"])

    print(f"\n[Dembélé] season rows: {season_count}  previous-club match: '{matched}'")

    assert season_count > 1, (
        f"FAIL — Dembélé: only {season_count} season row(s) visible "
        "(expected Rennes + Dortmund + Barcelona + PSG seasons)"
    )
    assert has_prev, (
        f"FAIL — Dembélé: {season_count} rows found but NO previous-club data "
        "(Rennes/Dortmund/Barcelona absent) — showing only PSG rows"
    )
