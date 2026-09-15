import { createHash } from "node:crypto";
import { access, cp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { Plugin } from "vite";

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

// Packages Sites metadata and migrations after Vite finishes compiling.
export function sites(): Plugin {
  let root = process.cwd();

  return {
    name: "sites",
    apply: "build",
    configResolved(config) {
      root = config.root;
    },
    async closeBundle() {
      const outputDirectory = resolve(root, "dist", ".openai");
      const hostingConfig = resolve(root, ".openai", "hosting.json");
      const drizzleSource = resolve(root, "drizzle");

      // Browser QA pages deliberately import source modules and test fixtures.
      // They remain available in development, never in the published artifact.
      for (const file of ["qa-reading-import.html", "qa-fixtures"]) {
        await rm(resolve(root, "dist", "client", file), { recursive: true, force: true });
      }

      await rm(outputDirectory, { recursive: true, force: true });
      await mkdir(outputDirectory, { recursive: true });

      if (await exists(hostingConfig)) {
        await cp(hostingConfig, resolve(outputDirectory, "hosting.json"));
      }
      const assets = resolve(root, "dist", "client", "assets");
      if (await exists(assets)) {
        const files = (await readdir(assets)).filter((file) => /\.(?:js|css|woff2?)$/.test(file)).sort();
        await writeFile(resolve(root, "dist", "client", "offline-assets.json"), JSON.stringify(files.map((file) => `/assets/${file}`)));
        const fingerprint = createHash("sha256").update(files.join("\n"));
        const dataRoot = resolve(root, "public", "data", "v1");
        for (const file of (await readdir(dataRoot, { recursive: true })).filter((file) => file.endsWith(".json")).sort()) {
          fingerprint.update(await readFile(resolve(dataRoot, file)));
        }
        const readingRoot = resolve(root, "public", "readings", "v1");
        if (await exists(readingRoot)) for (const file of (await readdir(readingRoot, { recursive: true })).filter(file => file.endsWith(".json")).sort()) {
          fingerprint.update(await readFile(resolve(readingRoot, file)));
        }
        for (const directory of ["icons", "images"]) {
          const staticRoot = resolve(root, "public", directory);
          if (await exists(staticRoot)) for (const file of (await readdir(staticRoot)).sort()) {
            fingerprint.update(await readFile(resolve(staticRoot, file)));
          }
        }
        const worker = await readFile(resolve(root, "public", "sw.js"), "utf8");
        fingerprint.update(worker);
        await writeFile(resolve(root, "dist", "client", "sw.js"), worker.replace('"vocab-shell-v2"', `"vocab-shell-v2-${fingerprint.digest("hex").slice(0, 16)}"`));
      }
      if (await exists(drizzleSource)) {
        await cp(drizzleSource, resolve(outputDirectory, "drizzle"), {
          recursive: true,
        });
      }
    },
  };
}
