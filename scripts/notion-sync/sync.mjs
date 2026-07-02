// Notion → website sync (page mode).
//
// Reads the sub-pages of one parent Notion "Writing" page, converts each to
// HTML wrapped in the site's template, writes one <slug>.html per sub-page to
// the repo root, and refreshes the auto-managed block inside writing.html.
//
// - Page title      → the writing's title (and its URL slug).
// - Page created date → the date shown on the piece.
// - First paragraph → the one-line summary on the Writing index.
// - Sub-pages titled "Draft: ..." are skipped.
//
// Hand-written pages (on-education.html, manifest.html, etc.) are never touched.
// Only files this script generated carry the GENERATED_MARKER, and only those
// can be overwritten or deleted by it.

import { Client } from "@notionhq/client";
import { NotionToMarkdown } from "notion-to-md";
import { marked } from "marked";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const NOTION_TOKEN = process.env.NOTION_TOKEN;
// Accept the new name, but fall back to the old secret so nothing breaks if you
// simply change the value of the existing NOTION_DATABASE_ID secret.
const PARENT_PAGE_ID =
  process.env.NOTION_PARENT_PAGE_ID || process.env.NOTION_DATABASE_ID;

if (!NOTION_TOKEN || !PARENT_PAGE_ID) {
  console.error(
    "Missing env vars. Set NOTION_TOKEN and NOTION_PARENT_PAGE_ID (repo secrets)."
  );
  process.exit(1);
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..");
const INDEX_FILE = path.join(REPO_ROOT, "writing.html");
const STATE_FILE = path.join(__dirname, ".generated.json");

const GENERATED_MARKER = "<!-- generated-by: notion-sync — edits will be overwritten -->";
const BLOCK_START = "<!-- NOTION:START (auto-generated — do not edit between these markers) -->";
const BLOCK_END = "<!-- NOTION:END -->";

const notion = new Client({ auth: NOTION_TOKEN });
const n2m = new NotionToMarkdown({ notionClient: notion });

// ---------- helpers ----------

function escapeHtml(str = "") {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function escapeRegExp(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function slugify(text = "") {
  return text
    .toLowerCase()
    .trim()
    .replace(/['"]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function formatFullDate(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleDateString("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
    timeZone: "UTC",
  });
}

function yearOf(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : String(d.getUTCFullYear());
}

const isDraft = (title) => /^\s*(\[draft\]|draft\s*:)/i.test(title);

// Pull the first real paragraph out of the markdown to use as a summary.
function excerptFromMarkdown(md, maxLen = 160) {
  for (let line of md.split("\n")) {
    line = line.trim();
    if (!line) continue;
    if (/^(#{1,6}\s|!\[|[-*>|`])/.test(line)) continue; // skip headings/images/lists/quotes/tables/code
    const text = line
      .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1") // links/images -> their text
      .replace(/[*_`~]/g, "")
      .trim();
    if (!text) continue;
    return text.length > maxLen ? `${text.slice(0, maxLen - 1).trimEnd()}…` : text;
  }
  return "";
}

// ---------- Notion fetch ----------

// Direct child pages of the parent, in the order they appear in Notion.
async function fetchChildPages(parentId) {
  const pages = [];
  let cursor;
  do {
    const res = await notion.blocks.children.list({
      block_id: parentId,
      start_cursor: cursor,
      page_size: 100,
    });
    for (const block of res.results) {
      if (block.type === "child_page") {
        pages.push({
          id: block.id,
          title: block.child_page?.title || "",
          createdTime: block.created_time || null,
        });
      }
    }
    cursor = res.has_more ? res.next_cursor : undefined;
  } while (cursor);
  return pages;
}

async function pageToMarkdown(pageId) {
  const blocks = await n2m.pageToMarkdown(pageId);
  return n2m.toMarkdownString(blocks).parent || "";
}

// ---------- templates ----------

function articlePage({ title, dateISO, description, bodyHtml, slug }) {
  const url = `https://www.carolannejiang.com/${slug}.html`;
  const safeTitle = escapeHtml(title);
  const safeDesc = escapeHtml(description || "");
  const dateLabel = escapeHtml(formatFullDate(dateISO));

  return `<!DOCTYPE html>
${GENERATED_MARKER}
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${safeTitle} — Carolanne Jiang</title>
  <meta name="description" content="${safeDesc}">
  <meta property="og:type" content="article">
  <meta property="og:site_name" content="Carolanne Jiang">
  <meta property="og:title" content="${safeTitle}">
  <meta property="og:description" content="${safeDesc}">
  <meta property="og:url" content="${url}">
  <link rel="icon" href="favicon.ico" type="image/x-icon">
  <link rel="apple-touch-icon" href="apple-touch-icon.png">
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link rel="preload" as="style" href="https://fonts.googleapis.com/css2?family=Libre+Baskerville:ital,wght@0,400;0,700;1,400&display=swap">
  <link href="https://fonts.googleapis.com/css2?family=Libre+Baskerville:ital,wght@0,400;0,700;1,400&display=swap" rel="stylesheet" media="print" onload="this.media='all'">
  <noscript><link href="https://fonts.googleapis.com/css2?family=Libre+Baskerville:ital,wght@0,400;0,700;1,400&display=swap" rel="stylesheet"></noscript>
  <style>
    body {
      max-width: 640px;
      margin: 0 auto;
      padding: 60px 32px;
      line-height: 1.7;
      font-family: 'Libre Baskerville', Georgia, serif;
      color: #1a1a1a;
    }
    h1 { margin-bottom: 6px; font-size: 1.5rem; }
    .article-date {
      font-size: 0.68rem;
      letter-spacing: 0.14em;
      text-transform: uppercase;
      color: #a9a29a;
      margin-bottom: 36px;
    }
    .article-body p { margin-bottom: 18px; }
    .article-body h2 { margin: 32px 0 12px; font-size: 1.15rem; }
    .article-body h3 { margin: 28px 0 10px; font-size: 1rem; }
    .article-body ul, .article-body ol { margin: 0 0 18px 1.2em; }
    .article-body li { margin-bottom: 6px; }
    .article-body blockquote {
      margin: 0 0 18px; padding-left: 16px;
      border-left: 2px solid #c9c4bc; color: #555;
    }
    .article-body img { max-width: 100%; height: auto; }
    .article-body a { color: #1155cc; }
    .article-body a:hover { color: #0b3d91; }
    .back { display: inline-block; margin-top: 48px; color: #888; }
    .back:hover { color: #555; }
  </style>
</head>
<body>
  <main>
    <h1>${safeTitle}</h1>
    ${dateLabel ? `<div class="article-date">${dateLabel}</div>` : ""}
    <div class="article-body">
${bodyHtml}
    </div>
    <a class="back" href="writing.html">← back to writing</a>
  </main>
</body>
</html>
`;
}

function indexEntry({ title, slug, year, description }) {
  const meta = year ? `\n        <div class="entry-meta">${escapeHtml(year)}</div>` : "";
  const desc = description
    ? `\n        <div class="entry-desc">${escapeHtml(description)}</div>`
    : "";
  return `      <div class="entry">
        <a class="entry-title" href="${slug}.html">${escapeHtml(title)}</a>${meta}${desc}
      </div>`;
}

// ---------- index (writing.html) ----------

async function updateIndex(entries) {
  let html = await fs.readFile(INDEX_FILE, "utf8");

  const entriesHtml = entries.map(indexEntry).join("\n\n");
  const block = `${BLOCK_START}\n${entriesHtml}\n      ${BLOCK_END}`;

  if (html.includes(BLOCK_START) && html.includes(BLOCK_END)) {
    const re = new RegExp(
      `${escapeRegExp(BLOCK_START)}[\\s\\S]*?${escapeRegExp(BLOCK_END)}`
    );
    html = html.replace(re, block);
  } else {
    const anchor = '<div class="writing-title">Writing</div>';
    if (!html.includes(anchor)) {
      throw new Error(
        `Could not find the anchor '${anchor}' in writing.html to insert the Notion block.`
      );
    }
    html = html.replace(anchor, `${anchor}\n\n      ${block}`);
  }

  await fs.writeFile(INDEX_FILE, html);
}

// ---------- generated-file bookkeeping ----------

async function readState() {
  try {
    const data = JSON.parse(await fs.readFile(STATE_FILE, "utf8"));
    return Array.isArray(data.slugs) ? data.slugs : [];
  } catch {
    return [];
  }
}

async function writeState(slugs) {
  await fs.writeFile(
    STATE_FILE,
    `${JSON.stringify({ slugs: [...slugs].sort() }, null, 2)}\n`
  );
}

// Only delete a file if it exists AND carries our generated marker.
async function safeDelete(slug) {
  const file = path.join(REPO_ROOT, `${slug}.html`);
  try {
    const contents = await fs.readFile(file, "utf8");
    if (contents.includes(GENERATED_MARKER)) {
      await fs.unlink(file);
      console.log(`Removed (no longer published in Notion): ${slug}.html`);
    } else {
      console.warn(`Skipped deleting ${slug}.html — not a notion-sync file.`);
    }
  } catch {
    /* already gone */
  }
}

// ---------- main ----------

async function main() {
  const children = await fetchChildPages(PARENT_PAGE_ID);
  console.log(`Found ${children.length} sub-page(s) under the parent page.`);

  const seen = new Set();
  const entries = [];

  for (const child of children) {
    const title = (child.title || "").trim();
    if (!title) {
      console.warn("Skipping a sub-page with no title.");
      continue;
    }
    if (isDraft(title)) {
      console.log(`Skipping draft: "${title}"`);
      continue;
    }

    const slug = slugify(title);
    if (!slug) {
      console.warn(`Skipping "${title}" — title produced an empty slug.`);
      continue;
    }
    if (seen.has(slug)) {
      console.warn(`Duplicate slug "${slug}" from "${title}" — skipping later one.`);
      continue;
    }
    seen.add(slug);

    const md = await pageToMarkdown(child.id);
    const bodyHtml = marked.parse(md);
    const description = excerptFromMarkdown(md);
    const dateISO = child.createdTime;

    const pageHtml = articlePage({ title, dateISO, description, bodyHtml, slug });
    await fs.writeFile(path.join(REPO_ROOT, `${slug}.html`), pageHtml);
    console.log(`Wrote ${slug}.html  ("${title}")`);

    entries.push({ title, slug, description, year: yearOf(dateISO) });
  }

  // Keep the order you arranged the sub-pages in Notion.
  await updateIndex(entries);

  // Remove pages that were generated before but are no longer published.
  const previous = await readState();
  const current = new Set(entries.map((e) => e.slug));
  for (const oldSlug of previous) {
    if (!current.has(oldSlug)) await safeDelete(oldSlug);
  }
  await writeState(current);

  console.log("Sync complete.");
}

main().catch((err) => {
  console.error("Sync failed:", err);
  process.exit(1);
});
