/**
 * Fork: the environment's name from a one-line `environment-label` file in the server's
 * userdata directory, so machines carry short fleet names without renaming the
 * computers. Without the file T3's own label (the computer name) stays.
 */
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

export const readForkEnvironmentLabel = Effect.fn("fork.readEnvironmentLabel")(function* (
  userdataDir: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const text = yield* fs
    .readFileString(path.join(userdataDir, "environment-label"))
    .pipe(Effect.orElseSucceed(() => ""));
  const label = text.split("\n")[0]?.trim() ?? "";
  return label === "" ? null : label;
});
