import asyncio
from playwright import async_api
from playwright.async_api import expect


async def run_test():
    pw = None
    browser = None
    context = None

    try:
        pw = await async_api.async_playwright().start()
        browser = await pw.chromium.launch(
            headless=True,
            args=[
                "--window-size=1280,720",
                "--disable-dev-shm-usage",
                "--ipc=host",
                "--single-process",
            ],
        )
        context = await browser.new_context()
        context.set_default_timeout(15000)
        page = await context.new_page()

        await page.goto("http://localhost:1420")
        try:
            await page.wait_for_load_state("domcontentloaded", timeout=5000)
        except Exception:
            pass

        await page.get_by_role("button", name="Sessions", exact=True).click(timeout=10000)

        first = page.get_by_test_id("session-row").filter(has_text="Add settings screen").nth(0)
        second = page.get_by_test_id("session-row").filter(has_text="Refactor agent loop").nth(0)

        await expect(first).to_be_visible(timeout=15000)
        await expect(second).to_be_visible(timeout=15000)

        await first.get_by_role("button").nth(0).click(timeout=10000)
        region = page.get_by_test_id("agent-run-region")
        first_prompt = "Add a settings screen with provider configuration and API key management."
        await expect(region).to_contain_text(first_prompt, timeout=15000)

        await second.get_by_role("button").nth(0).click(timeout=10000)
        await expect(page.get_by_text(first_prompt, exact=True)).not_to_be_visible(timeout=15000)
        await expect(page.get_by_text("Start a task", exact=True)).to_be_visible(timeout=15000)

        await first.get_by_role("button").nth(0).click(timeout=10000)
        await expect(page.get_by_test_id("agent-run-region")).to_contain_text(
            first_prompt,
            timeout=15000,
        )
        await asyncio.sleep(1)

    finally:
        if context:
            await context.close()
        if browser:
            await browser.close()
        if pw:
            await pw.stop()


asyncio.run(run_test())
