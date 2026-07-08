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
// Hand-written pages (index.html, art.html, etc.) are never touched. Only
// files this script generated carry the GENERATED_MARKER, and only those can
// be overwritten or deleted by it — an essay whose slug collides with a
// hand-written page is skipped with a warning instead of clobbering it.

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

// Cusdis comments (https://cusdis.com). Paste the "App ID" from your Cusdis
// dashboard between the quotes to show a comment box at the bottom of every
// essay. Leave it empty and no comment box is rendered (the site is unchanged).
// Self-hosting Cusdis instead of the hosted app? Point CUSDIS_HOST at it.
//
// The comment UI is rendered natively in the page (form + thread, styled in
// article.css) and talks to Cusdis's open API directly — the same
// GET/POST /api/open/comments the official iframe widget uses — so comments
// match the site's typography. Moderation is unchanged: new comments stay
// hidden until approved in the Cusdis dashboard.
const CUSDIS_APP_ID = "16dbe1dd-67b3-49bb-b2fa-a0e81cd9080f";
const CUSDIS_HOST = "https://cusdis.com";

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
  const title = escapeHtml((await cachedLinkTitle(url)) || "video");
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

// Render Notion column layouts side-by-side (like Notion / manifest.html)
// instead of stacking. Each column's content is rendered with a fresh
// converter and wrapped in .column-list / .column (styled in article.css).
async function columnListTransformer(block) {
  let columns = [];
  try {
    const res = await notion.blocks.children.list({ block_id: block.id, page_size: 100 });
    columns = res.results.filter((b) => b.type === "column");
  } catch {
    return "";
  }
  const colHtml = [];
  for (const col of columns) {
    try {
      const inner = makeConverter();
      const md = inner.toMarkdownString(untoggle(await inner.pageToMarkdown(col.id))).parent || "";
      colHtml.push(`<div class="column">\n${marked.parse(md)}\n</div>`);
    } catch {
      colHtml.push('<div class="column"></div>');
    }
  }
  if (!colHtml.length) return "";
  const html = `<div class="column-list">\n${colHtml.join("\n")}\n</div>`;
  const payload = Buffer.from(JSON.stringify({ html }), "utf8").toString("base64");
  return `\n\n@@HTML:${payload}@@\n\n`;
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
  inst.setCustomTransformer("column_list", columnListTransformer);
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
    .replace(/<p>\s*(<figure|<div class="column-list">)/g, "$1")
    .replace(/(<\/figure>|<\/div>)\s*<\/p>/g, "$1");
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
    if (/^last updated\b/i.test(text)) continue; // date-stamp boilerplate, not a summary
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

// A failed download must not reach the published page: Notion asset URLs are
// signed and expire in ~1h, so "leave the URL as-is" means a broken image an
// hour later. Retry transient failures, then abort the run — the previous
// good page stays live and the next hourly run gets fresh URLs.
async function fetchWithRetry(url, attempts = 3) {
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await fetch(url);
      if (res.ok) return res;
      if (attempt === attempts) throw new Error(`HTTP ${res.status}`);
    } catch (err) {
      if (attempt === attempts) throw err instanceof Error ? err : new Error(String(err));
    }
    await new Promise((r) => setTimeout(r, 1000 * attempt));
  }
}

// Download every Notion-hosted image referenced in the HTML into
// images/notion/<slug>/, optimize it, and rewrite the <img src> to that local
// path — so the essay's images are permanent (Notion links expire in ~1h) and
// lightweight. The folder is rebuilt each run; identical inputs yield identical
// bytes, so repeat runs create no git churn. Returns the rewritten html plus a
// map of local path → intrinsic pixel size, so wrapFigures can emit
// width/height and the browser can reserve space before the image loads.
async function localizeImages(html, slug) {
  // De-duped: the same URL appearing twice would otherwise be downloaded
  // twice, and the second file orphaned (the first rewrite below already
  // replaces every occurrence).
  const urls = new Set();
  const re = /<img\b[^>]*?\ssrc="([^"]+)"/gi;
  let m;
  while ((m = re.exec(html)) !== null) urls.add(m[1]);
  const dims = new Map();
  if (!urls.size) return { html, dims };

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
      const res = await fetchWithRetry(url);
      const buf = Buffer.from(await res.arrayBuffer());
      const { out: optimized, ext } = await optimizeImage(buf, extFromUrl(url));
      const rel = `images/notion/${slug}/img-${i}${ext}`;
      await fs.writeFile(path.join(REPO_ROOT, rel), optimized);
      out = out.split(url).join(rel);
      try {
        const meta = await sharp(optimized).metadata();
        if (meta.width && meta.height) dims.set(rel, { width: meta.width, height: meta.height });
      } catch {
        /* pass-through format sharp can't read — just omit width/height */
      }
      rawTotal += buf.length;
      optTotal += optimized.length;
      console.log(
        `  image ${i}: ${rel} (${(buf.length / 1048576).toFixed(1)}MB → ${(optimized.length / 1048576).toFixed(2)}MB)`
      );
    } catch (err) {
      throw new Error(`image ${i} of "${slug}" failed after retries (${err.message}) — aborting sync`);
    }
  }
  if (i) {
    console.log(
      `  images: ${(rawTotal / 1048576).toFixed(1)}MB → ${(optTotal / 1048576).toFixed(1)}MB total`
    );
  }
  return { html: out, dims };
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

// Titles are cached in the state file (.generated.json) so repeat runs are
// deterministic: a URL is fetched once, and a later title change on the
// target site doesn't churn the generated HTML. Only successful lookups are
// cached; failures fall back to showing the bare URL and retry next run.
let linkTitleCache = {};
const usedTitleUrls = new Set();

async function cachedLinkTitle(url) {
  usedTitleUrls.add(url);
  if (Object.prototype.hasOwnProperty.call(linkTitleCache, url)) {
    return linkTitleCache[url];
  }
  const title = await fetchLinkTitle(url);
  if (title) linkTitleCache[url] = title;
  return title;
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
    [...bareUrls].map(async (u) => titles.set(u, await cachedLinkTitle(u)))
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
    .footer-nav { margin: 0; padding: 24px 28px 48px; border-top: 1px solid #ece8e1; display: flex; justify-content: space-between; align-items: center; gap: 20px; }
    .footer-nav-links { display: flex; gap: 20px; align-items: center; }
    .footer-nav a { font-size: 0.76rem; color: #595959; text-decoration: none; letter-spacing: 0.02em; }
    .footer-nav a:hover { color: #1a1a1a; }`;
}

// ---------- manual overrides ----------
// Hand-dictated edits that must survive re-syncs. Notion stays the source of
// truth for content; these are re-applied on top of the freshly generated HTML
// on every run, keyed by slug (see overrides.json). Each rule replaces one
// exact substring. If the text no longer appears (Notion changed it) or appears
// more than once (ambiguous), the rule is skipped with a warning so it can never
// silently corrupt a page.
async function loadOverrides() {
  try {
    return JSON.parse(await fs.readFile(path.join(__dirname, "overrides.json"), "utf8"));
  } catch {
    return {};
  }
}

function applyOverrides(html, slug, overrides) {
  const rules = overrides?.[slug];
  if (!Array.isArray(rules)) return html;
  let out = html;
  for (const rule of rules) {
    if (!rule || typeof rule.find !== "string" || typeof rule.replace !== "string") continue;
    const label = rule.note ? ` (${rule.note})` : "";
    const count = out.split(rule.find).length - 1;
    if (count === 1) {
      out = out.replace(rule.find, () => rule.replace); // fn replacer: no $-substitution
      console.log(`  override applied on ${slug}.html${label}`);
    } else if (count === 0) {
      console.warn(`  override skipped on ${slug}.html — text not found, Notion may have changed it${label}`);
    } else {
      console.warn(`  override skipped on ${slug}.html — ${count} matches, ambiguous${label}`);
    }
  }
  return out;
}

// marked renders a lone image as <p><img></p>; turn those into
// <figure class="image"> with a click-to-open link wrapper (and a caption when
// the image has meaningful alt text), matching manifest.html. The caption text
// doubles as the alt attribute (filename-shaped alts count as no alt), every
// body image lazy-loads, and width/height come from the dims map built by
// localizeImages so the layout doesn't shift while images stream in.
function wrapFigures(html, dims = new Map()) {
  return html.replace(/<p>\s*<img\b([^>]*)>\s*<\/p>/gi, (_m, attrs) => {
    const src = attrs.match(/\bsrc="([^"]*)"/i)?.[1] || "";
    const alt = decodeEntities((attrs.match(/\balt="([^"]*)"/i)?.[1] || "")).trim();
    const isFilename = /\.(png|jpe?g|gif|webp|svg|avif|heic|heif|tiff?)$/i.test(alt);
    const caption =
      alt && !isFilename ? `<figcaption>${escapeHtml(alt)}</figcaption>` : "";
    const altAttr = ` alt="${alt && !isFilename ? escapeHtml(alt) : ""}"`;
    const d = dims.get(src);
    const sizeAttrs = d ? ` width="${d.width}" height="${d.height}"` : "";
    return `<figure class="image"><a href="${src}"><img src="${src}"${altAttr}${sizeAttrs} loading="lazy"/></a>${caption}</figure>`;
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

// JSON-encode a value for embedding inside an inline <script> ("<" is escaped
// so content can never close the script tag early).
function jsStr(value) {
  return JSON.stringify(String(value)).replace(/</g, "\\u003c");
}

// The comment section for one essay, or "" when no App ID is configured.
// pageId sent to Cusdis is the slug — stable and unique — so an essay keeps
// its comments even if its title or URL later changes. parsedContent comes
// from Cusdis rendered server-side with markdown-it (raw HTML escaped,
// link/image syntax disabled) and comments are moderated; the client-side
// sanitize() below is defense-in-depth in case that ever changes.
function commentsSection({ slug, title, url }) {
  if (!CUSDIS_APP_ID) return "";
  return `  <section class="comments" aria-label="Comments">
    <h2 class="comments-title">Comments</h2>
    <form class="comment-form" id="comment-form">
      <input class="comment-field" name="nickname" type="text" maxlength="50" placeholder="your name" required>
      <textarea class="comment-field comment-text" name="content" rows="4" maxlength="10000" placeholder="leave a comment" required></textarea>
      <div class="comment-actions">
        <button class="comment-submit" type="submit">post comment</button>
        <button class="comment-cancel" type="button" hidden>cancel reply</button>
        <span class="comment-status" role="status" aria-live="polite"></span>
      </div>
    </form>
    <div class="comment-list" id="comment-list" hidden></div>
    <button class="comment-more" id="comment-more" type="button" hidden>more comments</button>
  </section>
  <script>
  (function () {
    var API = ${jsStr(CUSDIS_HOST + "/api/open/comments")};
    var APP_ID = ${jsStr(CUSDIS_APP_ID)};
    var PAGE_ID = ${jsStr(slug)};
    var PAGE_URL = ${jsStr(url)};
    var PAGE_TITLE = ${jsStr(title)};

    var form = document.getElementById('comment-form');
    var list = document.getElementById('comment-list');
    var more = document.getElementById('comment-more');
    var status = form.querySelector('.comment-status');
    var cancel = form.querySelector('.comment-cancel');
    var submit = form.querySelector('.comment-submit');
    var nameField = form.querySelector('[name="nickname"]');
    var textField = form.querySelector('[name="content"]');
    var replyTo = null;
    var page = 1;

    function el(tag, cls, text) {
      var n = document.createElement(tag);
      n.className = cls;
      if (text) n.textContent = text;
      return n;
    }

    function sanitize(html) {
      var doc = new DOMParser().parseFromString(html, 'text/html');
      var nodes = doc.body.querySelectorAll('*');
      for (var i = 0; i < nodes.length; i++) {
        var node = nodes[i];
        if (/^(script|style|iframe|object|embed|form|link|meta)$/i.test(node.tagName)) {
          node.parentNode.removeChild(node);
          continue;
        }
        for (var j = node.attributes.length - 1; j >= 0; j--) {
          var attr = node.attributes[j];
          if (/^on/i.test(attr.name) || /^\s*(javascript|vbscript|data):/i.test(String(attr.value))) {
            node.removeAttribute(attr.name);
          }
        }
      }
      return doc.body.innerHTML;
    }

    function endReply() {
      replyTo = null;
      cancel.hidden = true;
      list.parentNode.insertBefore(form, list);
    }

    function startReply(comment, node) {
      replyTo = comment.id;
      cancel.hidden = false;
      status.textContent = '';
      node.appendChild(form);
      textField.focus();
    }

    function render(c) {
      var node = el('div', 'comment');
      var meta = el('div', 'comment-meta');
      var name = (c.moderator && c.moderator.displayName) || c.by_nickname || 'anonymous';
      meta.appendChild(el('span', 'comment-author', name));
      if (c.moderatorId) meta.appendChild(el('span', 'comment-author-badge', 'author'));
      meta.appendChild(el('span', 'comment-date', String(c.parsedCreatedAt || c.createdAt || '').slice(0, 10)));
      node.appendChild(meta);
      var body = el('div', 'comment-body');
      if (c.parsedContent) body.innerHTML = sanitize(c.parsedContent);
      else body.textContent = c.content || '';
      node.appendChild(body);
      var reply = el('button', 'comment-reply', 'reply');
      reply.type = 'button';
      reply.addEventListener('click', function () { startReply(c, node); });
      node.appendChild(reply);
      if (c.replies && c.replies.data && c.replies.data.length) {
        var kids = el('div', 'comment-replies');
        c.replies.data.forEach(function (r) { kids.appendChild(render(r)); });
        node.appendChild(kids);
      }
      return node;
    }

    function load() {
      fetch(API + '?appId=' + APP_ID + '&pageId=' + encodeURIComponent(PAGE_ID) + '&page=' + page, {
        headers: { 'x-timezone-offset': String(-(new Date().getTimezoneOffset() / 60)) }
      })
        .then(function (r) { return r.json(); })
        .then(function (res) {
          var d = res && res.data;
          if (!d) return;
          (d.data || []).forEach(function (c) { list.appendChild(render(c)); });
          list.hidden = !list.firstChild;
          more.hidden = !(page < (d.pageCount || 1));
        })
        .catch(function () {});
    }

    more.addEventListener('click', function () { page += 1; load(); });
    cancel.addEventListener('click', endReply);

    form.addEventListener('submit', function (e) {
      e.preventDefault();
      var content = textField.value.trim();
      var nickname = nameField.value.trim();
      if (!content || !nickname) return;
      submit.disabled = true;
      status.textContent = 'sending\\u2026';
      fetch(API, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          appId: APP_ID,
          pageId: PAGE_ID,
          content: content,
          nickname: nickname,
          parentId: replyTo || undefined,
          pageUrl: PAGE_URL,
          pageTitle: PAGE_TITLE
        })
      })
        .then(function (r) {
          if (!r.ok) throw new Error('HTTP ' + r.status);
          textField.value = '';
          endReply();
          status.textContent = 'thank you \\u2014 your comment will appear once approved.';
        })
        .catch(function () {
          status.textContent = 'something went wrong \\u2014 please try again.';
        })
        .then(function () { submit.disabled = false; });
    });

    load();
  })();
  </script>
`;
}

function articlePage({ title, description, bodyHtml, tocHtml, slug, style, ogImage }) {
  const url = `https://www.carolannejiang.com/${slug}.html`;
  const safeTitle = escapeHtml(title);
  const safeDesc = escapeHtml(description || "");
  // Social embeds show a bare text card without og:image; use the essay's
  // first body image when there is one.
  const ogImageTag = ogImage
    ? `\n  <meta property="og:image" content="https://www.carolannejiang.com/${ogImage}">`
    : "";
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
  <meta property="og:url" content="${url}">${ogImageTag}
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
</nav>
<div class="layout">
${side}
  <main class="article">
<header><h1 class="page-title" dir="auto">${safeTitle}</h1><p class="page-description" dir="auto"></p></header>
<div class="page-body">
${bodyHtml}
</div>
${commentsSection({ slug, title, url })}  </main>
  </div>
  <nav class="footer-nav" aria-label="Site links"><a href="index.html">← back to home</a><div class="footer-nav-links"><a href="art.html">art</a><a href="https://savvycal.com/carolanne">chat</a><a href="work.html">work</a></div></nav>

<script>
(function () {
  var links = [].slice.call(document.querySelectorAll('.table_of_contents-link'));
  if (!links.length) return;
  var items = links.map(function (a) {
    return { link: a, heading: document.getElementById(a.getAttribute('href').slice(1)) };
  }).filter(function (x) { return x.heading; });
  function update() {
    var current = null;
    for (var i = 0; i < items.length; i++) {
      if (items[i].heading.getBoundingClientRect().top <= 120) current = items[i];
      else break;
    }
    links.forEach(function (a) { a.classList.remove('active'); });
    if (current) current.link.classList.add('active');
  }
  window.addEventListener('scroll', update, { passive: true });
  window.addEventListener('resize', update, { passive: true });
  update();
})();
</script>
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
    return {
      slugs: Array.isArray(data.slugs) ? data.slugs : [],
      linkTitles:
        data.linkTitles && typeof data.linkTitles === "object" ? data.linkTitles : {},
    };
  } catch {
    return { slugs: [], linkTitles: {} };
  }
}

async function writeState(slugs) {
  // Keep only cache entries for links that still appear in some essay.
  const linkTitles = {};
  for (const url of Object.keys(linkTitleCache).sort()) {
    if (usedTitleUrls.has(url)) linkTitles[url] = linkTitleCache[url];
  }
  await fs.writeFile(
    STATE_FILE,
    `${JSON.stringify({ slugs: [...slugs].sort(), linkTitles }, null, 2)}\n`
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
  const previous = await readState();
  linkTitleCache = previous.linkTitles;

  const items = await fetchEntries(PARENT_PAGE_ID);
  const style = await siteStyle();
  const overrides = await loadOverrides();

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

    // Refuse to overwrite anything this script didn't generate: a hand-written
    // page lacks the marker, so an essay titled e.g. "Art" must not replace it.
    const outFile = path.join(REPO_ROOT, `${slug}.html`);
    try {
      const existing = await fs.readFile(outFile, "utf8");
      if (!existing.includes(GENERATED_MARKER)) {
        console.warn(
          `Skipping "${title}" — ${slug}.html already exists and is not a notion-sync file.`
        );
        continue;
      }
    } catch {
      /* no existing file — safe to write */
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
    const localized = await localizeImages(bodyHtml, slug); // also localizes toggle images
    bodyHtml = wrapFigures(localized.html, localized.dims);
    bodyHtml = await nameBareLinks(bodyHtml);
    bodyHtml = bodyHtml
      .replace(/<ul>/g, '<ul class="bulleted-list">')
      .replace(/<ol>/g, '<ol class="numbered-list">'); // match manifest.html classes
    const withToc = addTocAndIds(bodyHtml);
    const description = excerptFromMarkdown(md);
    const dateISO = item.createdTime;

    let pageHtml = articlePage({
      title,
      description,
      bodyHtml: withToc.html,
      // Only show the left menu when the Notion doc has a Contents block.
      tocHtml: tocSeen ? tocItemsHtml(withToc.toc) : "",
      slug,
      style,
      ogImage: withToc.html.match(/<img\b[^>]*?\ssrc="(images\/notion\/[^"]+)"/)?.[1] || "",
    });
    pageHtml = applyOverrides(pageHtml, slug, overrides);
    await fs.writeFile(outFile, pageHtml);
    console.log(`Wrote ${slug}.html  ("${title}")`);

    entries.push({ title, slug, description, year: yearOf(dateISO) });
  }

  // Keep the order you arranged the sub-pages in Notion.
  await updateIndex(entries);

  // Remove pages that were generated before but are no longer published.
  const current = new Set(entries.map((e) => e.slug));
  for (const oldSlug of previous.slugs) {
    if (!current.has(oldSlug)) await safeDelete(oldSlug);
  }
  await writeState(current);

  console.log("Sync complete.");
}

main().catch((err) => {
  console.error("Sync failed:", err);
  process.exit(1);
});
