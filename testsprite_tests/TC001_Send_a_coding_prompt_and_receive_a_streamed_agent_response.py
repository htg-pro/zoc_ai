import asyncio
import re
from playwright import async_api
from playwright.async_api import expect

async def backend_available(page):
    try:
        response = await page.request.get("http://127.0.0.1:8765/health", timeout=1000)
        return response.ok
    except Exception:
        return False

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
        
        # -> Type a coding prompt into the 'Message the agent…' composer and click the 'Send' button to start the agent run.
        # Message the agent… text area
        elem = page.get_by_placeholder('Message the agent…', exact=True)
        await elem.wait_for(state="visible", timeout=10000)
        await elem.fill("Write a Python function fib(n) that returns a list of the first n Fibonacci numbers using an iterative approach, include brief inline comments, and explain the time and space complexity.")
        
        # -> Type a coding prompt into the 'Message the agent…' composer and click the 'Send' button to start the agent run.
        # Send button
        elem = page.get_by_role('button', name='Send', exact=True)
        await elem.click(timeout=10000)
        
        # --> Assertions to verify final state
        
        # --> Verify the user message appears in the conversation timeline
        # Assert: Expected the user message 'Write a Python function fib(n) that returns a list of the first n Fibonacci numbers using an iterative approach, include brief inline comments, and explain the time and space complexity.' to appear in the conversation timeline.
        region = page.get_by_test_id("agent-run-region")
        prompt = "Write a Python function fib(n) that returns a list of the first n Fibonacci numbers using an iterative approach, include brief inline comments, and explain the time and space complexity."
        await expect(region).to_contain_text(prompt, timeout=15000), "Expected the user message to appear in the conversation timeline."

        if await backend_available(page):
            await expect(region).to_contain_text(re.compile(r"(intent|thinking|summary|done|completed)", re.I), timeout=30000), "Expected live gateway run activity or completion to appear."
        else:
            await expect(region).to_contain_text(re.compile(r"(Mock response|agent sidecar not reachable)", re.I), timeout=15000), "Expected offline fallback response when backend is unavailable."
        await asyncio.sleep(5)

    finally:
        if context:
            await context.close()
        if browser:
            await browser.close()
        if pw:
            await pw.stop()

asyncio.run(run_test())
