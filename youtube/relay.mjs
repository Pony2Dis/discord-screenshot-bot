import fs from 'fs';
import { Client, GatewayIntentBits } from 'discord.js';

const {
  DISCORD_TOKEN,
  YT_SOURCE_CHANNEL_ID,
  YT_TARGET_CHANNEL_ID
} = process.env;

const STATE_FILE = './youtube/lastMessageId.json';
let lastId = null;
if (fs.existsSync(STATE_FILE)) {
  lastId = JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8')).lastId;
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ]
});

client.once('ready', async () => {
  try {
    client.login(DISCORD_TOKEN);
    
    const sourceChan = await client.channels.fetch(YT_SOURCE_CHANNEL_ID);
    const targetChan = await client.channels.fetch(YT_TARGET_CHANNEL_ID);
    if (!sourceChan || !targetChan) return client.destroy();

    const options = lastId ? { after: lastId, limit: 100 } : { limit: 100 };
    console.log(`Fetching messages from channel ${sourceChan.id} with options:`, options);

    const messages = await sourceChan.messages.fetch(options);
    const sorted = Array.from(messages.values()).sort((a, b) => a.createdTimestamp - b.createdTimestamp);
    console.log(`Fetched ${sorted.length} messages from channel ${sourceChan.id}`);

    for (const msg of sorted) {
      console.log(`Processing message ID: ${msg.id} | Content: ${msg.content.slice(0, 500)}`);
      if (!msg.content?.trim() && !msg.embeds.length && !msg.attachments.size) continue;

      console.log(`constructing payload for message ID: ${msg.id}`);
      const payload = {
        ...(msg.content && { content: msg.content }),
        ...(msg.embeds.length && { embeds: msg.embeds.map(e => e.toJSON()) }),
        ...(msg.attachments.size && {
          files: msg.attachments.map(a => ({ attachment: a.url, name: a.name }))
        })
      };

      console.log(`Relaying message ID: ${msg.id} to channel ${targetChan.id}`);
      await targetChan.send(payload);

      lastId = msg.id;
    }

    console.log(`Saving last processed message ID: ${lastId}`);
    fs.writeFileSync(STATE_FILE, JSON.stringify({ lastId }, null, 2));

    console.log('Disconnecting client...');
    client.destroy();
  } catch (error) {
    console.error('Failed to login:', error);
  } finally {
    if (client) await client.destroy();
  }
});
