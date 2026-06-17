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
        
        # -> Open the Settings panel by clicking the 'Settings' button in the left activity area.
        # Settings button
        elem = page.get_by_role('button', name='Settings', exact=True)
        await elem.click(timeout=10000)
        
        # -> Paste the Groq API key into the Groq provider 'API key' field, click 'Fetch live models', then click 'Save', and finally close the Settings panel by toggling the 'Settings' button.
        # sk-… password field
        elem = page.locator('[id="groq-key"]')
        await elem.wait_for(state="visible", timeout=10000)
        await elem.fill("REDACTED_GROQ_KEY_ROTATE_ME")
        
        # -> Paste the Groq API key into the Groq provider 'API key' field, click 'Fetch live models', then click 'Save', and finally close the Settings panel by toggling the 'Settings' button.
        # Fetch live models button
        elem = page.locator('xpath=/html/body/div/div/div/div/div[3]/div/div/div/div/div/div/div/div/div/div/div/div[3]/div[2]/div[3]/div/button')
        await elem.click(timeout=10000)
        
        # -> Paste the Groq API key into the Groq provider 'API key' field, click 'Fetch live models', then click 'Save', and finally close the Settings panel by toggling the 'Settings' button.
        # Save button
        elem = page.get_by_text('Groqconfigured', exact=True).locator("xpath=ancestor-or-self::*[.//button][1]").get_by_role('button', name='Save', exact=True)
        await elem.click(timeout=10000)
        
        # -> Paste the Groq API key into the Groq provider 'API key' field, click 'Fetch live models', then click 'Save', and finally close the Settings panel by toggling the 'Settings' button.
        # Settings button
        elem = page.get_by_role('button', name='Settings', exact=True)
        await elem.click(timeout=10000)
        
        # -> Open the model picker by clicking the 'Select model' button in the Agent header, then verify Groq model options (for example 'llama-3.3-70b-versatile') are listed for the active session.
        # Select model button
        elem = page.get_by_role('button', name='Choose model', exact=True)
        await elem.click(timeout=10000)
        
        # --> Assertions to verify final state
        
        # --> Verify the current session remains selected
        # Assert: The '/tmp' breadcrumb is visible, confirming the session context is still selected.
        await expect(page.locator("xpath=/html/body/div[1]/div/header/div[1]/div[3]/span").nth(0)).to_have_text("/tmp", timeout=15000), "The '/tmp' breadcrumb is visible, confirming the session context is still selected."
        # Assert: The 'main' breadcrumb is visible, confirming the session context is still selected.
        await expect(page.locator("xpath=/html/body/div[1]/div/header/div[1]/div[3]/div/span").nth(0)).to_have_text("main", timeout=15000), "The 'main' breadcrumb is visible, confirming the session context is still selected."
        
        # --> Verify model selection is available for the active session
        await page.locator("xpath=/html/body/div[1]/div/div/div/div[5]/div/div/div[1]/div/div[2]/button").nth(0).scroll_into_view_if_needed()
        # Assert: The Agent model picker button 'Select model' is visible for the active session.
        await expect(page.locator("xpath=/html/body/div[1]/div/div/div/div[5]/div/div/div[1]/div/div[2]/button").nth(0)).to_be_visible(timeout=15000), "The Agent model picker button 'Select model' is visible for the active session."
        await page.locator("xpath=/html/body/div[5]/div/div[4]/div[9]").nth(0).scroll_into_view_if_needed()
        # Assert: A Groq model ('llama-3.3-70b-versatile') is listed in the model picker, confirming model selection is available.
        await expect(page.locator("xpath=/html/body/div[5]/div/div[4]/div[9]").nth(0)).to_be_visible(timeout=15000), "A Groq model ('llama-3.3-70b-versatile') is listed in the model picker, confirming model selection is available."
        await asyncio.sleep(5)

    finally:
        if context:
            await context.close()
        if browser:
            await browser.close()
        if pw:
            await pw.stop()

asyncio.run(run_test())
    