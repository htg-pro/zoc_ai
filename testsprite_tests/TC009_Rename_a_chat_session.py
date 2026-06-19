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

        row = page.get_by_test_id("session-row").filter(has_text="Add settings screen").nth(0)
        await expect(row).to_be_visible(timeout=15000)

        await row.hover()
        await row.get_by_test_id("session-rename-button").click(timeout=10000)

        input_box = row.get_by_test_id("session-rename-input")
        await expect(input_box).to_be_visible(timeout=10000)
        await input_box.fill("Renamed session")
        await row.get_by_test_id("session-rename-save").click(timeout=10000)

        await expect(row.get_by_test_id("session-row-title")).to_have_text(
            "Renamed session",
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
