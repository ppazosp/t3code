import {
  ChatAttachmentId,
  PROVIDER_SEND_TURN_MAX_IMAGE_BYTES,
  type ChatAttachment,
  type ChatImageAttachment,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import {
  attachmentRelativePath,
  chatAttachmentStableKey,
  createDeterministicAttachmentId,
  resolveAttachmentPath,
} from "../attachmentStore.ts";
import { ServerConfig } from "../config.ts";
import { ChannelError } from "./Channel.ts";

/** The largest image a channel message passes on, as for an image typed into T3. */
export const IMAGE_LIMIT = PROVIDER_SEND_TURN_MAX_IMAGE_BYTES;

/** The most images one channel message passes on. */
export const IMAGES_PER_MESSAGE = 10;

export interface ImageBytes {
  readonly name: string;
  readonly mimeType: string;
  readonly bytes: Uint8Array;
}

/** Stores images as attachments of a message in `threadId`, which owns their files. */
export const saveImages = Effect.fn("Channels.saveImages")(function* (
  threadId: string,
  messageId: string,
  images: ReadonlyArray<ImageBytes>,
) {
  const config = yield* ServerConfig;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  return yield* Effect.forEach(images, (image, index) =>
    Effect.gen(function* () {
      const id = createDeterministicAttachmentId(
        threadId,
        chatAttachmentStableKey(messageId, index, image.bytes),
      );
      const attachment: ChatImageAttachment | null =
        id === null
          ? null
          : {
              type: "image",
              id: ChatAttachmentId.make(id),
              name: image.name.trim().slice(0, 200) || "image",
              mimeType: image.mimeType,
              sizeBytes: image.bytes.byteLength,
            };
      const relative = attachment === null ? null : attachmentRelativePath(attachment);
      if (attachment === null || relative === null) {
        return yield* new ChannelError({ message: "Could not name an image's file." });
      }
      yield* fs
        .writeFile(path.join(config.attachmentsDir, relative), image.bytes)
        .pipe(Effect.mapError(() => new ChannelError({ message: "Could not save an image." })));
      return attachment;
    }),
  );
});

/**
 * Copies a message's images to a message in another thread. Each thread owns its attachment files,
 * so deleting one never takes the other's images with it.
 */
export const copyImages = Effect.fn("Channels.copyImages")(function* (
  threadId: string,
  messageId: string,
  attachments: ReadonlyArray<ChatAttachment>,
) {
  const config = yield* ServerConfig;
  const fs = yield* FileSystem.FileSystem;
  const images = [];
  for (const attachment of attachments) {
    if (attachment.type !== "image") continue;
    const file = resolveAttachmentPath({ attachmentsDir: config.attachmentsDir, attachment });
    if (file === null) continue;
    const bytes = yield* fs
      .readFile(file)
      .pipe(Effect.mapError(() => new ChannelError({ message: "Could not read an image." })));
    images.push({ name: attachment.name, mimeType: attachment.mimeType, bytes });
  }
  return yield* saveImages(threadId, messageId, images);
});
