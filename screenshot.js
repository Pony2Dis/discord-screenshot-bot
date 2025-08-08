// screenshot.js
require('dotenv').config();
const { firefox } = require('playwright');
const { Client, GatewayIntentBits, AttachmentBuilder } = require('discord.js');

console.log('token length:', process.env.DISCORD_TOKEN?.length);
console.log('channel id :', process.env.CHANNEL_ID);

const URL      = 'https://edition.cnn.com/markets/fear-and-greed';
const VIEWPORT = { width: 1200, height: 2800 };
const CLIP     = { x: 0, y: 650, width: 850, height: 500 };
const bot = new Client({ intents: [GatewayIntentBits.Guilds] });

async function main() {
  console.log('🚀 Starting screenshot job');
  try {
    // 1. Discord login
    await bot.login(process.env.DISCORD_TOKEN);
    console.log('✅ Logged in');

    // 2. Launch browser in “US mode”
    const browser = await firefox.launch({ headless: true });
    const context = await browser.newContext({
      locale: 'en-US',
      timezoneId: 'America/New_York',
      extraHTTPHeaders: { 'Accept-Language': 'en-US,en;q=0.9' }
    });
    const page = await context.newPage();
    await page.setViewportSize(VIEWPORT);

    // 3. Go to the page
    await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 120_000 });

    // 4. Wait for the Fear & Greed gauge
    await page.waitForFunction(() => {
      const el = document.querySelector('.market-fng-gauge__dial-number-value');
      return el?.textContent?.trim().length > 0;
    }, { timeout: 60_000 });
    console.log('⏱ Gauge value is present');

    // 5. Click “Agree” if it shows up
    const agreeLink = page.locator('a:has-text("Agree")');
    try {
      await agreeLink.waitFor({ timeout: 10_000 });
      await agreeLink.click({ force: true });
      await page.waitForTimeout(10_000);
    } catch {
      console.log('⚠️ “Agree” link not found — continuing anyway');
    }

    // 6. Screenshot & send
    const buffer = await page.screenshot({ clip: CLIP });
    await browser.close();

    const channel = await bot.channels.fetch(process.env.CHANNEL_ID);
    await channel.send({
      files: [ new AttachmentBuilder(buffer, { name: 'fear-and-greed.png' }) ]
    });
    console.log('📸 Screenshot sent');
  } catch (err) {
    console.error(err);
  } finally {
    if (bot) await bot.destroy();
    console.log('🛑 Process finished');
  }
}

main();

process.on("SIGINT",  () => bot.destroy().then(() => process.exit(0)));
process.on("SIGTERM", () => bot.destroy().then(() => process.exit(0)));
