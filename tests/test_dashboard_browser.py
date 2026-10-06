"""The dashboard in a real (headless) browser: no script errors, everything renders, notes survive refreshes.

Needs `pip install playwright && playwright install chromium`; skipped otherwise.
"""

import threading
import time

import pytest
import uvicorn

from conftest import say
from motes.server import create_app

sync_api = pytest.importorskip("playwright.sync_api")


@pytest.fixture
def dashboard(make_rt):
    rt = make_rt([say("done")])
    goal = rt.store.add_goal("Weekly report", "Email the weekly report", "tide", "manual")
    run = rt.store.add_run(goal["id"])
    rt.store.update_run(run["id"], status="waiting_approval")
    rt.store.add_approval(run["id"], "c1", "send_email", {"to": "team@example.com"}, "external", "Sends email as you.")
    rt.store.log(run["id"], "notify", title="Hello", message="Motes is ready")
    server = uvicorn.Server(uvicorn.Config(create_app(rt), port=8766, log_level="error"))
    threading.Thread(target=server.run, daemon=True).start()
    while not server.started:
        time.sleep(0.05)
    yield "http://127.0.0.1:8766/"
    server.should_exit = True


def test_dashboard_renders_without_errors(dashboard):
    with sync_api.sync_playwright() as pw:
        try:
            browser = pw.chromium.launch()
        except Exception as exc:  # browser binaries not installed
            pytest.skip(f"no browser: {exc}")
        page = browser.new_page()
        errors = []
        page.on("pageerror", lambda e: errors.append(str(e)))
        page.goto(dashboard)
        page.wait_for_selector("[data-note]")
        assert page.locator("button.mote").count() == 8
        assert "Motes is ready" in page.text_content("#messages")
        assert page.text_content("#badge") == "1"

        page.click("[data-note]")
        page.keyboard.type("only the team list")
        page.wait_for_timeout(6500)  # two auto-refreshes
        assert page.input_value("[data-note]") == "only the team list"
        assert page.evaluate("document.activeElement.matches('[data-note]')")

        page.keyboard.press("Shift+Tab")
        page.focus("#t-approvals")
        page.keyboard.press("ArrowRight")
        assert page.get_attribute("#t-activity", "aria-selected") == "true"
        assert errors == []
        browser.close()
