// relay.mjs
import fs from 'fs';
import { Client, GatewayIntentBits } from 'discord.js';

const {
  DISCORD_TOKEN,
  YT_SOURCE_CHANNEL_ID,
  YT_TARGET_CHANNEL_ID
} = process.env;

const STATE_FILE = './youtube/lastMessageId.json';

// load last seen message ID
let lastId = null;
if (fs.existsSync(STATE_FILE)) {
  lastId = JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8')).lastId;
}

const client = new Client({ intents: [ GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent ] });

client.once('ready', async () => {
  const sourceChan = await client.channels.fetch(YT_SOURCE_CHANNEL_ID);
  const targetChan = await client.channels.fetch(YT_TARGET_CHANNEL_ID);
  if (!sourceChan || !targetChan) return client.destroy();

  // fetch messages after lastId, up to 100
  const options = lastId ? { after: lastId, limit: 100 } : { limit: 100 };
  const messages = await sourceChan.messages.fetch(options);
  const sorted = Array.from(messages.values()).sort((a,b) => a.createdTimestamp - b.createdTimestamp);

  for (const msg of sorted) {
    await targetChan.send(msg.content);
    lastId = msg.id;
  }

  // save new lastId
  fs.writeFileSync(STATE_FILE, JSON.stringify({ lastId }, null, 2));
  client.destroy();
});

client.login(DISCORD_TOKEN);
