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
        
        # -> Open the 'Settings' panel by clicking the 'Settings' button in the left activity bar.
        # Settings button
        elem = page.get_by_role('button', name='Settings', exact=True)
        await elem.click(timeout=10000)
        
        # -> Click the 'Models' tab in the Settings panel to open model configuration and look for local or llama.cpp model options.
        # Models button
        elem = page.get_by_role('button', name='Models', exact=True)
        await elem.click(timeout=10000)
        
        # -> click
        # Add model button
        elem = page.get_by_role('button', name='Add model', exact=True)
        await elem.click(timeout=10000)
        
        # -> Click the 'Add model' button in the Models settings to start registering a local .gguf (llama.cpp) model.
        # Add model button
        elem = page.get_by_role('button', name='Add model', exact=True)
        await elem.click(timeout=10000)
        
        # -> Fill the '.gguf file path' with a local path, set a display name, and click the 'Add model' button to attempt registering the local llama.cpp model.
        # /models/Qwen2.5-Coder-32B-Q4_K_M.gguf text field
        elem = page.locator('[id="gguf-path"]')
        await elem.wait_for(state="visible", timeout=10000)
        await elem.fill("/tmp/test-model.gguf")
        
        # -> Fill the '.gguf file path' with a local path, set a display name, and click the 'Add model' button to attempt registering the local llama.cpp model.
        # Auto-filled from filename text field
        elem = page.locator('[id="gguf-name"]')
        await elem.wait_for(state="visible", timeout=10000)
        await elem.fill("local-llama-test")
        
        # -> Fill the '.gguf file path' with a local path, set a display name, and click the 'Add model' button to attempt registering the local llama.cpp model.
        # Add model button
        elem = page.get_by_role('button', name='Add model', exact=True)
        await elem.click(timeout=10000)
        
        # -> Open the agent's model picker by clicking the 'Select model' button in the Agent header so the saved 'local-llama-test' option can be chosen.
        # Select model button
        elem = page.get_by_role('button', name='Choose model', exact=True)
        await elem.click(timeout=10000)
        
        # -> Click the 'local-llama-test' entry in the model picker menu to select the local llama.cpp model and make it active.
        # local-llama-test /tmp/test-model.gguf menu item
        elem = page.get_by_role('menuitem', name='local-llama-test /tmp/test-model.gguf', exact=True)
        await elem.click(timeout=10000)
        
        # -> Open the model picker by clicking the 'Choose model' combobox in the Agent header and confirm that 'local-llama-test' is shown as the active model and any status indicator or label is visible.
        # local-llama-test button
        elem = page.get_by_role('button', name='Choose model', exact=True)
        await elem.click(timeout=10000)
        
        # -> Verify the model status label 'llama.cpp (local)' is visible in the model picker or header, then close the Settings panel by clicking the 'Settings' button to return to the main UI.
        # Settings button
        elem = page.get_by_role('button', name='Settings', exact=True)
        await elem.click(timeout=10000)
        
        # -> click
        # Settings button
        elem = page.get_by_role('button', name='Settings', exact=True)
        await elem.click(timeout=10000)
        
        # -> Open the model chooser by clicking the 'Choose model' button in the Agent header and confirm whether the status label 'llama.cpp (local)' is shown (and ensure the Agent chat area still shows 'Agent ready').
        # local-llama-test button
        elem = page.get_by_role('button', name='Choose model', exact=True)
        await elem.click(timeout=10000)
        
        # --> Assertions to verify final state
        
        # --> Verify the selected model status is displayed
        # Assert: Verify the model status label 'llama.cpp (local)' is visible in the model picker menu.
        await expect(page.locator("xpath=/html/body/div[5]/div").nth(0)).to_contain_text("llama.cpp (local)", timeout=15000), "Verify the model status label 'llama.cpp (local)' is visible in the model picker menu."
        # Assert: Verify the agent header shows the selected model 'local-llama-test'.
        await expect(page.locator("xpath=/html/body/div[1]/div/div/div/div[5]/div/div/div[1]/div/div[2]/button").nth(0)).to_have_text("local-llama-test", timeout=15000), "Verify the agent header shows the selected model 'local-llama-test'."
        
        # --> Verify the active session conversation remains available
        await page.locator("xpath=/html/body/div[1]/div/div/div/div[5]/div/div/div[1]/div/div[1]").nth(0).scroll_into_view_if_needed()
        # Assert: The Agent header (chat area) is visible, indicating the conversation UI is present.
        await expect(page.locator("xpath=/html/body/div[1]/div/div/div/div[5]/div/div/div[1]/div/div[1]").nth(0)).to_be_visible(timeout=15000), "The Agent header (chat area) is visible, indicating the conversation UI is present."
        await page.locator("xpath=/html/body/div[1]/div/div/div/div[5]/div/div/div[4]/div/div[1]/div[2]/button[3]").nth(0).scroll_into_view_if_needed()
        # Assert: The Send button in the agent conversation is visible, confirming the active session composer is available.
        await expect(page.locator("xpath=/html/body/div[1]/div/div/div/div[5]/div/div/div[4]/div/div[1]/div[2]/button[3]").nth(0)).to_be_visible(timeout=15000), "The Send button in the agent conversation is visible, confirming the active session composer is available."
        await page.locator("xpath=/html/body/div[1]/div/div/div/div[5]/div/div/div[1]/div/div[2]/button").nth(0).scroll_into_view_if_needed()
        # Assert: The model chooser button showing 'local-llama-test' is visible, confirming the agent session remains active.
        await expect(page.locator("xpath=/html/body/div[1]/div/div/div/div[5]/div/div/div[1]/div/div[2]/button").nth(0)).to_be_visible(timeout=15000), "The model chooser button showing 'local-llama-test' is visible, confirming the agent session remains active."
        await asyncio.sleep(5)

    finally:
        if context:
            await context.close()
        if browser:
            await browser.close()
        if pw:
            await pw.stop()

asyncio.run(run_test())
    