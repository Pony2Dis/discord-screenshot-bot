// screenshot.js
const puppeteer = require('puppeteer');
const { Client, Intents, MessageAttachment } = require('discord.js');

const bot = new Client({ intents: [Intents.FLAGS.GUILDS] });
const URL        = 'https://edition.cnn.com/markets/fear-and-greed';
const VIEWPORT   = { width: 1200, height: 800 };
const CLIP       = { x: 100, y: 200, width: 800, height: 400 };

bot.once('ready', () => {
  (async () => {
    const browser = await puppeteer.launch();
    const page    = await browser.newPage();
    await page.setViewport(VIEWPORT);
    await page.goto(URL, { waitUntil: 'networkidle2' });
    const buffer  = await page.screenshot({ clip: CLIP });
    await browser.close();

    const channel = await bot.channels.fetch(process.env.CHANNEL_ID);
    await channel.send({ files: [new MessageAttachment(buffer, 'shot.png')] });
    process.exit(0);
  })();
});

bot.login(process.env.DISCORD_TOKEN);
