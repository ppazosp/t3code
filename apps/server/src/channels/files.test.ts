import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";

import { mediaType, openChannelFile } from "./files.ts";

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const MP4 = new Uint8Array([0, 0, 0, 0x18, ...new TextEncoder().encode("ftypisom"), 0, 0]);

describe("files a worker attaches", () => {
  it("knows images and videos by their first bytes, and nothing else", () => {
    const ftyp = (brand: string) =>
      new Uint8Array([0, 0, 0, 0x18, ...new TextEncoder().encode(`ftyp${brand}`)]);
    assert.deepStrictEqual(
      [PNG, MP4, ftyp("qt  "), ftyp("M4A "), new Uint8Array([0x1a, 0x45, 0xdf, 0xa3])].map(
        mediaType,
      ),
      ["image/png", "video/mp4", "video/quicktime", undefined, "video/webm"],
    );
    assert.isUndefined(mediaType(new TextEncoder().encode("%PDF-1.7")));
    assert.isUndefined(mediaType(new TextEncoder().encode("TOKEN=secret")));
  });

  it.effect("opens an image inside the working folder and refuses anything else", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-channel-files-" });
      const outside = yield* fs.makeTempDirectoryScoped({ prefix: "t3-channel-outside-" });
      yield* fs.writeFile(path.join(root, "shot.png"), PNG);
      yield* fs.writeFile(path.join(root, ".env"), new TextEncoder().encode("TOKEN=secret"));
      yield* fs.writeFile(path.join(outside, "secret.png"), PNG);
      yield* fs.symlink(path.join(outside, "secret.png"), path.join(root, "link.png"));

      const file = yield* openChannelFile(root, "shot.png", 1000);
      assert.deepStrictEqual([file.name, file.size, file.mimeType], ["shot.png", 11, "image/png"]);
      const bytes = yield* Stream.runCollect(file.bytes);
      assert.deepStrictEqual(
        bytes.flatMap((chunk) => [...chunk]),
        [...PNG],
      );

      const open = (requested: string, limit = 1000) =>
        openChannelFile(root, requested, limit).pipe(
          Effect.flip,
          Effect.map((error) => error.message),
        );
      assert.include(yield* open(".env"), "only images or videos");
      assert.include(yield* open("link.png"), "inside your working folder");
      assert.include(yield* open(path.join(outside, "secret.png")), "inside your working folder");
      assert.include(yield* open("../x.png"), "no such file");
      assert.include(yield* open("shot.png", 10), "takes files up to");

      // The upload reads the file it checked; one that grew since stops rather than posting.
      const grown = yield* openChannelFile(root, "shot.png", 1000);
      yield* fs.writeFile(path.join(root, "shot.png"), new Uint8Array([...PNG, 9, 9]));
      const changed = yield* Stream.runCollect(grown.bytes).pipe(Effect.flip);
      assert.include(changed.message, "changed while it uploaded");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
