// Notion → website sync.
//
// Reads every "Published" row from a Notion database, converts each page's body
// to HTML wrapped in the site's template, writes one <slug>.html per writing to
// the repo root, and refreshes the auto-managed block inside writing.html.
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
const DATABASE_ID = process.env.NOTION_DATABASE_ID;

if (!NOTION_TOKEN || !DATABASE_ID) {
  console.error(
    "Missing env vars. Set NOTION_TOKEN and NOTION_DATABASE_ID (repo secrets)."
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

function plainText(richText = []) {
  return richText.map((t) => t.plain_text).join("");
}

// Find the database's title-type property regardless of what it's named.
function readTitle(props) {
  for (const value of Object.values(props)) {
    if (value.type === "title") return plainText(value.title);
  }
  return "";
}

// Find a property by name, case-insensitively, tolerating a few common
// variants. Notion property names are case-sensitive in the API, so this saves
// the user from having to match capitalization exactly.
function findProp(props, names, type) {
  const wanted = names.map((n) => n.toLowerCase());
  for (const [key, value] of Object.entries(props)) {
    if (type && value.type !== type) continue;
    if (wanted.includes(key.toLowerCase())) return value;
  }
  return null;
}

function readRichText(props, names) {
  const p = findProp(props, names, "rich_text");
  return p ? plainText(p.rich_text) : "";
}

function readDate(props, names) {
  const p = findProp(props, names, "date");
  return p && p.date ? p.date.start : null; // ISO string, e.g. "2026-07-02"
}

// Returns true (publish), false (explicitly unchecked), or null (no gate column
// found — caller decides what that means).
function readPublished(props) {
  const p = findProp(props, ["Published", "Publish", "Public", "Live"], "checkbox");
  if (!p) return null;
  return p.checkbox === true;
}

function formatFullDate(iso) {
  if (!iso) return "";
  // Anchor to UTC so a date-only value doesn't shift across timezones.
  const d = new Date(`${iso.slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
    timeZone: "UTC",
  });
}

function yearOf(iso) {
  return iso ? iso.slice(0, 4) : "";
}

// ---------- Notion fetch ----------

async function fetchAllRows() {
  const rows = [];
  let cursor;
  do {
    const res = await notion.databases.query({
      database_id: DATABASE_ID,
      start_cursor: cursor,
    });
    rows.push(...res.results);
    cursor = res.has_more ? res.next_cursor : undefined;
  } while (cursor);
  return rows;
}

async function pageToHtml(pageId) {
  const blocks = await n2m.pageToMarkdown(pageId);
  const md = n2m.toMarkdownString(blocks).parent || "";
  return marked.parse(md);
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
  const desc = description
    ? `\n        <div class="entry-desc">${escapeHtml(description)}</div>`
    : "";
  const meta = year ? `\n        <div class="entry-meta">${escapeHtml(year)}</div>` : "";
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
    // First run: insert the managed block right after the "Writing" heading so
    // Notion posts appear above any hand-written entries below it.
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
    const raw = await fs.readFile(STATE_FILE, "utf8");
    const data = JSON.parse(raw);
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
      console.log(`Removed (unpublished/deleted in Notion): ${slug}.html`);
    } else {
      console.warn(
        `Skipped deleting ${slug}.html — not a notion-sync generated file.`
      );
    }
  } catch {
    /* already gone */
  }
}

// ---------- main ----------

async function main() {
  const rows = await fetchAllRows();
  console.log(`Fetched ${rows.length} row(s) from Notion.`);

  const seen = new Set();
  const entries = [];
  let gateMissingWarned = false;

  for (const row of rows) {
    const props = row.properties;

    // Publish gate: skip rows explicitly unchecked. If there's no Published
    // column at all, publish everything but warn loudly (once).
    const published = readPublished(props);
    if (published === false) continue;
    if (published === null && !gateMissingWarned) {
      console.warn(
        "No 'Published' checkbox column found — publishing ALL rows. " +
          "Add a checkbox column named 'Published' to control what goes live."
      );
      gateMissingWarned = true;
    }

    const title = readTitle(props) || "Untitled";
    let slug = readRichText(props, ["Slug", "URL", "Path"]).trim() || slugify(title);
    slug = slugify(slug);

    if (!slug) {
      console.warn(`Skipping a row with no usable title/slug: "${title}"`);
      continue;
    }
    if (seen.has(slug)) {
      console.warn(`Duplicate slug "${slug}" — skipping the later one.`);
      continue;
    }
    seen.add(slug);

    const description = readRichText(props, ["Description", "Summary", "Subtitle"]);
    const dateISO = readDate(props, ["Date", "Published", "Published on", "Date published"]);

    const bodyHtml = await pageToHtml(row.id);
    const pageHtml = articlePage({ title, dateISO, description, bodyHtml, slug });
    await fs.writeFile(path.join(REPO_ROOT, `${slug}.html`), pageHtml);
    console.log(`Wrote ${slug}.html`);

    entries.push({ title, slug, description, dateISO, year: yearOf(dateISO) });
  }

  // Newest first; undated entries sink to the bottom.
  entries.sort((a, b) => (b.dateISO || "").localeCompare(a.dateISO || ""));

  await updateIndex(entries);

  // Remove pages that were previously generated but are no longer published.
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
