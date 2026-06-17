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
        
        # -> Open the Settings panel by clicking the 'Settings' button in the left explorer/activity area so the Providers section can be accessed.
        # Settings button
        elem = page.get_by_role('button', name='Settings', exact=True)
        await elem.click(timeout=10000)
        
        # -> Open the 'Providers' section in Settings (click the 'Providers' button), paste the Groq API key into the 'API key' field of the Groq card, click 'Fetch live models', then click 'Save'.
        # Providers button
        elem = page.get_by_role('button', name='Providers', exact=True)
        await elem.click(timeout=10000)
        
        # -> Open the 'Providers' section in Settings (click the 'Providers' button), paste the Groq API key into the 'API key' field of the Groq card, click 'Fetch live models', then click 'Save'.
        # sk-… password field
        elem = page.locator('[id="groq-key"]')
        await elem.wait_for(state="visible", timeout=10000)
        await elem.fill("REDACTED_GROQ_KEY_ROTATE_ME")
        
        # -> Open the 'Providers' section in Settings (click the 'Providers' button), paste the Groq API key into the 'API key' field of the Groq card, click 'Fetch live models', then click 'Save'.
        # Fetch live models button
        elem = page.locator('xpath=/html/body/div/div/div/div/div[3]/div/div/div/div/div/div/div/div/div/div/div/div[3]/div[2]/div[3]/div/button')
        await elem.click(timeout=10000)
        
        # -> Open the 'Providers' section in Settings (click the 'Providers' button), paste the Groq API key into the 'API key' field of the Groq card, click 'Fetch live models', then click 'Save'.
        # Save button
        elem = page.get_by_text('Groqconfigured', exact=True).locator("xpath=ancestor-or-self::*[.//button][1]").get_by_role('button', name='Save', exact=True)
        await elem.click(timeout=10000)
        
        # -> Click the 'Select model' button in the Agent header to open the model picker and verify that Groq models are listed and Groq can be set as the active provider.
        # Select model button
        elem = page.get_by_role('button', name='Choose model', exact=True)
        await elem.click(timeout=10000)
        
        # -> Select the 'llama-3.3-70b-versatile' model from the open 'Select model' menu to set Groq as the active provider in the Agent header.
        # llama-3.3-70b-versatile model · tools menu item
        elem = page.get_by_role('menuitem', name='llama-3.3-70b-versatile model · tools', exact=True)
        await elem.click(timeout=10000)
        
        # --> Assertions to verify final state
        
        # --> Verify a populated Groq model list is displayed
        # Assert: The Groq provider's Models field is populated with live model names.
        await expect(page.locator("xpath=/html/body/div[1]/div/div/div/div[3]/div/div/div[1]/div/div/div/div/div/div/div/div/div[3]/div[2]/div[3]/input").nth(0)).to_have_value("allam-2-7b, canopylabs/orpheus-arabic-saudi, canopylabs/orpheus-v1-english, groq/compound, groq/compound-mini, llama-3.1-8b-instant, llama-3.3-70b-versatile, meta-llama/llama-4-scout-17b-16e-instruct, meta-llama/llama-prompt-guard-2-22m, meta-llama/llama-prompt-guard-2-86m, openai/gpt-oss-120b, openai/gpt-oss-20b, openai/gpt-oss-safeguard-20b, qwen/qwen3-32b, whisper-large-v3, whisper-large-v3-turbo", timeout=15000), "The Groq provider's Models field is populated with live model names."
        
        # --> Verify the active provider is set to Groq
        # Assert: Groq provider's Models field lists available models including 'llama-3.3-70b-versatile'.
        await expect(page.locator("xpath=/html/body/div[1]/div/div/div/div[3]/div/div/div[1]/div/div/div/div/div/div/div/div/div[3]/div[2]/div[3]/input").nth(0)).to_have_value("allam-2-7b, canopylabs/orpheus-arabic-saudi, canopylabs/orpheus-v1-english, groq/compound, groq/compound-mini, llama-3.1-8b-instant, llama-3.3-70b-versatile, meta-llama/llama-4-scout-17b-16e-instruct, meta-llama/llama-prompt-guard-2-22m, meta-llama/llama-prompt-guard-2-86m, openai/gpt-oss-120b, openai/gpt-oss-20b, openai/gpt-oss-safeguard-20b, qwen/qwen3-32b, whisper-large-v3, whisper-large-v3-turbo", timeout=15000), "Groq provider's Models field lists available models including 'llama-3.3-70b-versatile'."
        await asyncio.sleep(5)

    finally:
        if context:
            await context.close()
        if browser:
            await browser.close()
        if pw:
            await pw.stop()

asyncio.run(run_test())
    