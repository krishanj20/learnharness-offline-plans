import { copyFile, mkdir, rm } from "node:fs/promises";
import { lstatSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const output = new URL("./dist/", import.meta.url);
if (lstatSync(new URL("./dist", import.meta.url), { throwIfNoEntry: false })?.isSymbolicLink()
  || lstatSync(new URL("data", output), { throwIfNoEntry: false })) {
  throw new Error("Refusing to replace a symlinked dist directory or misplaced dist/data.");
}
await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });
await build({
  entryPoints: [fileURLToPath(new URL("./backend.mjs", import.meta.url))],
  outfile: fileURLToPath(new URL("backend.cjs", output)),
  platform: "node",
  format: "cjs",
  minify: true,
  bundle: true,
  target: "node22",
});
for (const file of ["manifest.json", "main.js", "styles.css"]) {
  await copyFile(new URL(file, import.meta.url), new URL(file, output));
}
await copyFile(new URL("./LICENSE", import.meta.url), new URL("LICENSE", output));
await copyFile(new URL("../license", import.meta.resolve("typebox")), new URL("TYPEBOX-LICENSE", output));
