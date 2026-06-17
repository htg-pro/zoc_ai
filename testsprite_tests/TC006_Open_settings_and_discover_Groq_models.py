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
        
        # -> Click the 'Settings' button in the left activity bar to open the Settings panel so the Providers section can be accessed.
        # Settings button
        elem = page.get_by_role('button', name='Settings', exact=True)
        await elem.click(timeout=10000)
        
        # -> Fill the Groq API key field with the provided Groq key, click 'Save', then click 'Fetch live models' (Discover models) to load available Groq models.
        # sk-… password field
        elem = page.locator('[id="groq-key"]')
        await elem.wait_for(state="visible", timeout=10000)
        await elem.fill("REDACTED_GROQ_KEY_ROTATE_ME")
        
        # -> Fill the Groq API key field with the provided Groq key, click 'Save', then click 'Fetch live models' (Discover models) to load available Groq models.
        # Save button
        elem = page.get_by_text('Groqconfigured', exact=True).locator("xpath=ancestor-or-self::*[.//button][1]").get_by_role('button', name='Save', exact=True)
        await elem.click(timeout=10000)
        
        # -> Fill the Groq API key field with the provided Groq key, click 'Save', then click 'Fetch live models' (Discover models) to load available Groq models.
        # Fetch live models button
        elem = page.locator('xpath=/html/body/div/div/div/div/div[3]/div/div/div/div/div/div/div/div/div/div/div/div[3]/div[2]/div[3]/div/button')
        await elem.click(timeout=10000)
        
        # -> Open the model picker by clicking the 'Select model' button in the Agent panel so the discovered Groq models can be verified in the list and the provider's active status can be checked.
        # Select model button
        elem = page.get_by_role('button', name='Choose model', exact=True)
        await elem.click(timeout=10000)
        
        # -> Select the 'llama-3.3-70b-versatile' model from the Agent model picker to activate the Groq provider and confirm the provider/model is shown as active in the Agent header.
        # llama-3.3-70b-versatile model · tools menu item
        elem = page.get_by_role('menuitem', name='llama-3.3-70b-versatile model · tools', exact=True)
        await elem.click(timeout=10000)
        
        # --> Assertions to verify final state
        
        # --> Verify discovered models are displayed
        # Assert: Discovered Groq models are listed in the Models input.
        await expect(page.locator("xpath=/html/body/div[1]/div/div/div/div[3]/div/div/div[1]/div/div/div/div/div/div/div/div/div[3]/div[2]/div[3]/input").nth(0)).to_have_value("allam-2-7b, canopylabs/orpheus-arabic-saudi, canopylabs/orpheus-v1-english, groq/compound, groq/compound-mini, llama-3.1-8b-instant, llama-3.3-70b-versatile, meta-llama/llama-4-scout-17b-16e-instruct, meta-llama/llama-prompt-guard-2-22m, meta-llama/llama-prompt-guard-2-86m, openai/gpt-oss-120b, openai/gpt-oss-20b, openai/gpt-oss-safeguard-20b, qwen/qwen3-32b, whisper-large-v3, whisper-large-v3-turbo", timeout=15000), "Discovered Groq models are listed in the Models input."
        
        # --> Verify the provider is shown as active
        # Assert: Agent header shows 'llama-3.3-70b-versatile' as the active model.
        await expect(page.locator("xpath=/html/body/div[1]/div/div/div/div[5]/div/div/div[1]/div/div[2]/button").nth(0)).to_have_text("llama-3.3-70b-versatile", timeout=15000), "Agent header shows 'llama-3.3-70b-versatile' as the active model."
        await asyncio.sleep(5)

    finally:
        if context:
            await context.close()
        if browser:
            await browser.close()
        if pw:
            await pw.stop()

asyncio.run(run_test())
    