// Generate LLM/agent-facing docs from the codebase — no hand-maintained API prose.
//
//   bun run docs   (== bun run build && bun run scripts/gen-llms.ts)
//
// Sources (all already maintained in-repo, so nothing here can drift):
//   - each package's README.md            → narrative
//   - each package's dist/index.d.ts      → authoritative, typed public API
//   - examples/*.ts leading comment       → example index
//
// Emits into the published site dir:
//   - llms.txt        index (https://llmstxt.org format)
//   - llms-full.txt   the whole corpus (README + full .d.ts + examples) in one fetch
//   - api/<pkg>.md    per-package: README + type definitions
//
// The human docs (index.html, docs.html) are hand-crafted and left untouched.

import { readdirSync, existsSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const SITE = join(ROOT, "packages", "model-router", "site");
const REPO = "https://github.com/acalejos/swoosh";
const SITE_URL = "https://acalejos.github.io/swoosh";

// dir → npm name + one-line blurb (order = recommended reading order)
const PACKAGES = [
  { dir: "sdk", name: "@swoosh-dev/sdk", blurb: "Batteries-included drop-in: createRouter(), auto-wired providers, re-exports everything." },
  { dir: "model-router", name: "@swoosh-dev/router", blurb: "Zero-dependency core: intent + policy routing, inspectable plans, automatic fallback." },
  { dir: "capabilities", name: "@swoosh-dev/capabilities", blurb: "Curated, enriched model dataset (models.dev ∪ web_search / latency / quality / benchmarks)." },
  { dir: "judge", name: "@swoosh-dev/judge", blurb: "Dynamic policies: classify the prompt with an LLM judge, route by the verdict." },
  { dir: "ai-sdk", name: "@swoosh-dev/ai-sdk", blurb: "Vercel AI SDK provider adapter." },
];

// "@swoosh-dev/router" -> "swoosh-dev-router" for flat, URL-safe filenames
const slug = (name: string) => name.replace(/^@/, "").replace(/\//g, "-");

const read = (p: string) => (existsSync(p) ? Bun.file(p).text() : Promise.resolve(""));
const stripFrontMatterBadges = (md: string) =>
  // drop leading shields.io badge lines so the corpus stays clean
  md.replace(/^\s*\[!\[[^\]]*\]\([^)]*\)\]\([^)]*\)\s*$/gm, "").replace(/\n{3,}/g, "\n\n").trim();

async function packageDts(dir: string): Promise<string> {
  const dts = join(ROOT, "packages", dir, "dist", "index.d.ts");
  if (!existsSync(dts)) {
    throw new Error(`Missing ${dts} — run \`bun run build\` first (the docs script does this for you).`);
  }
  return (await Bun.file(dts).text()).trim();
}

function collectExamples() {
  const dir = join(ROOT, "packages", "model-router", "examples");
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => /^\d+.*\.ts$/.test(f))
    .sort()
    .map((file) => {
      const src = Bun.file(join(dir, file)).text();
      return { file, src };
    });
}

async function exampleMeta(file: string, src: string) {
  const lines = src.split("\n");
  const comment: string[] = [];
  for (const line of lines) {
    const m = line.match(/^\/\/ ?(.*)$/);
    if (!m) break;
    comment.push(m[1]);
  }
  // drop the "Run from the repo root: ..." invocation line
  const desc = comment
    .filter((l) => !/^Run from/i.test(l))
    .join(" ")
    .trim();
  const title = file.replace(/\.ts$/, "");
  return { file, title, desc, src: src.trim() };
}

async function main() {
  const rootReadme = stripFrontMatterBadges(await read(join(ROOT, "README.md")));
  const examplesRaw = collectExamples();
  const examples = await Promise.all(
    examplesRaw.map(async (e) => exampleMeta(e.file, await e.src)),
  );

  const pkgs = await Promise.all(
    PACKAGES.map(async (p) => ({
      ...p,
      readme: stripFrontMatterBadges(await read(join(ROOT, "packages", p.dir, "README.md"))),
      dts: await packageDts(p.dir),
    })),
  );

  // ---- per-package api/<name>.md ----
  for (const p of pkgs) {
    const md = [
      `# ${p.name}`,
      "",
      `> ${p.blurb}`,
      "",
      `\`npm install ${p.name}\` · [source](${REPO}/tree/main/packages/${p.dir})`,
      "",
      p.readme,
      "",
      "## Type definitions",
      "",
      "Generated from source — the authoritative public API.",
      "",
      "```ts",
      p.dts,
      "```",
      "",
    ].join("\n");
    await Bun.write(join(SITE, "api", `${slug(p.name)}.md`), md);
  }

  // ---- llms.txt (concise index) ----
  const llms = [
    "# swoosh",
    "",
    "> Just give me a model. Intent-driven, policy-driven model routing for TypeScript: declare what a task needs and how to choose; swoosh plans the best model, explains every rejection, and falls back automatically.",
    "",
    "swoosh is published as a set of scoped npm packages (`@swoosh-dev/*`). Start with `@swoosh-dev/sdk` for the batteries-included drop-in, or compose the zero-dependency `@swoosh-dev/router` core directly. Each package page below embeds its full, generated TypeScript API.",
    "",
    "## Packages",
    ...pkgs.map((p) => `- [${p.name}](${SITE_URL}/api/${slug(p.name)}.md): ${p.blurb}`),
    "",
    "## Examples",
    "Runnable, offline (simulated providers, no API keys):",
    ...examples.map(
      (e) => `- [${e.title}](${REPO}/blob/main/packages/model-router/examples/${e.file}): ${e.desc}`,
    ),
    "",
    "## Optional",
    `- [llms-full.txt](${SITE_URL}/llms-full.txt): the entire documentation — every README, full type signatures, and all example sources — in a single file.`,
    `- [GitHub repository](${REPO})`,
    "",
    "_Generated from source by `bun run docs`._",
    "",
  ].join("\n");
  await Bun.write(join(SITE, "llms.txt"), llms);

  // ---- llms-full.txt (everything, one fetch) ----
  const sep = "\n\n---\n\n";
  const full = [
    "# swoosh — complete documentation for LLMs",
    "",
    "> Just give me a model. Intent-driven, policy-driven model routing for TypeScript.",
    "",
    "This single file contains the project overview, every package's README, its complete generated TypeScript API (`.d.ts`), and the full source of every example. Generated from source by `bun run docs` — nothing here is hand-maintained, so signatures never drift.",
    sep,
    "## Overview",
    "",
    rootReadme,
    sep,
    "# Packages",
    ...pkgs.flatMap((p) => [
      sep,
      `## ${p.name}`,
      "",
      `> ${p.blurb}`,
      "",
      `Install: \`npm install ${p.name}\` · Source: ${REPO}/tree/main/packages/${p.dir}`,
      "",
      p.readme,
      "",
      `### ${p.name} — type definitions`,
      "",
      "```ts",
      p.dts,
      "```",
    ]),
    sep,
    "# Examples",
    "",
    "All examples run offline with simulated providers (no API keys). Run any with `bun packages/model-router/examples/<file>`.",
    ...examples.flatMap((e) => [
      sep,
      `## ${e.title}`,
      "",
      e.desc,
      "",
      "```ts",
      e.src,
      "```",
    ]),
    "",
  ].join("\n");
  await Bun.write(join(SITE, "llms-full.txt"), full);

  // ---- summary ----
  const kb = (s: string) => (Buffer.byteLength(s) / 1024).toFixed(1) + "KB";
  console.log("Generated agent docs in packages/model-router/site:");
  console.log(`  llms.txt         ${kb(llms)}`);
  console.log(`  llms-full.txt    ${kb(full)}  (${pkgs.length} packages, ${examples.length} examples)`);
  console.log(`  api/*.md         ${pkgs.length} files`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
