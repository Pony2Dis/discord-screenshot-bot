// Repost the message as the bot in the original channel, preserving reply + stickers.
export async function repostMessage(message, files) {
    const replyTargetId = message.reference?.messageId ?? null;
    const stickerIds = message.stickers?.map(s => s.id) ?? [];
  
    const options = {
      content: (message.content ?? "") || (files?.length ? "" : "(no content)"),
      files: files?.length ? files : undefined,
      allowedMentions: { parse: [] }, // avoid accidental pings; tweak if needed
      reply: replyTargetId
        ? { messageReference: replyTargetId, failIfNotExists: false }
        : undefined,
      stickers: stickerIds.length ? stickerIds : undefined,
    };
  
    return message.channel.send(options);
  }
  