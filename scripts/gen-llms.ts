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
//   - examples.html   browsable example gallery (reuses docs.html's theme/CSS)
//
// The hand-crafted human docs (index.html, docs.html) are left untouched;
// examples.html borrows docs.html's <style> block so it can't drift visually.

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

const escapeHtml = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

// Minimal TS tokenizer -> the same .tk-* classes the hand-authored code blocks
// use, so generated examples highlight identically with zero runtime deps.
const TS_KEYWORDS = new Set([
  "import", "export", "from", "as", "const", "let", "var", "function", "return",
  "await", "async", "new", "class", "extends", "implements", "interface", "type",
  "enum", "namespace", "declare", "if", "else", "for", "of", "in", "while", "do",
  "switch", "case", "break", "continue", "default", "try", "catch", "finally",
  "throw", "typeof", "instanceof", "keyof", "infer", "satisfies", "readonly", "is",
  "public", "private", "protected", "static", "get", "set", "this", "super", "void",
  "yield", "true", "false", "null", "undefined", "abstract",
]);
function highlightTs(src: string): string {
  const re = /(\/\/[^\n]*|\/\*[\s\S]*?\*\/)|(`(?:\\[\s\S]|[^`\\])*`|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')|(\b\d[\w.]*\b)|([A-Za-z_$][\w$]*)/g;
  let out = "";
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    out += escapeHtml(src.slice(last, m.index));
    const tok = m[0];
    if (m[1]) out += `<span class="tk-c">${escapeHtml(tok)}</span>`;
    else if (m[2]) out += `<span class="tk-s">${escapeHtml(tok)}</span>`;
    else if (m[3]) out += `<span class="tk-n">${escapeHtml(tok)}</span>`;
    else if (TS_KEYWORDS.has(tok)) out += `<span class="tk-k">${escapeHtml(tok)}</span>`;
    else if (/^[A-Z]/.test(tok)) out += `<span class="tk-t">${escapeHtml(tok)}</span>`;
    else out += escapeHtml(tok);
    last = re.lastIndex;
  }
  out += escapeHtml(src.slice(last));
  return out;
}
// "01-quickstart" -> "Quickstart", "11-llm-judge" -> "LLM judge"
const ACRONYMS: Record<string, string> = { llm: "LLM", ai: "AI", sdk: "SDK", api: "API", db: "DB" };
const prettyTitle = (title: string) =>
  title
    .replace(/^\d+-/, "")
    .split("-")
    .map((w, i) => ACRONYMS[w] ?? (i === 0 ? w[0].toUpperCase() + w.slice(1) : w))
    .join(" ");
const exNum = (title: string) => (title.match(/^(\d+)/) || ["", ""])[1];
// the "sweep" logo mark, matching the landing page / docs header
const SWEEP_SVG =
  '<svg width="26" height="26" viewBox="0 0 26 26" fill="none"><path d="M4.5 19.5 C 11 19.5, 13.5 9, 19 7" stroke="#e8490f" stroke-width="3" stroke-linecap="round"/><g transform="translate(19 7) rotate(-18)"><path d="M6.5 0 L -2 -3.6 L -2 3.6 Z" fill="#e8490f"/></g></svg>';

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

  // ---- examples.html (browsable gallery; reuses the docs theme so it never drifts) ----
  const docsHtml = await read(join(SITE, "docs.html"));
  const styleBlock = (docsHtml.match(/<style>[\s\S]*?<\/style>/) || [""])[0];
  const fontLinks = (docsHtml.match(/<link[^>]*(?:fonts\.|preconnect)[^>]*>/g) || []).join("\n");
  const exId = (e: { title: string }) => `ex-${e.title}`;
  const exHtml = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>swoosh examples — just give me a model</title>
<meta name="description" content="Eleven runnable, offline examples for swoosh: intent + policy routing, cost guardrails, multimodal, outage fallback, bring-your-own catalog, model access, web search, load balancing, benchmark routing, and an LLM judge." />
<link rel="alternate" type="text/markdown" href="llms.txt" title="LLM-friendly docs (llms.txt)" />
${fontLinks}
${styleBlock}
</head>
<body>
<header>
  <div class="bar">
    <a class="wm" href="index.html">${SWEEP_SVG}swoosh<span class="tag">examples</span></a>
    <nav class="top">
      <button class="menu-btn" id="menuBtn" type="button">Menu</button>
      <a href="index.html">Home</a>
      <a href="docs.html">Docs</a>
      <a href="llms.txt">llms.txt</a>
      <a class="gh" href="${REPO}">GitHub ↗</a>
    </nav>
  </div>
</header>
<div class="shell">
  <aside id="sidebar">
    <div class="group">
      <span>Examples</span>
      ${examples.map((e) => `<a href="#${exId(e)}">${exNum(e.title)} · ${prettyTitle(e.title)}</a>`).join("\n      ")}
    </div>
    <div class="group">
      <span>More</span>
      <a href="docs.html">Documentation</a>
      <a href="llms.txt">Agent docs (llms.txt)</a>
    </div>
  </aside>
  <main>
    <div class="doc-hero">
      <h1>Examples</h1>
      <p>${examples.length} runnable scripts that exercise swoosh end to end. They run offline with simulated providers — no API keys — so you can read, run, and tweak them immediately. From the repo root: <code>bun packages/model-router/examples/&lt;file&gt;</code>.</p>
    </div>
    ${examples
      .map(
        (e) => `<section class="doc" id="${exId(e)}">
      <h2><span class="no">${exNum(e.title)}</span> ${prettyTitle(e.title)}</h2>
      <p class="lead">${escapeHtml(e.desc)}</p>
      <p><code>bun packages/model-router/examples/${e.file}</code> &middot; <a class="inline" href="${REPO}/blob/main/packages/model-router/examples/${e.file}">View source &#8599;</a></p>
      <pre><code>${highlightTs(e.src)}</code></pre>
    </section>`,
      )
      .join("\n    ")}
  </main>
</div>
<footer>
  <div class="foot">
    <span>&copy; 2026 swoosh contributors &middot; Apache-2.0</span>
    <span>zero dependencies &middot; <a href="docs.html">docs</a> &middot; <a href="llms.txt">llms.txt</a> &middot; catalog by <a href="https://models.dev">models.dev</a></span>
  </div>
</footer>
<script>
  const sidebar = document.getElementById("sidebar");
  document.getElementById("menuBtn").addEventListener("click", () => sidebar.classList.toggle("open"));
  sidebar.addEventListener("click", (e) => { if (e.target.tagName === "A") sidebar.classList.remove("open"); });
  const links = [...document.querySelectorAll("aside a")].filter((a) => a.getAttribute("href").startsWith("#"));
  const byId = new Map(links.map((a) => [a.getAttribute("href").slice(1), a]));
  const sections = [...document.querySelectorAll("section.doc")];
  const setActive = () => {
    const y = window.scrollY + 90;
    let cur = sections[0];
    for (const s of sections) if (s.offsetTop <= y) cur = s;
    links.forEach((a) => a.classList.remove("active"));
    if (cur) byId.get(cur.id)?.classList.add("active");
  };
  window.addEventListener("scroll", setActive, { passive: true });
  setActive();
</script>
</body>
</html>
`;
  await Bun.write(join(SITE, "examples.html"), exHtml);

  // ---- summary ----
  const kb = (s: string) => (Buffer.byteLength(s) / 1024).toFixed(1) + "KB";
  console.log("Generated agent docs in packages/model-router/site:");
  console.log(`  llms.txt         ${kb(llms)}`);
  console.log(`  llms-full.txt    ${kb(full)}  (${pkgs.length} packages, ${examples.length} examples)`);
  console.log(`  api/*.md         ${pkgs.length} files`);
  console.log(`  examples.html    ${kb(exHtml)}  (${examples.length} examples)`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
