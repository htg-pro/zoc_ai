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
        
        # -> Click the workspace path labeled '/tmp' in the top bar to confirm or choose the workspace folder as part of onboarding.
        # /tmp
        elem = page.get_by_text('/tmp', exact=True)
        await elem.click(timeout=10000)
        
        # --> Assertions to verify final state
        
        # --> Verify the main application shell is displayed
        await page.locator("xpath=/html/body/div[1]/div/header/div[1]/div[3]/span").nth(0).scroll_into_view_if_needed()
        # Assert: The workspace path '/tmp' is visible in the header, indicating the shell is loaded.
        await expect(page.locator("xpath=/html/body/div[1]/div/header/div[1]/div[3]/span").nth(0)).to_be_visible(timeout=15000), "The workspace path '/tmp' is visible in the header, indicating the shell is loaded."
        await page.locator("xpath=/html/body/div[1]/div/div/div/div[1]/div/aside/div[2]/div/div/div/div/div/button[1]").nth(0).scroll_into_view_if_needed()
        # Assert: The Explorer root 'zoc-studio' is visible in the sidebar, showing the project tree is present.
        await expect(page.locator("xpath=/html/body/div[1]/div/div/div/div[1]/div/aside/div[2]/div/div/div/div/div/button[1]").nth(0)).to_be_visible(timeout=15000), "The Explorer root 'zoc-studio' is visible in the sidebar, showing the project tree is present."
        await page.locator("xpath=/html/body/div[1]/div/div/div/div[3]/div/div/div[1]/div/div/div[1]/div/div[1]/button[1]").nth(0).scroll_into_view_if_needed()
        # Assert: The editor tab 'App.tsx' is visible, confirming the main editor pane is open.
        await expect(page.locator("xpath=/html/body/div[1]/div/div/div/div[3]/div/div/div[1]/div/div/div[1]/div/div[1]/button[1]").nth(0)).to_be_visible(timeout=15000), "The editor tab 'App.tsx' is visible, confirming the main editor pane is open."
        await page.locator("xpath=/html/body/div[1]/div/div/div/div[5]/div/div/div[1]/div/div[1]").nth(0).scroll_into_view_if_needed()
        # Assert: The Agent panel header 'Agent Auto run' is visible, indicating the agent area is displayed.
        await expect(page.locator("xpath=/html/body/div[1]/div/div/div/div[5]/div/div/div[1]/div/div[1]").nth(0)).to_be_visible(timeout=15000), "The Agent panel header 'Agent Auto run' is visible, indicating the agent area is displayed."
        await asyncio.sleep(5)

    finally:
        if context:
            await context.close()
        if browser:
            await browser.close()
        if pw:
            await pw.stop()

asyncio.run(run_test())
    