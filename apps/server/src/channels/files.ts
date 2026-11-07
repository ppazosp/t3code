import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";

import { fileHeaderMimeType } from "../workspace/fileHeaderMimeType.ts";
import { ChannelError, type ChannelFile } from "./Channel.ts";

const IMAGES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

/** An image or video type read from a file's first bytes, so a renamed file is not taken for one. */
export function mediaType(header: Uint8Array): string | undefined {
  const sniffed = fileHeaderMimeType(header);
  if (sniffed !== undefined) return IMAGES.has(sniffed) ? sniffed : undefined;
  if ([0x1a, 0x45, 0xdf, 0xa3].every((byte, index) => header[index] === byte)) {
    return "video/webm";
  }
  // ISO media (MP4, MOV, HEIC) names its brand after "ftyp" at offset 4.
  const text = new TextDecoder("latin1").decode(header.subarray(4, 12));
  if (!text.startsWith("ftyp")) return undefined;
  const brand = text.slice(4);
  if (brand === "qt  ") return "video/quicktime";
  if (["heic", "heix", "mif1"].includes(brand)) return "image/heic";
  if (brand === "avif") return "image/avif";
  if (brand.startsWith("M4A") || brand.startsWith("M4B") || brand.startsWith("M4P")) {
    return undefined;
  }
  return "video/mp4";
}

const megabytes = (bytes: number) => `${Math.round(bytes / 1024 / 1024)} MB`;

/**
 * Opens a file a worker attaches: an image or video inside its working folder once links are
 * followed, at most `limit` bytes. Anything else is refused, so a worker cannot post a secret.
 */
export const openChannelFile = Effect.fn("Channels.openFile")(function* (
  root: string,
  requested: string,
  limit: number,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const refuse = (message: string) => new ChannelError({ message: `${requested}: ${message}` });
  const absolute = path.isAbsolute(requested) ? requested : path.join(root, requested);
  const realRoot = yield* fs
    .realPath(root)
    .pipe(Effect.mapError(() => refuse("your working folder could not be read.")));
  const real = yield* fs.realPath(absolute).pipe(Effect.mapError(() => refuse("no such file.")));
  const inside = path.relative(realRoot, real);
  if (inside === "" || inside.startsWith("..") || path.isAbsolute(inside)) {
    return yield* refuse("attach only files inside your working folder.");
  }
  const info = yield* fs.stat(real).pipe(Effect.mapError(() => refuse("could not be read.")));
  if (info.type !== "File") return yield* refuse("not a file.");
  const size = Number(info.size);
  if (size === 0) return yield* refuse("the file is empty.");
  if (size > limit) {
    return yield* refuse(
      `it is ${megabytes(size)}; this channel takes files up to ${megabytes(limit)}.`,
    );
  }
  const header = yield* fs.open(real).pipe(
    Effect.flatMap((file) => file.readAlloc(64)),
    Effect.scoped,
    Effect.mapError(() => refuse("could not be read.")),
  );
  const mimeType = mediaType(Option.getOrElse(header, () => new Uint8Array()));
  if (mimeType === undefined) return yield* refuse("attach only images or videos.");
  return {
    name: path.basename(real),
    size,
    mimeType,
    bytes: fs.stream(real).pipe(Stream.mapError(() => refuse("could not be read."))),
  } satisfies ChannelFile;
});
