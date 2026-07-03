// Notion → website sync.
//
// Reads essays from one Notion source — either a database (Table view, where
// each row is a page) or a plain page whose sub-pages are the essays — converts
// each to HTML wrapped in the site's template, writes one <slug>.html per essay
// to the repo root, and refreshes the auto-managed block inside writing.html.
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
import sharp from "sharp";
import heicConvert from "heic-convert";
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

// Track whether the current essay had a Table-of-Contents block (→ left menu).
// Reset before rendering each essay.
let tocSeen = false;

// Render toggles ourselves so their content ends up INSIDE a collapsed
// <details> (letting notion-to-md + marked handle it produces broken, spilled
// markup). We emit a placeholder carrying the summary + already-rendered child
// HTML, expanded after conversion (see replaceToggles). Children are rendered
// with a FRESH converter — reusing the outer instance reentrantly corrupts its
// state and drops the block.
async function toggleTransformer(block) {
  const summary = plainText(block.toggle?.rich_text || []);
  let childHtml = "";
  if (block.has_children) {
    try {
      const inner = makeConverter();
      const childMd = inner.toMarkdownString(untoggle(await inner.pageToMarkdown(block.id))).parent || "";
      childHtml = marked.parse(childMd);
    } catch (err) {
      console.warn(`  toggle "${summary.slice(0, 40)}" render error: ${err.message}`);
    }
  }
  const payload = Buffer.from(JSON.stringify({ summary, childHtml }), "utf8").toString("base64");
  return `\n\n@@TOGGLE:${payload}@@\n\n`;
}

const YOUTUBE_ID = /(?:youtube\.com\/(?:watch\?v=|embed\/|shorts\/)|youtu\.be\/)([\w-]{11})/;

// Render Notion video/embed blocks like manifest.html: a responsive iframe for
// YouTube, otherwise a plain link. Emitted as a raw-HTML placeholder so marked
// leaves the markup intact (see replaceRawHtml).
async function videoTransformer(block) {
  const v = block[block.type] || {};
  const url = v.external?.url || v.url || v.file?.url || "";
  if (!url) return "";
  const title = escapeHtml((await fetchLinkTitle(url)) || "video");
  const href = escapeHtml(url);
  const yt = url.match(YOUTUBE_ID)?.[1];
  const html = yt
    ? `<figure class="video-embed"><div class="frame"><iframe src="https://www.youtube.com/embed/${yt}" title="${title}" loading="lazy" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share" allowfullscreen></iframe></div><a href="${href}" target="_blank" rel="noreferrer">${title}</a></figure>`
    : `<figure class="video-embed"><a href="${href}" target="_blank" rel="noreferrer">${title}</a></figure>`;
  const payload = Buffer.from(JSON.stringify({ html }), "utf8").toString("base64");
  return `\n\n@@HTML:${payload}@@\n\n`;
}

// Notion now supports heading_4, but notion-to-md's switch only knows
// heading_1/2/3 and would render heading_4 as plain text (losing the heading).
// Emit proper markdown; inline any children (rare toggleable-heading case).
async function heading4Transformer(block) {
  const text = plainText(block.heading_4?.rich_text || []);
  let childMd = "";
  if (block.has_children) {
    try {
      const inner = makeConverter();
      const c = inner.toMarkdownString(untoggle(await inner.pageToMarkdown(block.id))).parent || "";
      if (c.trim()) childMd = `\n\n${c}`;
    } catch {
      /* ignore */
    }
  }
  return `\n\n#### ${text}${childMd}\n\n`;
}

// A NotionToMarkdown configured with our custom block handling. We follow
// nested/linked pages ourselves (see pageToMarkdown), so child_page/
// link_to_page render nothing here; table_of_contents flags the left menu.
function makeConverter() {
  const inst = new NotionToMarkdown({ notionClient: notion });
  inst.setCustomTransformer("child_page", async () => "");
  inst.setCustomTransformer("link_to_page", async () => "");
  inst.setCustomTransformer("table_of_contents", async () => {
    tocSeen = true;
    return "";
  });
  inst.setCustomTransformer("toggle", toggleTransformer);
  inst.setCustomTransformer("video", videoTransformer);
  inst.setCustomTransformer("embed", videoTransformer);
  inst.setCustomTransformer("heading_4", heading4Transformer);
  // Emit dividers as explicit <hr>. As markdown "---" right after a text line,
  // marked would misread the text as a Setext <h2> heading.
  inst.setCustomTransformer("divider", async () => "\n\n<hr>\n\n");
  return inst;
}

const n2m = makeConverter();

// Expand toggle placeholders into collapsed <details> blocks, unwrapping any
// <p> or <pre><code> that marked may have put around the placeholder, and
// recursing so nested toggles work too.
function replaceToggles(html) {
  const expanded = html.replace(/@@TOGGLE:([A-Za-z0-9+/=]+)@@/g, (m, b64) => {
    let data;
    try {
      data = JSON.parse(Buffer.from(b64, "base64").toString("utf8"));
    } catch {
      return "";
    }
    const inner = replaceToggles(data.childHtml || "");
    return `<details><summary>${escapeHtml(data.summary || "")}</summary>\n${inner}\n</details>`;
  });
  return expanded
    .replace(/<p>\s*(<details>)/g, "$1")
    .replace(/(<\/details>)\s*<\/p>/g, "$1")
    .replace(/<pre><code>\s*(<details>[\s\S]*?<\/details>)\s*<\/code><\/pre>/g, "$1");
}

// Expand raw-HTML placeholders (e.g. video embeds), unwrapping the <p> marked
// wraps them in.
function replaceRawHtml(html) {
  return html
    .replace(/@@HTML:([A-Za-z0-9+/=]+)@@/g, (m, b64) => {
      try {
        return JSON.parse(Buffer.from(b64, "base64").toString("utf8")).html || "";
      } catch {
        return "";
      }
    })
    .replace(/<p>\s*(<figure)/g, "$1")
    .replace(/(<\/figure>)\s*<\/p>/g, "$1");
}

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

// --- database-row property helpers (only used when the source is a table) ---

function plainText(richText = []) {
  return richText.map((t) => t.plain_text).join("");
}

// The database's title-type property, whatever it's named.
function readTitle(props) {
  for (const value of Object.values(props)) {
    if (value.type === "title") return plainText(value.title);
  }
  return "";
}

// Read a rich-text/url property by name (case-insensitive), e.g. Slug.
function readRichText(props, names) {
  const wanted = names.map((n) => n.toLowerCase());
  for (const [key, value] of Object.entries(props)) {
    if (!wanted.includes(key.toLowerCase())) continue;
    if (value.type === "rich_text") return plainText(value.rich_text);
    if (value.type === "url") return value.url || "";
  }
  return "";
}

// Optional Published checkbox: true / false, or null if there's no such column.
function readPublished(props) {
  for (const [key, value] of Object.entries(props)) {
    if (value.type !== "checkbox") continue;
    if (/^(published|publish|public|live)$/i.test(key)) return value.checkbox === true;
  }
  return null;
}

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

// ---------- images ----------

// Notion serves uploaded images via temporary signed URLs that expire in ~1h.
// These hosts are the ones we must download and self-host so they don't break.
const isNotionAsset = (url) =>
  /amazonaws\.com|notion\.so|notion-static|notionusercontent|secure\.notion/i.test(url);

function extFromUrl(url) {
  try {
    const ext = path.extname(new URL(url).pathname).toLowerCase();
    if (/^\.(png|jpe?g|gif|webp|svg|avif)$/.test(ext)) return ext;
  } catch {
    /* fall through */
  }
  return ".png";
}

// Max rendered width the article column ever uses is ~680px; 1600px covers
// high-DPI (retina) displays with margin while shrinking huge originals.
const IMAGE_MAX_WIDTH = 1600;
const WEBP_QUALITY = 82;

async function toWebp(input) {
  return sharp(input)
    .rotate() // respect EXIF orientation before metadata is dropped
    .resize({ width: IMAGE_MAX_WIDTH, withoutEnlargement: true })
    .webp({ quality: WEBP_QUALITY })
    .toBuffer();
}

// Downscale + re-encode to WebP. Identical at display size, a fraction of the
// bytes. SVG/GIF pass through untouched (vector / animation). iPhone HEIC files
// (which sharp can't decode) are first converted to JPEG via heic-convert.
async function optimizeImage(buf, srcExt) {
  if (srcExt === ".svg" || srcExt === ".gif") return { out: buf, ext: srcExt };
  let webp = null;
  try {
    webp = await toWebp(buf);
  } catch {
    try {
      const jpeg = await heicConvert({ buffer: buf, format: "JPEG", quality: 0.92 });
      webp = await toWebp(Buffer.from(jpeg));
    } catch {
      webp = null; // not a raster image we can handle — keep original
    }
  }
  return webp && webp.length < buf.length ? { out: webp, ext: ".webp" } : { out: buf, ext: srcExt };
}

// Download every Notion-hosted image referenced in the HTML into
// images/notion/<slug>/, optimize it, and rewrite the <img src> to that local
// path — so the essay's images are permanent (Notion links expire in ~1h) and
// lightweight. The folder is rebuilt each run; identical inputs yield identical
// bytes, so repeat runs create no git churn.
async function localizeImages(html, slug) {
  const urls = [];
  const re = /<img\b[^>]*?\ssrc="([^"]+)"/gi;
  let m;
  while ((m = re.exec(html)) !== null) urls.push(m[1]);
  if (!urls.length) return html;

  const dir = path.join(REPO_ROOT, "images", "notion", slug);
  await fs.rm(dir, { recursive: true, force: true }); // drop stale/renamed files
  await fs.mkdir(dir, { recursive: true });

  let out = html;
  let i = 0;
  let rawTotal = 0;
  let optTotal = 0;
  for (const url of urls) {
    if (!/^https?:/i.test(url) || !isNotionAsset(url)) continue; // skip local/external
    i += 1;
    try {
      const res = await fetch(url);
      if (!res.ok) {
        console.warn(`  image ${i} download failed (HTTP ${res.status}) — left as-is`);
        continue;
      }
      const buf = Buffer.from(await res.arrayBuffer());
      const { out: optimized, ext } = await optimizeImage(buf, extFromUrl(url));
      const rel = `images/notion/${slug}/img-${i}${ext}`;
      await fs.writeFile(path.join(REPO_ROOT, rel), optimized);
      out = out.split(url).join(rel);
      rawTotal += buf.length;
      optTotal += optimized.length;
      console.log(
        `  image ${i}: ${rel} (${(buf.length / 1048576).toFixed(1)}MB → ${(optimized.length / 1048576).toFixed(2)}MB)`
      );
    } catch (err) {
      console.warn(`  image ${i} error (${err.message}) — left as-is`);
    }
  }
  if (i) {
    console.log(
      `  images: ${(rawTotal / 1048576).toFixed(1)}MB → ${(optTotal / 1048576).toFixed(1)}MB total`
    );
  }
  return out;
}

// ---------- link titles ----------

function decodeEntities(s) {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&(#39|#x27|apos);/gi, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#8217;|&rsquo;/gi, "’")
    .replace(/&nbsp;/gi, " ");
}

// Fetch a page and return its title (og:title preferred, else <title>).
async function fetchLinkTitle(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8000);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      redirect: "follow",
      headers: { "user-agent": "Mozilla/5.0 (compatible; cmykhub-site-sync)" },
    });
    if (!res.ok) return null;
    const html = await res.text();
    const og =
      html.match(/<meta[^>]+property=["']og:title["'][^>]*content=["']([^"']+)["']/i) ||
      html.match(/<meta[^>]+content=["']([^"']+)["'][^>]*property=["']og:title["']/i);
    let title = og?.[1] || html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || "";
    title = decodeEntities(title).replace(/\s+/g, " ").trim();
    return title || null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// Replace links whose visible text is just the raw URL with the linked page's
// title. Links you gave custom text to are left exactly as-is.
async function nameBareLinks(html) {
  const anchorRe = /<a href="([^"]+)">([\s\S]*?)<\/a>/g;
  const bareUrls = new Set();
  for (const [, href, text] of html.matchAll(anchorRe)) {
    if (/^https?:\/\//i.test(text.replace(/<[^>]+>/g, "").trim())) bareUrls.add(href);
  }
  if (!bareUrls.size) return html;

  const titles = new Map();
  await Promise.all(
    [...bareUrls].map(async (u) => titles.set(u, await fetchLinkTitle(u)))
  );

  return html.replace(anchorRe, (m, href, text) => {
    if (!/^https?:\/\//i.test(text.replace(/<[^>]+>/g, "").trim())) return m; // custom text
    const title = titles.get(href);
    return title ? `<a href="${href}">${escapeHtml(title)}</a>` : m;
  });
}

// ---------- Notion fetch ----------

// Each essay as { id, title, createdTime, published }. Works whether the source
// is a database (Table view — each row is a page) or a plain page whose
// sub-pages are the essays. `published` is null unless a table has a Published
// checkbox column.
async function fetchEntries(id) {
  // Try treating it as a database (table) first.
  try {
    const rows = [];
    let cursor;
    do {
      const res = await notion.databases.query({
        database_id: id,
        start_cursor: cursor,
      });
      rows.push(...res.results);
      cursor = res.has_more ? res.next_cursor : undefined;
    } while (cursor);
    console.log(`Source is a database — found ${rows.length} row(s).`);
    return rows.map((r) => ({
      id: r.id,
      title: readTitle(r.properties),
      createdTime: r.created_time || null,
      published: readPublished(r.properties),
      slug: readRichText(r.properties, ["Slug", "URL", "Path"]),
    }));
  } catch (err) {
    // Not a database — fall through to page mode. Any other error is real.
    if (err.code !== "object_not_found" && err.code !== "validation_error") {
      throw err;
    }
  }

  // Plain page: its direct child pages, in Notion order.
  const pages = [];
  let cursor;
  do {
    const res = await notion.blocks.children.list({
      block_id: id,
      start_cursor: cursor,
      page_size: 100,
    });
    for (const block of res.results) {
      if (block.type === "child_page") {
        pages.push({
          id: block.id,
          title: block.child_page?.title || "",
          createdTime: block.created_time || null,
          published: null,
          slug: "",
        });
      }
    }
    cursor = res.has_more ? res.next_cursor : undefined;
  } while (cursor);
  console.log(`Source is a page — found ${pages.length} sub-page(s).`);
  return pages;
}

// Pages referenced from inside a page: real sub-pages (child_page) and
// "link to page" blocks that point at another page. Titles come along when
// Notion gives them (child_page blocks include the title).
async function linkedPages(pageId) {
  const out = [];
  let cursor;
  do {
    const res = await notion.blocks.children.list({
      block_id: pageId,
      start_cursor: cursor,
      page_size: 100,
    });
    for (const b of res.results) {
      if (b.type === "child_page") {
        out.push({ id: b.id, title: b.child_page?.title || "" });
      } else if (b.type === "link_to_page" && b.link_to_page?.type === "page_id") {
        out.push({ id: b.link_to_page.page_id, title: "" });
      }
    }
    cursor = res.has_more ? res.next_cursor : undefined;
  } while (cursor);
  return out;
}

// Title of a standalone page (used for "link to page" targets, whose title
// isn't carried on the link block itself).
async function pageTitle(pageId) {
  try {
    const page = await notion.pages.retrieve({ page_id: pageId });
    return readTitle(page.properties || {});
  } catch {
    return "";
  }
}

// Markdown for a page, inlining the content of any pages nested or linked
// inside it (up to two levels deep). This means an essay you wrote in a nested
// sub-page — or in a separate page you linked to — still gets pulled in fully
// instead of showing up as just a link.
// notion-to-md's toMarkdownString special-cases toggle blocks and drops our
// custom-transformer output (the placeholder) unless it recursed the children
// itself. Retyping toggle nodes to "paragraph" makes it emit our placeholder as
// ordinary content. (Safe: our toggle transformer already produced the parent.)
function untoggle(blocks) {
  for (const b of blocks) {
    if (b.type === "toggle") b.type = "paragraph";
    if (b.children?.length) untoggle(b.children);
  }
  return blocks;
}

async function pageToMarkdown(pageId, depth = 0, seen = new Set()) {
  if (seen.has(pageId)) return "";
  seen.add(pageId);
  const own = (n2m.toMarkdownString(untoggle(await n2m.pageToMarkdown(pageId))).parent || "").trim();
  const parts = own ? [own] : [];
  if (depth < 2) {
    for (const child of await linkedPages(pageId)) {
      const sub = await pageToMarkdown(child.id, depth + 1, seen);
      if (sub.trim()) parts.push(sub);
    }
  }
  return parts.join("\n\n");
}

// ---------- templates ----------

// The article CSS lives in article.css (edit it to restyle generated pages).
// It's a dedicated file — not read back from a generated page — so edits are
// stable and never duplicated.
async function siteStyle() {
  try {
    return await fs.readFile(path.join(__dirname, "article.css"), "utf8");
  } catch {
    /* fall through to minimal fallback */
  }
  return `
    body { max-width: 680px; margin: 0 auto; padding: 40px 28px; color: #1a1a1a;
      font-family: 'Libre Baskerville', Georgia, serif; line-height: 1.75; }
    .site-nav { display: flex; gap: 20px; margin-bottom: 24px; }
    .site-nav a { color: #595959; text-decoration: none; font-size: 0.78rem; }
    .side { display: none; }
    figure { margin: 1.6em 0; text-align: center; }
    figure img, img { max-width: 100%; height: auto; }
    .footer-nav { margin-top: 72px; padding-top: 20px; border-top: 1px solid #ece8e1; }`;
}

// marked renders a lone image as <p><img></p>; turn those into
// <figure class="image"> with a click-to-open link wrapper (and a caption when
// the image has meaningful alt text), matching manifest.html.
function wrapFigures(html) {
  return html.replace(/<p>\s*<img\b([^>]*)>\s*<\/p>/gi, (_m, attrs) => {
    const src = attrs.match(/\bsrc="([^"]*)"/i)?.[1] || "";
    const alt = decodeEntities((attrs.match(/\balt="([^"]*)"/i)?.[1] || "")).trim();
    const caption =
      alt && !/\.(png|jpe?g|gif|webp|svg|avif)$/i.test(alt)
        ? `<figcaption>${escapeHtml(alt)}</figcaption>`
        : "";
    return `<figure class="image"><a href="${src}"><img src="${src}"/></a>${caption}</figure>`;
  });
}

// Give headings (h2/h3/h4, as Notion's heading_2/3/4 map directly) stable ids
// and a class, and collect a table of contents.
function addTocAndIds(html) {
  const toc = [];
  const used = new Set();
  const out = html.replace(/<h([234])>([\s\S]*?)<\/h\1>/gi, (m, lvl, inner) => {
    // Decode entities from the heading HTML so the TOC text isn't double-encoded
    // (e.g. "&amp;" → "&") and the slug is clean.
    const text = decodeEntities(inner.replace(/<[^>]+>/g, "")).trim();
    if (!text) return m;
    const level = Number(lvl);
    let id = slugify(text) || "section";
    const base = id;
    let n = 2;
    while (used.has(id)) id = `${base}-${n++}`;
    used.add(id);
    toc.push({ level, text, id });
    return `<h${level} id="${id}" class="">${inner}</h${level}>`;
  });
  return { html: out, toc };
}

function tocItemsHtml(toc) {
  if (!toc.length) return "";
  return toc
    .map((t) => {
      const indent = Math.min(t.level - 2, 1); // h2→0, h3/h4→1 (like manifest)
      return `      <div class="table_of_contents-item table_of_contents-indent-${indent}"><a class="table_of_contents-link" href="#${t.id}">${escapeHtml(t.text)}</a></div>`;
    })
    .join("\n");
}

function articlePage({ title, description, bodyHtml, tocHtml, slug, style }) {
  const url = `https://www.carolannejiang.com/${slug}.html`;
  const safeTitle = escapeHtml(title);
  const safeDesc = escapeHtml(description || "");
  const side = tocHtml
    ? `  <aside class="side">
    <div class="toc-label">Contents</div>
    <nav class="block-color-gray table_of_contents">
${tocHtml}
    </nav>
  </aside>
`
    : "";

  return `<!DOCTYPE html>
${GENERATED_MARKER}
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${safeTitle}</title>
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
  <style>${style}</style>
</head>
<body>

<nav class="site-nav" aria-label="Site links">
  <a href="index.html">home</a>
  <a href="mailto:carolannejiang@gmail.com">email</a>
  <a href="https://www.linkedin.com/in/carolanne-j-87a0b329a/" target="_blank" rel="noreferrer">linkedin</a>
</nav>
<div class="layout">
${side}
  <main class="article">
<header><h1 class="page-title" dir="auto">${safeTitle}</h1><p class="page-description" dir="auto"></p></header>
<div class="page-body">
${bodyHtml}
</div>
  <div class="footer-nav"><a href="index.html">← back to home</a></div>
  </main>
  </div>

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
      await fs.rm(path.join(REPO_ROOT, "images", "notion", slug), {
        recursive: true,
        force: true,
      });
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
  const items = await fetchEntries(PARENT_PAGE_ID);
  const style = await siteStyle();

  const seen = new Set();
  const entries = [];

  for (const item of items) {
    if (item.published === false) continue; // Published checkbox unchecked

    let title = (item.title || "").trim();

    // If the row/page has no title of its own, borrow it from the first page it
    // links to or nests — handy when a table row just points at an essay page.
    const linked = await linkedPages(item.id);
    if (!title && linked.length) {
      title = (linked[0].title || (await pageTitle(linked[0].id)) || "").trim();
    }

    if (!title) {
      console.warn("Skipping an entry with no title (and no linked page to borrow one from).");
      continue;
    }
    if (isDraft(title)) {
      console.log(`Skipping draft: "${title}"`);
      continue;
    }

    // Use the Notion Slug property if set, otherwise derive from the title.
    const slug = slugify(item.slug?.trim() || title);
    if (!slug) {
      console.warn(`Skipping "${title}" — title produced an empty slug.`);
      continue;
    }
    if (seen.has(slug)) {
      console.warn(`Duplicate slug "${slug}" from "${title}" — skipping later one.`);
      continue;
    }
    seen.add(slug);

    tocSeen = false;
    let md = await pageToMarkdown(item.id);
    // Empty Notion bullets render as a lone "- ", which marked misreads as a
    // Setext heading underline (turning the text above into an <h2>). Drop
    // empty list-item lines.
    md = md.replace(/^[ \t]*[-*+][ \t]*$/gm, "").replace(/^[ \t]*\d+\.[ \t]*$/gm, "");
    let bodyHtml = marked.parse(md);
    bodyHtml = replaceToggles(bodyHtml); // collapsed <details>, content inside
    bodyHtml = replaceRawHtml(bodyHtml); // video embeds
    bodyHtml = await localizeImages(bodyHtml, slug); // also localizes toggle images
    bodyHtml = wrapFigures(bodyHtml);
    bodyHtml = await nameBareLinks(bodyHtml);
    bodyHtml = bodyHtml
      .replace(/<ul>/g, '<ul class="bulleted-list">')
      .replace(/<ol>/g, '<ol class="numbered-list">'); // match manifest.html classes
    const withToc = addTocAndIds(bodyHtml);
    const description = excerptFromMarkdown(md);
    const dateISO = item.createdTime;

    const pageHtml = articlePage({
      title,
      description,
      bodyHtml: withToc.html,
      // Only show the left menu when the Notion doc has a Contents block.
      tocHtml: tocSeen ? tocItemsHtml(withToc.toc) : "",
      slug,
      style,
    });
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
