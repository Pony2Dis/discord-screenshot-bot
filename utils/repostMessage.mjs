// /utils/repostMessage.js
import { anonymizeTradingViewIfNeeded } from "./anonymizeTradingView.js";

// Repost the message as the bot in the original channel, preserving reply + stickers.
export async function repostMessage(message, files, userInitials) {
  const replyTargetId = message.reference?.messageId ?? null;
  const stickerIds = message.stickers?.map(s => s.id) ?? [];

  // 🔒 Anonymize only images that contain the TradingView header with username
  const processedFiles = files?.length
    ? await Promise.all(files.map(anonymizeTradingViewIfNeeded))
    : undefined;

  const options = {
    content: (`${userInitials} \n${message.content}` ?? "") || (processedFiles?.length ? "" : "(no content)"),
    files: processedFiles,
    allowedMentions: { parse: [] }, // avoid accidental pings; tweak if needed
    reply: replyTargetId
      ? { messageReference: replyTargetId, failIfNotExists: false }
      : undefined,
    stickers: stickerIds.length ? stickerIds : undefined,
  };

  return message.channel.send(options);
}
