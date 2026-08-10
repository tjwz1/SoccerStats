"""
Tests for the accounts / auth UI.

Sections
--------
SECTION: Sign-in Button   — visible when unauthenticated, absent when signed in
SECTION: Auth Modal       — opens, has email input, consent notice, closes
SECTION: Avatar           — not present when signed out

Note: actual magic-link sign-in flow requires a real email and cannot be
automated here. These tests cover only the unauthenticated UI surface.
"""
import pytest
from playwright.sync_api import Page, expect

from conftest import APP_URL, NAV_TIMEOUT, QUICK_TIMEOUT


# ── SECTION: Sign-in Button ───────────────────────────────────────────────────

@pytest.mark.auth
def test_sign_in_button_visible_when_anonymous(page: Page):
    """'Sign in' button is visible in the header for anonymous (unauthenticated) users."""
    page.goto(APP_URL)
    sign_in = page.locator("header").get_by_role("button", name="Sign in")
    sign_in.wait_for(timeout=NAV_TIMEOUT)
    expect(sign_in).to_be_visible()


@pytest.mark.auth
def test_no_avatar_when_signed_out(page: Page):
    """No user-avatar circle button is visible when the user is not signed in."""
    page.goto(APP_URL)
    page.wait_for_timeout(1_000)  # allow auth session check to settle
    # Avatar buttons have a single uppercase letter as their text and a rounded-full class
    avatar = page.locator("header button[class*='rounded-full'][class*='bg-green-7']")
    assert avatar.count() == 0, "Avatar button shown for an unauthenticated user"


# ── SECTION: Auth Modal ───────────────────────────────────────────────────────

@pytest.mark.auth
def test_sign_in_opens_auth_modal(page: Page):
    """Clicking 'Sign in' opens the auth modal dialog."""
    page.goto(APP_URL)
    page.locator("header").get_by_role("button", name="Sign in").wait_for(timeout=NAV_TIMEOUT)
    page.locator("header").get_by_role("button", name="Sign in").click()
    # Modal overlay and heading should appear
    expect(page.get_by_role("heading", name="Sign in")).to_be_visible(timeout=QUICK_TIMEOUT)


@pytest.mark.auth
def test_auth_modal_has_email_input(page: Page):
    """Auth modal contains an email input field."""
    page.goto(APP_URL)
    page.locator("header").get_by_role("button", name="Sign in").wait_for(timeout=NAV_TIMEOUT)
    page.locator("header").get_by_role("button", name="Sign in").click()
    email_input = page.locator("input[type='email']")
    email_input.wait_for(timeout=QUICK_TIMEOUT)
    expect(email_input).to_be_visible()


@pytest.mark.auth
def test_auth_modal_has_send_button(page: Page):
    """Auth modal has a 'Send magic link' submit button."""
    page.goto(APP_URL)
    page.locator("header").get_by_role("button", name="Sign in").wait_for(timeout=NAV_TIMEOUT)
    page.locator("header").get_by_role("button", name="Sign in").click()
    send_btn = page.get_by_role("button", name="Send magic link")
    expect(send_btn).to_be_visible(timeout=QUICK_TIMEOUT)


@pytest.mark.auth
def test_auth_modal_has_consent_notice(page: Page):
    """Auth modal displays a data-use consent notice mentioning email storage."""
    page.goto(APP_URL)
    page.locator("header").get_by_role("button", name="Sign in").wait_for(timeout=NAV_TIMEOUT)
    page.locator("header").get_by_role("button", name="Sign in").click()
    # Consent text contains 'store your email'
    consent = page.get_by_text("store your email", exact=False)
    consent.wait_for(timeout=QUICK_TIMEOUT)
    expect(consent).to_be_visible()


@pytest.mark.auth
def test_auth_modal_closes_on_x_button(page: Page):
    """Clicking the X button closes the auth modal."""
    page.goto(APP_URL)
    page.locator("header").get_by_role("button", name="Sign in").wait_for(timeout=NAV_TIMEOUT)
    page.locator("header").get_by_role("button", name="Sign in").click()
    page.get_by_role("heading", name="Sign in").wait_for(timeout=QUICK_TIMEOUT)

    page.get_by_role("button", name="Close").click()
    page.wait_for_timeout(300)
    assert page.get_by_role("heading", name="Sign in").count() == 0, \
        "Auth modal still visible after clicking X"


@pytest.mark.auth
def test_auth_modal_closes_on_backdrop_click(page: Page):
    """Clicking the dark backdrop behind the modal closes it."""
    page.goto(APP_URL)
    page.locator("header").get_by_role("button", name="Sign in").wait_for(timeout=NAV_TIMEOUT)
    page.locator("header").get_by_role("button", name="Sign in").click()
    page.get_by_role("heading", name="Sign in").wait_for(timeout=QUICK_TIMEOUT)

    # Click the fixed overlay div (outside the modal card)
    page.locator("div.fixed.inset-0").first.click(position={"x": 10, "y": 10})
    page.wait_for_timeout(300)
    assert page.get_by_role("heading", name="Sign in").count() == 0, \
        "Auth modal still visible after clicking backdrop"
