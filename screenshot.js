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

    // 4) Click consent only if it's the exact one (avoid article links)
    try {
      // Prefer a button like "Accept"/"Agree"
      const btn = page.getByRole('button', { name: /^(accept|i ?agree|agree|accept all)$/i }).first();
      if (await btn.count()) {
        await btn.click({ timeout: 5_000 });
        await page.waitForTimeout(500);
      } else {
        // Fallback: an exact-text link "Agree" (not the news article)
        const link = page.getByRole('link', { name: 'Agree', exact: true }).first();
        if (await link.count()) {
          await link.click({ timeout: 5_000 });
          await page.waitForTimeout(500);
        }
      }
    } catch (err) {
      console.log('⚠️ Consent click skipped:', err.message);
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
