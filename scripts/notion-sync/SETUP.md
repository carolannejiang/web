# Auto-publishing writings from Notion

New writings you create in Notion appear on carolannejiang.com automatically,
styled to match the rest of the site. Your existing hand-written pages
(`on-education.html`, `manifest.html`, …) are left completely alone.

## How it works

You keep **one Notion source** for your writing. It can be either shape — the
sync auto-detects which:

**Option 1 — a plain page with sub-pages:**
```
📄 Writing              ← the parent page (you connect the integration to this)
   ├─ 📄 On Friendship      → https://www.carolannejiang.com/on-friendship.html
   ├─ 📄 Notes on Drawing   → https://www.carolannejiang.com/notes-on-drawing.html
   └─ 📄 Draft: half-baked  → skipped (title starts with "Draft:")
```

**Option 2 — a database / Table view** (if you like the tidy table look). Each
row is a page: open a row and write the essay in its body. No columns are
required — just the title and the body. If you add a `Published` checkbox
column, unchecked rows are skipped; otherwise every row publishes.

```
| Title             |   ← each row opens into a full page you write in
| ----------------- |
| On Friendship     |   → /on-friendship.html
| Notes on Drawing  |   → /notes-on-drawing.html
```

Either way: the **title** becomes the essay title + URL, the **page body** is
the content, and the **created date** is the date shown. Sub-pages/rows titled
`Draft: ...` are skipped.

Once an hour, a GitHub Action reads every sub-page, converts it to HTML using
the site's template, writes one `<slug>.html` per essay, and rebuilds the list
on `writing.html`. It commits the result and GitHub Pages publishes within a
minute.

- **Title** of the sub-page → the essay title and its URL.
- **Created date** of the sub-page → the date shown on the piece.
- **First paragraph** → the one-line summary on the Writing index.
- **Order** of sub-pages in Notion → the order they appear on the site.
- Sub-pages titled **`Draft: ...`** are skipped. To keep something private,
  either prefix it `Draft:` or keep it *outside* the Writing page until ready.

You never touch HTML. Write in Notion, and it goes live.

---

## One-time setup (about 10 minutes)

### 1. Make the parent page in Notion

1. Create a normal page called **Writing**.
2. Inside it, create a **sub-page** for each essay (type `/page` or just add a
   page block) and write in them.

### 2. Create a Notion integration and get the token

1. Go to <https://www.notion.so/my-integrations> → **New integration**.
2. Name it (e.g. "Website sync"), pick your workspace, **Internal** type, save.
3. Copy the **Internal Integration Secret** (starts with `ntn_`, older ones
   `secret_`). This is your `NOTION_TOKEN`.

### 3. Connect the integration to the Writing page

1. Open the **Writing** parent page in Notion.
2. Top-right **•••** → **Connections** → **Connect to** → your integration.
   (Sub-pages inherit access — you only connect the parent.)

### 4. Get the parent page ID

Open the **Writing** page and copy its link (**•••** → **Copy link**, or the
browser URL). The 32-character chunk at the end (before any `?`) is the ID:

```
https://www.notion.so/Writing-206e858d1bc780a9b7f4f2c5721135ce
                               └──────────────────────────────┘
                                     parent page ID
```

Dashes in the ID are fine either way.

### 5. Put the values into the GitHub repo secrets

Repo → **Settings → Secrets and variables → Actions → New repository secret**:

- `NOTION_TOKEN` → the `ntn_…` secret.
- `NOTION_PARENT_PAGE_ID` → the parent page's 32-char ID.
  - (If you already have a secret named `NOTION_DATABASE_ID` from before, you can
    instead just **edit its value** to the parent page ID — the script accepts
    either name.)

### 6. Turn it on / test

- Repo **Actions** tab → **Sync writings from Notion** → **Run workflow**.
- After it finishes, check `writing.html` and your new pages on the site.

---

## Good to know

- **Renaming an essay changes its URL** (the slug comes from the title), which
  breaks old links to it. Rename before sharing, not after.
- **Editing:** just edit the sub-page in Notion; the next sync overwrites its
  page.
- **Unpublishing:** delete the sub-page, move it out of the Writing page, or
  rename it to start with `Draft:`. The next sync removes its page. Only files
  this tool generated are ever deleted — hand-written pages are protected.
- **Speed:** updates appear within the hour, or instantly via **Run workflow**.
- **Don't hand-edit** generated `<slug>.html` files or the block between the
  `NOTION` markers in `writing.html` — the next sync overwrites them.

## Run it locally (optional)

```bash
cd scripts/notion-sync
npm install
NOTION_TOKEN=ntn_xxx NOTION_PARENT_PAGE_ID=xxxx node sync.mjs
```
