// Step 3: connection test + block dump.
// Run:  cd scripts && npm install && npm run dump
// Reads NOTION_TOKEN and NOTION_PAGE_ID from scripts/.env
// Writes notion-dump.json (gitignored) and prints a summary of block types.

import { Client } from "@notionhq/client";
import { readFileSync, writeFileSync } from "node:fs";

// --- tiny .env loader (no dependency) ---
try {
  const env = readFileSync(new URL(".env", import.meta.url), "utf8");
  for (const line of env.split("\n")) {
    const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
} catch {
  /* no .env file — rely on real env vars (e.g. in CI) */
}

const token = process.env.NOTION_TOKEN;
const pageId = process.env.NOTION_PAGE_ID;

if (!token || !pageId) {
  console.error("Missing NOTION_TOKEN or NOTION_PAGE_ID. Fill them into scripts/.env");
  process.exit(1);
}

const notion = new Client({ auth: token });

// Recursively fetch every block and its children.
async function fetchChildren(blockId) {
  const blocks = [];
  let cursor;
  do {
    const res = await notion.blocks.children.list({ block_id: blockId, start_cursor: cursor, page_size: 100 });
    for (const block of res.results) {
      if (block.has_children) block.children = await fetchChildren(block.id);
      blocks.push(block);
    }
    cursor = res.has_more ? res.next_cursor : undefined;
  } while (cursor);
  return blocks;
}

function summarize(blocks, counts = {}) {
  for (const b of blocks) {
    counts[b.type] = (counts[b.type] || 0) + 1;
    if (b.children) summarize(b.children, counts);
  }
  return counts;
}

try {
  const page = await notion.pages.retrieve({ page_id: pageId });
  const blocks = await fetchChildren(pageId);
  const dump = { page, blocks };
  writeFileSync(new URL("../notion-dump.json", import.meta.url), JSON.stringify(dump, null, 2));

  const title =
    Object.values(page.properties || {})
      .find((p) => p.type === "title")
      ?.title?.map((t) => t.plain_text)
      .join("") || "(untitled)";

  console.log("✅ Connected. Page title:", title);
  console.log("✅ Wrote notion-dump.json");
  console.log("Block types found:");
  for (const [type, n] of Object.entries(summarize(blocks)).sort((a, b) => b[1] - a[1])) {
    console.log(`   ${n.toString().padStart(3)}  ${type}`);
  }
} catch (err) {
  console.error("❌ Notion API error:", err.body || err.message);
  if (String(err.message).includes("Could not find")) {
    console.error("   → Make sure you shared the page with your integration (step 2).");
  }
  process.exit(1);
}
