import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { zipSync } from "fflate";

const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const distributionDirectory = join(projectRoot, "dist");
const releaseDirectory = join(projectRoot, "release");
const packageJson = JSON.parse(await readFile(join(projectRoot, "package.json"), "utf8"));
const entries = {};

async function addDirectory(directory) {
  for (const item of await readdir(directory, { withFileTypes: true })) {
    const absolutePath = join(directory, item.name);
    if (item.isDirectory()) {
      await addDirectory(absolutePath);
    } else if (item.isFile()) {
      const archivePath = relative(distributionDirectory, absolutePath).replaceAll("\\", "/");
      entries[archivePath] = await readFile(absolutePath);
    }
  }
}

await addDirectory(distributionDirectory);
if (!entries["manifest.json"]) throw new Error("Build output is missing root manifest.json.");

await mkdir(releaseDirectory, { recursive: true });
const archivePath = join(releaseDirectory, `chatgpt-model-effort-${packageJson.version}.zip`);
await writeFile(archivePath, zipSync(entries, { level: 9 }));
process.stdout.write(`Created ${archivePath}\n`);
