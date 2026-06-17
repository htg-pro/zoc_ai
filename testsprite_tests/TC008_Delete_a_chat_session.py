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
        
        # -> Click the 'Sessions' button in the left sidebar to open the Sessions panel and reveal the list of sessions.
        # Sessions button
        elem = page.get_by_role('button', name='Sessions', exact=True)
        await elem.click(timeout=10000)
        
        # -> Click the 'Delete session' button for the 'groq smoke' session and, if a confirmation dialog appears, confirm the deletion.
        # Delete groq smoke button
        elem = page.get_by_role('button', name='Delete groq smoke', exact=True)
        await elem.click(timeout=10000)
        
        # --> Assertions to verify final state
        
        # --> Verify the session is removed from the list
        await page.locator("xpath=/html/body/div[1]/div/div/div/div[1]/div/aside/div/div/div[3]/div/div/div/div[2]/button").nth(0).scroll_into_view_if_needed()
        # Assert: The 'Test Session' entry is visible in the sessions list.
        await expect(page.locator("xpath=/html/body/div[1]/div/div/div/div[1]/div/aside/div/div/div[3]/div/div/div/div[2]/button").nth(0)).to_be_visible(timeout=15000), "The 'Test Session' entry is visible in the sessions list."
        await page.locator("xpath=/html/body/div[1]/div/div/div/div[1]/div/aside/div/div/div[3]/div/div/div/div[3]/button").nth(0).scroll_into_view_if_needed()
        # Assert: The 'Agent Session' entry is visible in the sessions list.
        await expect(page.locator("xpath=/html/body/div[1]/div/div/div/div[1]/div/aside/div/div/div[3]/div/div/div/div[3]/button").nth(0)).to_be_visible(timeout=15000), "The 'Agent Session' entry is visible in the sessions list."
        # Assert: The sessions count badge indicates there are 2 sessions.
        await expect(page.locator("xpath=/html/body/div[1]/div/div/div/div[1]/div/aside/div/div/div[1]/div/span[2]").nth(0)).to_have_text("2", timeout=15000), "The sessions count badge indicates there are 2 sessions."
        await asyncio.sleep(5)

    finally:
        if context:
            await context.close()
        if browser:
            await browser.close()
        if pw:
            await pw.stop()

asyncio.run(run_test())
    