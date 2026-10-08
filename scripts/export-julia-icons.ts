import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import sharp from "sharp";
import { encodePngIco, WINDOWS_ICON_SIZES } from "./lib/icon-export.ts";

class JuliaIconAssetsStaleError extends Schema.TaggedError<JuliaIconAssetsStaleError>()(
  "JuliaIconAssetsStaleError",
  { paths: Schema.Array(Schema.String) },
) {
  override get message() {
    return `Julia icon assets are stale:\n${this.paths.join("\n")}`;
  }
}

// Julia's original vector sources render directly into platform renditions.
// The macOS source owns its 824px safe area; no full-bleed export is resized.
const exportIcons = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = path.resolve(import.meta.dirname, "..");
  const readSource = (name: string) =>
    fs.readFile(path.join(root, "assets/julia", name)).pipe(Effect.map(Buffer.from));
  const [app, mac, foreground, mark] = yield* Effect.all([
    readSource("app-icon.svg"),
    readSource("macos-icon.svg"),
    readSource("adaptive-foreground.svg"),
    readSource("mark.svg"),
  ]);
  const outputs = yield* Effect.tryPromise(async () => {
    const raster = (svg: Buffer, size: number) => sharp(svg).resize(size, size).png().toBuffer();
    const images = new Map<string, Buffer>([
      ["assets/julia/app-icon-1024.png", await raster(app, 1024)],
      ["assets/julia/macos-icon-1024.png", await raster(mac, 1024)],
      ["assets/julia/apple-touch-icon.png", await raster(app, 180)],
      ["assets/julia/favicon-16x16.png", await raster(app, 16)],
      ["assets/julia/favicon-32x32.png", await raster(app, 32)],
    ]);
    const ico = encodePngIco(
      await Promise.all(
        WINDOWS_ICON_SIZES.map(async (size) => ({
          size,
          contents: await raster(app, size),
        })),
      ),
    );
    images.set("assets/julia/app-icon.ico", ico);
    images.set("assets/julia/favicon.ico", ico);
    images.set(
      "apps/mobile/assets/android-icon-foreground-julia.png",
      await raster(foreground, 432),
    );
    images.set(
      "apps/mobile/assets/android-icon-mark-julia.png",
      await raster(
        Buffer.from(
          foreground.toString().replaceAll("#9dcebc", "#ffffff").replaceAll("#f1f3ef", "#ffffff"),
        ),
        432,
      ),
    );
    images.set(
      "apps/mobile/assets/android-icon-background-julia.png",
      await sharp({
        create: { width: 432, height: 432, channels: 4, background: "#202322" },
      })
        .png()
        .toBuffer(),
    );
    images.set(
      "apps/mobile/assets/android-splash-icon-julia.png",
      await sharp({
        create: { width: 1152, height: 1152, channels: 4, background: "#202322" },
      })
        .composite([{ input: await raster(foreground, 1152) }])
        .png()
        .toBuffer(),
    );
    for (const name of [
      "favicon.ico",
      "favicon-16x16.png",
      "favicon-32x32.png",
      "apple-touch-icon.png",
    ]) {
      const bytes = images.get(`assets/julia/${name}`);
      if (!bytes) throw new Error(`Missing Julia rendition: ${name}`);
      images.set(`apps/web/public/${name}`, bytes);
    }
    images.set("apps/web/public/julia.svg", mark);
    return images;
  });
  const checkOnly = process.argv.includes("--check");
  const stale: string[] = [];
  for (const [name, bytes] of outputs) {
    const target = path.join(root, name);
    if (checkOnly) {
      const exists = yield* fs.exists(target);
      const actual = exists ? yield* fs.readFile(target) : null;
      if (actual === null || !Buffer.from(actual).equals(bytes)) stale.push(name);
    } else {
      yield* fs.writeFile(target, bytes);
      yield* Console.log(`wrote ${name}`);
    }
  }
  if (stale.length > 0) return yield* new JuliaIconAssetsStaleError({ paths: stale });
  if (checkOnly) yield* Console.log("Julia icon assets are current.");
});

if (import.meta.main) exportIcons.pipe(Effect.provide(NodeServices.layer), NodeRuntime.runMain);
