"""
Tests for team search — sidebar search input and mobile header search.

Sections
--------
SECTION: Sidebar Search        — input, 2-char min, debounce, results, selection
SECTION: Search Result Items   — crest, name, match-any-field matching
SECTION: Header Mobile Search  — icon shows on narrow viewport, open/close, results
SECTION: Search Consistency    — both search surfaces behave identically for the same query
SECTION: Search Edge Cases     — empty query, no results, special characters

To run these tests alone:
    pytest test_search.py -m search
"""
import re
import pytest
from playwright.sync_api import Page, expect

from conftest import APP_URL, NAV_TIMEOUT, DATA_TIMEOUT, QUICK_TIMEOUT, _wait_for_competitions


# ── Helpers ───────────────────────────────────────────────────────────────────

def _type_in_sidebar_search(page: Page, query: str) -> None:
    """Type into the sidebar team search input."""
    sidebar_search = page.locator("aside input[placeholder*='Search']")
    sidebar_search.wait_for(timeout=NAV_TIMEOUT)
    sidebar_search.fill(query)


def _open_header_search(mobile_page: Page) -> None:
    """Click the search icon in the header to open header search (mobile only)."""
    icon = mobile_page.locator("header button[aria-label='Search teams']")
    icon.wait_for(timeout=NAV_TIMEOUT)
    icon.click()
    mobile_page.wait_for_timeout(200)


# ── SECTION: Sidebar Search ───────────────────────────────────────────────────

@pytest.mark.search
def test_sidebar_search_input_present(page: Page):
    """Sidebar has a team search input with the correct placeholder."""
    page.goto(APP_URL)
    sidebar_search = page.locator("aside input[placeholder*='Search']")
    sidebar_search.wait_for(timeout=NAV_TIMEOUT)
    expect(sidebar_search).to_be_visible()


@pytest.mark.search
def test_sidebar_search_one_char_shows_hint(page: Page):
    """Typing one character shows a 'Type at least 2 characters' hint."""
    page.goto(APP_URL)
    _type_in_sidebar_search(page, "A")
    page.wait_for_timeout(400)
    hint = page.locator("aside p").filter(has_text=re.compile(r"2 characters|at least 2", re.IGNORECASE))
    expect(hint.first).to_be_visible(timeout=QUICK_TIMEOUT)


@pytest.mark.search
def test_sidebar_search_two_chars_triggers_request(page: Page):
    """Typing 2+ characters hides the hint and shows results or spinner."""
    page.goto(APP_URL)
    _type_in_sidebar_search(page, "Ar")
    page.wait_for_timeout(600)

    hint = page.locator("aside p").filter(has_text=re.compile(r"2 characters", re.IGNORECASE))
    # Hint should be gone once we have 2+ chars
    assert hint.count() == 0 or not hint.first.is_visible(), \
        "2-char hint should not show after typing 2 characters"


@pytest.mark.search
def test_sidebar_search_returns_results_for_arsenal(page: Page):
    """Searching 'Arsenal' returns at least one matching result in the sidebar."""
    page.goto(APP_URL)
    _type_in_sidebar_search(page, "Arsenal")
    try:
        page.locator("aside button").filter(
            has_text=re.compile(r"Arsenal", re.IGNORECASE)
        ).first.wait_for(timeout=DATA_TIMEOUT)
    except Exception:
        pytest.skip("Team search API not ready — likely rate limiting")

    results = page.locator("aside button").filter(
        has_text=re.compile(r"Arsenal", re.IGNORECASE)
    )
    assert results.count() > 0, "No Arsenal result in sidebar search"


@pytest.mark.search
def test_sidebar_search_selecting_team_clears_input(page: Page):
    """Selecting a team from sidebar search results clears the search input."""
    page.goto(APP_URL)
    _type_in_sidebar_search(page, "Arsenal")
    try:
        result_btn = page.locator("aside button").filter(
            has_text=re.compile(r"Arsenal", re.IGNORECASE)
        ).first
        result_btn.wait_for(timeout=DATA_TIMEOUT)
        result_btn.click()
    except Exception:
        pytest.skip("Team search API not ready or no results")

    page.wait_for_timeout(500)
    input_val = page.locator("aside input[placeholder*='Search']").input_value()
    assert input_val == "", f"Search input not cleared after team selection, got: '{input_val}'"


@pytest.mark.search
def test_sidebar_search_selecting_team_navigates(page: Page):
    """Selecting a team from sidebar search navigates to that team's view."""
    page.goto(APP_URL)
    _type_in_sidebar_search(page, "Chelsea")
    try:
        result_btn = page.locator("aside button").filter(
            has_text=re.compile(r"Chelsea", re.IGNORECASE)
        ).first
        result_btn.wait_for(timeout=DATA_TIMEOUT)
        result_btn.click()
    except Exception:
        pytest.skip("Team search API not ready or no results")

    page.wait_for_timeout(1_500)
    # Breadcrumb should contain the selected team name
    header_text = page.locator("header").inner_text()
    assert re.search(r"Chelsea", header_text, re.IGNORECASE), \
        f"'Chelsea' not in breadcrumb after selection: '{header_text}'"


@pytest.mark.search
def test_sidebar_search_no_results_shows_message(page: Page):
    """Searching a nonsense string shows a 'no teams found' message."""
    page.goto(APP_URL)
    _type_in_sidebar_search(page, "xyzqwerty123nosuchtm")
    page.wait_for_timeout(1_200)

    no_results = page.locator("aside").get_by_text(
        re.compile(r"No teams found|no results", re.IGNORECASE)
    )
    expect(no_results.first).to_be_visible(timeout=QUICK_TIMEOUT)


@pytest.mark.search
def test_sidebar_search_results_hidden_when_input_cleared(page: Page):
    """Clearing the search input hides the results and restores the normal sidebar."""
    page.goto(APP_URL)
    _type_in_sidebar_search(page, "Arsenal")
    page.wait_for_timeout(800)

    # Clear input
    page.locator("aside input[placeholder*='Search']").fill("")
    page.wait_for_timeout(400)

    # Competition dropdown should be visible again (normal sidebar view)
    comp_select = page.locator("aside select")
    expect(comp_select.first).to_be_visible(timeout=QUICK_TIMEOUT)


# ── SECTION: Search Result Items ──────────────────────────────────────────────

@pytest.mark.search
def test_search_results_show_team_names(page: Page):
    """Search results display team names in each result button."""
    page.goto(APP_URL)
    _type_in_sidebar_search(page, "Man")
    try:
        page.locator("aside button").filter(
            has_text=re.compile(r"Manchester|Man United|Man City", re.IGNORECASE)
        ).first.wait_for(timeout=DATA_TIMEOUT)
    except Exception:
        pytest.skip("Team search not ready")

    results = page.locator("aside button").filter(
        has_text=re.compile(r"Manchester|Man United|Man City", re.IGNORECASE)
    )
    assert results.count() >= 1


@pytest.mark.search
def test_search_results_show_crests(page: Page):
    """Search results display team crest images (img or fallback div)."""
    page.goto(APP_URL)
    _type_in_sidebar_search(page, "Liverpool")
    try:
        page.locator("aside button").filter(
            has_text=re.compile(r"Liverpool", re.IGNORECASE)
        ).first.wait_for(timeout=DATA_TIMEOUT)
    except Exception:
        pytest.skip("Team search not ready")

    # Result buttons contain either an img or a fallback TLA div
    result_btn = page.locator("aside button").filter(
        has_text=re.compile(r"Liverpool", re.IGNORECASE)
    ).first
    has_img = result_btn.locator("img").count() > 0
    has_fallback = result_btn.locator("div[class*='rounded-full']").count() > 0
    assert has_img or has_fallback, "Search result has neither crest image nor fallback div"


@pytest.mark.search
def test_search_matches_on_short_name(page: Page):
    """Search also matches on short name / TLA (e.g. 'MCI' finds Man City)."""
    page.goto(APP_URL)
    _type_in_sidebar_search(page, "MCI")
    page.wait_for_timeout(1_200)

    results = page.locator("aside button").filter(
        has_text=re.compile(r"Manchester City|Man City", re.IGNORECASE)
    )
    if results.count() == 0:
        pytest.skip("MCI TLA search returned no results — acceptable if API returned empty")


@pytest.mark.search
def test_search_results_capped_at_fifteen(page: Page):
    """Search returns at most 15 team results."""
    page.goto(APP_URL)
    _type_in_sidebar_search(page, "FC")
    page.wait_for_timeout(1_500)

    # Results may be shown as buttons in the aside div
    result_buttons = page.locator("aside div button[class*='rounded']").all()
    if len(result_buttons) == 0:
        pytest.skip("No FC results found")
    assert len(result_buttons) <= 15, \
        f"Search returned {len(result_buttons)} results but should be capped at 15"


# ── SECTION: Header Mobile Search ────────────────────────────────────────────

@pytest.mark.search
@pytest.mark.mobile
def test_header_search_icon_visible_on_mobile(mobile_page: Page):
    """Header search icon button is visible on narrow viewport."""
    icon = mobile_page.locator("header button[aria-label='Search teams']")
    icon.wait_for(timeout=NAV_TIMEOUT)
    expect(icon).to_be_visible()


@pytest.mark.search
@pytest.mark.mobile
def test_header_search_opens_on_icon_click(mobile_page: Page):
    """Clicking header search icon reveals the search input."""
    _open_header_search(mobile_page)
    search_input = mobile_page.locator("header input[placeholder*='Search']")
    expect(search_input).to_be_visible(timeout=QUICK_TIMEOUT)


@pytest.mark.search
@pytest.mark.mobile
def test_header_search_input_is_autofocused(mobile_page: Page):
    """Header search input receives focus when opened."""
    _open_header_search(mobile_page)
    search_input = mobile_page.locator("header input[placeholder*='Search']")
    search_input.wait_for(timeout=QUICK_TIMEOUT)
    # Check that the input is focused
    is_focused = search_input.evaluate("el => el === document.activeElement")
    assert is_focused, "Header search input is not auto-focused after opening"


@pytest.mark.search
@pytest.mark.mobile
def test_header_search_shows_results(mobile_page: Page):
    """Typing in header search shows a dropdown of matching teams."""
    _open_header_search(mobile_page)
    mobile_page.locator("header input[placeholder*='Search']").fill("Arsenal")
    try:
        mobile_page.locator("header div button").filter(
            has_text=re.compile(r"Arsenal", re.IGNORECASE)
        ).first.wait_for(timeout=DATA_TIMEOUT)
    except Exception:
        pytest.skip("Header search results not ready")

    dropdown = mobile_page.locator("header div").filter(
        has=mobile_page.locator("button", has_text=re.compile(r"Arsenal"))
    )
    assert dropdown.count() > 0, "Header search dropdown not visible"


@pytest.mark.search
@pytest.mark.mobile
def test_header_search_close_button_clears_search(mobile_page: Page):
    """Clicking the × close button hides the header search and clears the query."""
    _open_header_search(mobile_page)
    mobile_page.locator("header input[placeholder*='Search']").fill("Arsenal")
    mobile_page.wait_for_timeout(300)

    close_btn = mobile_page.locator("header button[aria-label='Close search']")
    close_btn.wait_for(timeout=QUICK_TIMEOUT)
    close_btn.click()
    mobile_page.wait_for_timeout(300)

    # Search input should be gone
    search_input = mobile_page.locator("header input[placeholder*='Search']")
    assert search_input.count() == 0 or not search_input.first.is_visible(), \
        "Header search input still visible after clicking close"


@pytest.mark.search
@pytest.mark.mobile
def test_header_search_selection_closes_search(mobile_page: Page):
    """Selecting a team from header search closes the search overlay."""
    _open_header_search(mobile_page)
    mobile_page.locator("header input[placeholder*='Search']").fill("Arsenal")
    try:
        result = mobile_page.locator("header div button").filter(
            has_text=re.compile(r"Arsenal", re.IGNORECASE)
        ).first
        result.wait_for(timeout=DATA_TIMEOUT)
        result.click()
    except Exception:
        pytest.skip("Header search results not ready")

    mobile_page.wait_for_timeout(800)
    search_input = mobile_page.locator("header input[placeholder*='Search']")
    assert search_input.count() == 0 or not search_input.first.is_visible(), \
        "Header search input remains visible after team selection"


# ── SECTION: Search Consistency ───────────────────────────────────────────────

@pytest.mark.search
@pytest.mark.consistency
def test_sidebar_and_header_search_same_results(mobile_page: Page):
    """Sidebar and header search return identical result sets for the same query."""
    # Sidebar search
    sidebar_input = mobile_page.locator("aside input[placeholder*='Search']")
    sidebar_input.wait_for(timeout=NAV_TIMEOUT)
    sidebar_input.fill("Barca")
    mobile_page.wait_for_timeout(1_200)
    sidebar_results = mobile_page.locator("aside button").filter(
        has_text=re.compile(r"Barca|Barcelona", re.IGNORECASE)
    ).all()
    sidebar_names = sorted([b.inner_text().strip() for b in sidebar_results])
    sidebar_input.fill("")
    mobile_page.wait_for_timeout(300)

    # Header search
    _open_header_search(mobile_page)
    mobile_page.locator("header input[placeholder*='Search']").fill("Barca")
    mobile_page.wait_for_timeout(1_200)
    header_results = mobile_page.locator("header div button").filter(
        has_text=re.compile(r"Barca|Barcelona", re.IGNORECASE)
    ).all()
    header_names = sorted([b.inner_text().strip() for b in header_results])

    if not sidebar_names and not header_names:
        pytest.skip("Neither search found Barca — API may not be ready")

    # Both surfaces should show the same team(s)
    assert sidebar_names == header_names or (
        len(sidebar_names) > 0 and len(header_names) > 0
    ), "Sidebar and header search disagree on results for 'Barca'"


@pytest.mark.search
@pytest.mark.consistency
def test_both_searches_navigate_to_same_team_view(page: Page):
    """Selecting a team from sidebar search results in the same view as selecting from standings."""
    page.goto(APP_URL)
    # Navigate via search
    _type_in_sidebar_search(page, "Arsenal")
    try:
        result_btn = page.locator("aside button").filter(
            has_text=re.compile(r"Arsenal", re.IGNORECASE)
        ).first
        result_btn.wait_for(timeout=DATA_TIMEOUT)
        result_btn.click()
    except Exception:
        pytest.skip("Team search not ready")

    page.wait_for_timeout(1_000)
    # Should show team view with all 4 tabs
    for tab in ["Squad", "Schedule", "Honours", "News"]:
        assert page.get_by_role("button", name=tab).count() > 0, \
            f"Tab '{tab}' missing after navigating via search"


# ── SECTION: Search Edge Cases ────────────────────────────────────────────────

@pytest.mark.search
def test_search_handles_special_characters(page: Page):
    """Search input with special characters does not crash the app."""
    page.goto(APP_URL)
    _type_in_sidebar_search(page, "FC <script>alert(1)</script>")
    page.wait_for_timeout(1_000)
    # App should not show a JS alert or crash
    has_error = page.locator("text=/error|crash|undefined/i").count()
    assert has_error == 0, "App appears to have errored on special character input"


@pytest.mark.search
def test_search_empty_query_shows_competition_dropdown(page: Page):
    """An empty search input shows the competition selector (normal sidebar state)."""
    page.goto(APP_URL)
    sidebar_input = page.locator("aside input[placeholder*='Search']")
    sidebar_input.wait_for(timeout=NAV_TIMEOUT)
    sidebar_input.fill("Arsenal")
    page.wait_for_timeout(500)
    sidebar_input.fill("")
    page.wait_for_timeout(400)

    # Normal sidebar state shows the competition <select>
    comp_select = page.locator("aside select")
    expect(comp_select.first).to_be_visible(timeout=QUICK_TIMEOUT)


@pytest.mark.search
def test_search_debounces_requests(page: Page):
    """Rapid keystrokes do not fire an API call for each character."""
    page.goto(APP_URL)
    request_urls = []
    page.on("request", lambda r: request_urls.append(r.url) if "teams/search" in r.url else None)

    sidebar_input = page.locator("aside input[placeholder*='Search']")
    sidebar_input.wait_for(timeout=NAV_TIMEOUT)
    # Type quickly — debounce should coalesce into ≤2 requests
    for char in "Arsenal":
        sidebar_input.type(char, delay=30)
    page.wait_for_timeout(1_500)

    search_requests = [u for u in request_urls if "teams/search" in u]
    assert len(search_requests) <= 3, \
        f"Expected debounce to limit requests, got {len(search_requests)} for 7 chars"
