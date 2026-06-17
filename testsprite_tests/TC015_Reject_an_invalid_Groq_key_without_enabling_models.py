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
        
        # -> Click the 'Settings' button in the left activity bar to open the Settings panel.
        # Settings button
        elem = page.get_by_role('button', name='Settings', exact=True)
        await elem.click(timeout=10000)
        
        # -> Click the 'Providers' tab in the Settings sidebar to ensure the Providers section is active and focused.
        # Providers button
        elem = page.get_by_role('button', name='Providers', exact=True)
        await elem.click(timeout=10000)
        
        # -> Enter the provided Groq API key into the Groq 'API key' field visible in Settings → Providers and click the 'Fetch live models' button.
        # sk-… password field
        elem = page.locator('[id="groq-key"]')
        await elem.wait_for(state="visible", timeout=10000)
        await elem.fill("REDACTED_GROQ_KEY_ROTATE_ME")
        
        # -> Enter the provided Groq API key into the Groq 'API key' field visible in Settings → Providers and click the 'Fetch live models' button.
        # Fetch live models button
        elem = page.locator('xpath=/html/body/div/div/div/div/div[3]/div/div/div/div/div/div/div/div/div/div/div/div[3]/div[2]/div[3]/div/button')
        await elem.click(timeout=10000)
        
        # --> Assertions to verify final state
        
        # --> Verify no usable model list update is shown
        # Assert: Expected the Groq 'Models' input to be empty (no usable model list update shown).
        await expect(page.locator("xpath=/html/body/div[1]/div/div/div/div[3]/div/div/div[1]/div/div/div/div[1]/div/div/div/div/div[3]/div[2]/div[3]/input").nth(0)).to_have_value("", timeout=15000), "Expected the Groq 'Models' input to be empty (no usable model list update shown)."
        # Assert: Expected the Groq 'Models' input to not be visible, indicating no usable model list was displayed.
        await expect(page.locator("xpath=/html/body/div[1]/div/div/div/div[3]/div/div/div[1]/div/div/div/div[1]/div/div/div/div/div[3]/div[2]/div[3]/input").nth(0)).not_to_be_visible(timeout=15000), "Expected the Groq 'Models' input to not be visible, indicating no usable model list was displayed."
        
        # --> Verify a validation or warning state is visible
        # Assert: Expected the notifications area to contain 'agent sidecar not reachable'.
        await expect(page.locator("xpath=/html/body/div[1]/div/section").nth(0)).to_contain_text("agent sidecar not reachable", timeout=15000), "Expected the notifications area to contain 'agent sidecar not reachable'."
        # Assert: Expected the notifications area to contain 'Mock response'.
        await expect(page.locator("xpath=/html/body/div[1]/div/section").nth(0)).to_contain_text("Mock response", timeout=15000), "Expected the notifications area to contain 'Mock response'."
        # Assert: Expected the Groq provider Models field to show an 'Invalid API key' warning.
        await expect(page.locator("xpath=/html/body/div[1]/div/div/div/div[3]/div/div/div[1]/div/div/div/div[1]/div/div/div/div/div[3]/div[2]/div[3]/input/div[2]").nth(0)).to_contain_text("Invalid API key", timeout=15000), "Expected the Groq provider Models field to show an 'Invalid API key' warning."
        await asyncio.sleep(5)

    finally:
        if context:
            await context.close()
        if browser:
            await browser.close()
        if pw:
            await pw.stop()

asyncio.run(run_test())
    