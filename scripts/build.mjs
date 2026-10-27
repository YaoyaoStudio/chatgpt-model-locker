import { copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const outputDirectory = join(projectRoot, "dist");
const typescriptEntrypoint = fileURLToPath(import.meta.resolve("typescript"));
const typescriptCli = join(dirname(dirname(typescriptEntrypoint)), "bin", "tsc");

const packageJson = JSON.parse(await readFile(join(projectRoot, "package.json"), "utf8"));
const manifest = {
  manifest_version: 3,
  name: "__MSG_extensionName__",
  version: packageJson.version,
  description: "__MSG_extensionDescription__",
  default_locale: "en",
  permissions: ["storage"],
  content_scripts: [
    {
      matches: ["https://chatgpt.com/*", "https://chat.openai.com/*"],
      js: ["content.js"],
      run_at: "document_idle"
    }
  ],
  icons: {
    16: "icons/icon16.png",
    32: "icons/icon32.png",
    48: "icons/icon48.png",
    128: "icons/icon128.png"
  }
};

const { spawnSync } = await import("node:child_process");
const typecheck = spawnSync(process.execPath, [typescriptCli, "--noEmit"], {
  cwd: projectRoot,
  stdio: "inherit"
});
if (typecheck.status !== 0) {
  process.exit(typecheck.status ?? 1);
}

await rm(outputDirectory, { recursive: true, force: true });
await mkdir(join(outputDirectory, "icons"), { recursive: true });
await build({
  entryPoints: [join(projectRoot, "src/content.ts")],
  outfile: join(outputDirectory, "content.js"),
  bundle: true,
  format: "iife",
  platform: "browser",
  target: ["chrome120"],
  sourcemap: false,
  legalComments: "none"
});
await writeFile(join(outputDirectory, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
await copyFile(join(projectRoot, "LICENSE"), join(outputDirectory, "LICENSE"));

const translations = await build({
  entryPoints: [join(projectRoot, "src/i18n.ts")],
  bundle: true,
  format: "esm",
  platform: "node",
  write: false
});
const { MESSAGES } = await import("data:text/javascript;base64," + Buffer.from(translations.outputFiles[0].text).toString("base64"));
// Chrome's extension metadata supports zh_CN/zh_TW. The in-page UI also has HK/MO variants.
for (const [chromeLocale, displayLocale] of Object.entries({ en: "en", zh_CN: "zh-CN", zh_TW: "zh-TW", ja: "ja" })) {
  const directory = join(outputDirectory, "_locales", chromeLocale);
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "messages.json"), JSON.stringify({
    extensionName: { message: "ChatGPT · " + MESSAGES[displayLocale].title },
    extensionDescription: { message: MESSAGES[displayLocale].extensionDescription }
  }, null, 2) + "\n");
}

for (const size of [16, 32, 48, 128]) {
  const source = join(projectRoot, "assets/icons", `icon${size}.png`);
  const destination = join(outputDirectory, "icons", `icon${size}.png`);
  await (await import("node:fs/promises")).copyFile(source, destination);
}
