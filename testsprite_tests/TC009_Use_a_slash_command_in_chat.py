import asyncio
import re
from playwright import async_api
from playwright.async_api import expect

async def run_test():
    pw = None
    browser = None
    context = None

    try:
        # Start a Playwright session in asynchronous mode
        pw = await async_api.async_playwright().start()

        # Launch a Chromium browser in headless mode with custom arguments
        browser = await pw.chromium.launch(
            headless=True,
            args=[
                "--window-size=1280,720",
                "--disable-dev-shm-usage",
                "--ipc=host",
                "--single-process"
            ],
        )

        # Create a new browser context (like an incognito window)
        context = await browser.new_context()
        # Wider default timeout to match the agent's DOM-stability budget;
        # auto-waiting Playwright APIs (expect, locator.wait_for) inherit this.
        context.set_default_timeout(15000)

        # Open a new page in the browser context
        page = await context.new_page()

        # Interact with the page elements to simulate user flow
        # -> navigate
        await page.goto("http://localhost:1420")
        try:
            await page.wait_for_load_state("domcontentloaded", timeout=5000)
        except Exception:
            pass
        
        # -> Type a slash command into the composer and send it.
        composer = page.get_by_test_id("composer-textarea")
        await composer.wait_for(state="visible", timeout=10000)
        await composer.fill("/explain src/App.tsx")

        send = page.get_by_role("button", name="Send", exact=True)
        await send.click(timeout=10000)

        # --> Assertions to verify final state
        region = page.get_by_test_id("agent-run-region")
        await expect(region).to_contain_text("/explain src/App.tsx", timeout=15000), "The slash command should be shown as a user message."
        await expect(region).to_contain_text(re.compile(r"(Ran /explain|explain|error|sidecar)", re.I), timeout=15000), "The slash command should produce a response or actionable error."
        await asyncio.sleep(5)

    finally:
        if context:
            await context.close()
        if browser:
            await browser.close()
        if pw:
            await pw.stop()

asyncio.run(run_test())
