# Playwright smoke test: screenshots of the human UI.
# Usage: python3 qa/screenshot.py [baseUrl]   (default http://localhost:3000)
# Requires the playwright venv: ~/workspace/tools/playwright-venv/
import sys
from playwright.sync_api import sync_playwright

BASE = (sys.argv[1] if len(sys.argv) > 1 else 'http://localhost:3000').rstrip('/')

with sync_playwright() as p:
    browser = p.chromium.launch()
    page = browser.new_page(viewport={'width': 1280, 'height': 900})
    page.goto(BASE, wait_until='networkidle')
    page.wait_for_timeout(1200)
    page.screenshot(path='qa/evidence/ui-01-lobby.png')
    print('lobby screenshot ok')

    # Quick game vs bot.
    page.click('#btnQuick')
    page.wait_for_timeout(2500)
    page.screenshot(path='qa/evidence/ui-02-board-start.png')
    print('board screenshot ok')

    # Select one of my units (first .unit.mine) to show reachable cells.
    mine = page.query_selector('.unit.mine')
    if mine:
        mine.click()
        page.wait_for_timeout(800)
        page.screenshot(path='qa/evidence/ui-03-unit-selected.png')
        print('unit-selected screenshot ok')
    else:
        print('WARNING: no .unit.mine found (not my turn or game not started)')

    # Let the bot take a few turns, then capture the board again.
    page.wait_for_timeout(9000)
    page.screenshot(path='qa/evidence/ui-04-board-midgame.png')
    status = page.inner_text('#gameStatus')
    print('status after bot turns:', status)
    browser.close()
print('done')
