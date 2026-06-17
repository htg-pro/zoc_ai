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
        
        # -> Open the 'Sessions' panel by clicking the 'Sessions' button in the left activity bar (visible as 'Sessions' in the activity bar).
        # Sessions button
        elem = page.get_by_role('button', name='Sessions', exact=True)
        await elem.click(timeout=10000)
        
        # -> Click the 'New session' button in the Sessions panel to create a new session.
        # New session button
        elem = page.get_by_text('Filter sessions…', exact=True).locator("xpath=ancestor-or-self::*[.//button][1]").get_by_role('button', name='New session', exact=True)
        await elem.click(timeout=10000)
        
        # --> Assertions to verify final state
        
        # --> Verify a new session is displayed as the active session
        await page.locator("xpath=/html/body/div[1]/div/div/div/div[1]/div/aside/div/div/div[3]/div/div/div/div[2]/button").nth(0).scroll_into_view_if_needed()
        # Assert: The newly created session 'Session 3:10:16 PM — 3:10 PM' is visible in the sessions list.
        await expect(page.locator("xpath=/html/body/div[1]/div/div/div/div[1]/div/aside/div/div/div[3]/div/div/div/div[2]/button").nth(0)).to_be_visible(timeout=15000), "The newly created session 'Session 3:10:16 PM \u2014 3:10 PM' is visible in the sessions list."
        await page.locator("xpath=/html/body/div[1]/div/div/div/div[3]/div/div/div[1]/div/div/div/div/div/div[4]/div[2]/div[1]/div[2]/span[1]").nth(0).scroll_into_view_if_needed()
        # Assert: An 'active' label is visible for the session, indicating it is the active session.
        await expect(page.locator("xpath=/html/body/div[1]/div/div/div/div[3]/div/div/div[1]/div/div/div/div/div/div[4]/div[2]/div[1]/div[2]/span[1]").nth(0)).to_be_visible(timeout=15000), "An 'active' label is visible for the session, indicating it is the active session."
        await asyncio.sleep(5)

    finally:
        if context:
            await context.close()
        if browser:
            await browser.close()
        if pw:
            await pw.stop()

asyncio.run(run_test())
    