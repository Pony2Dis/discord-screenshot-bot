import axios from "axios";
import sharp from "sharp";
import { AttachmentBuilder } from "discord.js";

export async function handleAnticipatedImage({ client, interaction, ANTICIPATED_CHANNEL_ID }) {
  try {
    const channel = await client.channels.fetch(ANTICIPATED_CHANNEL_ID);
    const fetched = await channel.messages.fetch({ limit: 10 });
    const imgMsg = fetched.find(
      (m) => m.attachments.size > 0 || m.embeds.some((e) => e.image || e.thumbnail)
    );
    if (!imgMsg) {
      return interaction.followUp("❌ לא נמצאה תמונה שהתפרסמה.");
    }

    const url =
      imgMsg.attachments.size > 0
        ? imgMsg.attachments.first().url
        : (imgMsg.embeds.find((e) => e.image)?.image?.url ||
           imgMsg.embeds.find((e) => e.thumbnail)?.thumbnail?.url);

    if (!url) {
      return interaction.followUp("❌ לא נמצאה תמונה בהודעה האחרונה.");
    }

    const resp = await axios.get(url, { responseType: "arraybuffer" });
    const imgBuf = Buffer.from(resp.data);

    // Day-based cropping presets (Mon–Fri = 1..5)
    const presets = {
      1: { left: 5, top: 80, width: 265, height: 587 },
      2: { left: 267, top: 80, width: 265, height: 587 },
      3: { left: 532, top: 80, width: 265, height: 587 },
      4: { left: 795, top: 80, width: 265, height: 587 },
      5: { left: 1059, top: 80, width: 140, height: 587 },
    };

    const israelDate = new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Jerusalem" }));
    const day = israelDate.getDay(); // 0=Sun ... 6=Sat
    const region = presets[day] || presets[1];

    const cropped = await sharp(imgBuf).extract(region).toBuffer();
    const file = new AttachmentBuilder(cropped, { name: "today.png" });
    return interaction.followUp({ files: [file] });
  } catch (err) {
    console.error(err);
    return interaction.followUp("❌ שגיאה בחיתוך התמונה.");
  }
}
