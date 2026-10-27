import { mkdir, readFile } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// Asset-authoring helper: use an installed sharp package or pass its module path.
// The extension build consumes the checked-in PNG files and does not need sharp.
const rendererModule = process.argv[2] ?? "sharp";
const { default: sharp } = await import(isAbsolute(rendererModule) ? pathToFileURL(rendererModule).href : rendererModule);
const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const outputDirectory = join(projectRoot, "assets", "icons");
const source = await readFile(join(outputDirectory, "icon-source.svg"));

await mkdir(outputDirectory, { recursive: true });
for (const size of [16, 32, 48, 128]) {
  await sharp(source, { density: 768 })
    .resize(size, size, { kernel: "lanczos3" })
    .png()
    .toFile(join(outputDirectory, `icon${size}.png`));
}
