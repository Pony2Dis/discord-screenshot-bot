// screenshot.js
require('dotenv').config();
const { firefox } = require('playwright');
const { WebhookClient } = require('discord.js');

console.log('token length (unused with webhook):', process.env.DISCORD_TOKEN?.length);
console.log('webhook url:', process.env.DISCORD_FEAR_GREED_WEBHOOK ? 'set' : 'MISSING');

const URL      = 'https://edition.cnn.com/markets/fear-and-greed';
const VIEWPORT = { width: 1200, height: 2800 };
const CLIP     = { x: 0, y: 650, width: 850, height: 500 };

if (!process.env.DISCORD_FEAR_GREED_WEBHOOK) {
  console.error('❌ DISCORD_FEAR_GREED_WEBHOOK is missing');
  process.exit(1);
}
const webhook = new WebhookClient({ url: process.env.DISCORD_FEAR_GREED_WEBHOOK });

async function main() {
  console.log('🚀 Starting screenshot job');
  try {
    // 1) Launch browser in “US mode”
    const browser = await firefox.launch({ headless: true });
    const context = await browser.newContext({
      locale: 'en-US',
      timezoneId: 'America/New_York',
      extraHTTPHeaders: { 'Accept-Language': 'en-US,en;q=0.9' }
    });
    const page = await context.newPage();
    await page.setViewportSize(VIEWPORT);

    // 2) Go to the page
    await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 120_000 });

    // 3) Wait for the Fear & Greed gauge
    await page.waitForFunction(() => {
      const el = document.querySelector('.market-fng-gauge__dial-number-value');
      return el?.textContent?.trim().length > 0;
    }, { timeout: 60_000 });
    console.log('⏱ Gauge value is present');

    // 4) Click “Agree” if it shows up
    const agreeLink = page.locator('a:has-text("Agree")');
    try {
      await agreeLink.waitFor({ timeout: 10_000 });
      await agreeLink.click({ force: true });
      await page.waitForTimeout(10_000);
    } catch (err) {
      console.log('⚠️ “Agree” link not found — continuing anyway: ', err.message);
    }

    // 5) Screenshot & send via webhook
    const buffer = await page.screenshot({ clip: CLIP });
    await browser.close();

    await webhook.send({
      files: [{ attachment: buffer, name: 'fear-and-greed.png' }],
      allowed_mentions: { parse: [] },
    });
    console.log('📸 Screenshot sent');
  } catch (err) {
    console.error(err);
  } finally {
    console.log('Finished job.');
    await webhook.destroy?.();
  }
}

main().catch(async (err) => {
  console.error(err);
  await webhook.destroy?.();
  process.exit(1);
});
