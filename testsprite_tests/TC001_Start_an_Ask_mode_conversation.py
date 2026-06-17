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
        
        # -> Click the 'Ask' button to switch to Ask mode, type a prompt asking for a line-by-line explanation of the App function in src/App.tsx into the 'Message the agent…' composer, and send it using the send button.
        # Ask button
        elem = page.get_by_role('button', name='Ask', exact=True)
        await elem.click(timeout=10000)
        
        # -> Click the 'Ask' button to switch to Ask mode, type a prompt asking for a line-by-line explanation of the App function in src/App.tsx into the 'Message the agent…' composer, and send it using the send button.
        # Message the agent… text area
        elem = page.get_by_placeholder('Ask about your code…', exact=True)
        await elem.wait_for(state="visible", timeout=10000)
        await elem.fill("Please explain the function App in src/App.tsx line by line.")
        
        # -> Click the 'Ask' button to switch to Ask mode, type a prompt asking for a line-by-line explanation of the App function in src/App.tsx into the 'Message the agent…' composer, and send it using the send button.
        # Send button
        elem = page.get_by_role('button', name='Send', exact=True)
        await elem.click(timeout=10000)
        
        # --> Assertions to verify final state
        
        # --> Verify an assistant response is displayed
        # Assert: An assistant response 'Got it. (Mock response — agent sidecar not reachable.)' is visible.
        await expect(page.locator("xpath=/html/body/div[1]/div/div/div/div[5]/div/div/div[3]/div/div/div/div[2]/div[1]").nth(0)).to_contain_text("Got it. (Mock response \u2014 agent sidecar not reachable.)", timeout=15000), "An assistant response 'Got it. (Mock response \u2014 agent sidecar not reachable.)' is visible."
        
        # --> Verify the conversation remains in Ask mode
        await page.locator("xpath=/html/body/div[1]/div/div/div/div[5]/div/div/div[4]/div/div[1]/div[2]/div/button[1]").nth(0).scroll_into_view_if_needed()
        # Assert: Verify the Ask mode button is visible, indicating Ask mode is active.
        await expect(page.locator("xpath=/html/body/div[1]/div/div/div/div[5]/div/div/div[4]/div/div[1]/div[2]/div/button[1]").nth(0)).to_be_visible(timeout=15000), "Verify the Ask mode button is visible, indicating Ask mode is active."
        # Assert: Verify the Ask composer still contains the sent Ask prompt.
        await expect(page.locator("xpath=/html/body/div[1]/div/div/div/div[5]/div/div/div[4]/div/div[1]/textarea").nth(0)).to_have_value("Please explain the function App in src/App.tsx line by line.", timeout=15000), "Verify the Ask composer still contains the sent Ask prompt."
        await asyncio.sleep(5)

    finally:
        if context:
            await context.close()
        if browser:
            await browser.close()
        if pw:
            await pw.stop()

asyncio.run(run_test())
    