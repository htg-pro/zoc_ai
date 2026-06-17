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
        
        # -> Open the model picker in the Agent panel by clicking the 'Select model' button so available models are shown.
        # Select model button
        elem = page.get_by_role('button', name='Choose model', exact=True)
        await elem.click(timeout=10000)
        
        # -> Click the 'Settings' button and open the Providers section to add the Groq API key and discover models.
        # Settings button
        elem = page.get_by_role('button', name='Settings', exact=True)
        await elem.click(timeout=10000)
        
        # -> Open the Settings by clicking the 'Settings' button in the left activity bar so the Settings sidebar appears, then navigate to the 'Providers' section.
        # Settings button
        elem = page.get_by_role('button', name='Settings', exact=True)
        await elem.click(timeout=10000)
        
        # -> Paste the provided Groq API key into the Groq 'API key' field, click 'Fetch live models' (Fetch live models button), then click 'Save' on the Groq provider card.
        # sk-… password field
        elem = page.locator('[id="groq-key"]')
        await elem.wait_for(state="visible", timeout=10000)
        await elem.fill("REDACTED_GROQ_KEY_ROTATE_ME")
        
        # -> Paste the provided Groq API key into the Groq 'API key' field, click 'Fetch live models' (Fetch live models button), then click 'Save' on the Groq provider card.
        # Fetch live models button
        elem = page.locator('xpath=/html/body/div/div/div/div/div[3]/div/div/div/div/div/div/div/div/div/div/div/div[3]/div[2]/div[3]/div/button')
        await elem.click(timeout=10000)
        
        # -> Paste the provided Groq API key into the Groq 'API key' field, click 'Fetch live models' (Fetch live models button), then click 'Save' on the Groq provider card.
        # Save button
        elem = page.get_by_text('Groqconfigured', exact=True).locator("xpath=ancestor-or-self::*[.//button][1]").get_by_role('button', name='Save', exact=True)
        await elem.click(timeout=10000)
        
        # -> Open the Agent panel's model picker by clicking the 'Select model' button so the list of available models (including Groq models) is shown.
        # Select model button
        elem = page.get_by_role('button', name='Choose model', exact=True)
        await elem.click(timeout=10000)
        
        # -> click
        # llama-3.3-70b-versatile model · tools menu item
        elem = page.get_by_role('menuitem', name='llama-3.3-70b-versatile model · tools', exact=True)
        await elem.click(timeout=10000)
        
        # --> Assertions to verify final state
        
        # --> Verify the active model label updates
        # Assert: The Agent panel's active model label shows 'llama-3.3-70b-versatile'.
        await expect(page.locator("xpath=/html/body/div[1]/div/div/div/div[5]/div/div/div[1]/div/div[2]/button").nth(0)).to_have_text("llama-3.3-70b-versatile", timeout=15000), "The Agent panel's active model label shows 'llama-3.3-70b-versatile'."
        
        # --> Verify the selected model is shown as active in the Agent panel
        # Assert: The Agent panel displays 'llama-3.3-70b-versatile' as the active model.
        await expect(page.locator("xpath=/html/body/div[1]/div/div/div/div[5]/div/div/div[1]/div/div[2]/button").nth(0)).to_have_text("llama-3.3-70b-versatile", timeout=15000), "The Agent panel displays 'llama-3.3-70b-versatile' as the active model."
        await asyncio.sleep(5)

    finally:
        if context:
            await context.close()
        if browser:
            await browser.close()
        if pw:
            await pw.stop()

asyncio.run(run_test())
    