# Auto-publishing writings from Notion

This makes new writings you create in Notion appear on carolannejiang.com
automatically, styled to match the rest of the site. Your existing hand-written
pages (`on-education.html`, `manifest.html`, …) are left completely alone.

## How it works

1. You keep a Notion database of writings.
2. Once an hour, a GitHub Action reads every row marked **Published**, converts
   each page to HTML using the site's template, writes one `<slug>.html` per
   writing, and refreshes the list on `writing.html`.
3. It commits the result, and GitHub Pages publishes it within a minute.

You never touch HTML. You write in Notion, tick **Published**, and it goes live.

---

## One-time setup (about 15 minutes)

There are two things only you can do: create the Notion side, and paste two
secrets into the GitHub repo.

### 1. Create the Notion database

Make a new database (Table view is fine) with these **exact** column names:

| Column        | Type            | Purpose                                                    |
| ------------- | --------------- | ---------------------------------------------------------- |
| `Name`        | Title           | The writing's title (any title-type column works).         |
| `Date`        | Date            | Publication date. Controls ordering (newest first).        |
| `Slug`        | Text            | The URL, e.g. `on-friendship` → `/on-friendship.html`. Optional — if blank, it's generated from the title. |
| `Description` | Text            | One-line summary shown on the Writing index page.          |
| `Published`   | Checkbox        | Only checked rows go live. Uncheck to take a piece down.   |

The body of each Notion page becomes the article text (headings, lists, quotes,
links, and images all carry over).

### 2. Create a Notion integration and get the token

1. Go to <https://www.notion.so/my-integrations> → **New integration**.
2. Name it (e.g. "Website sync"), pick your workspace, submit.
3. Copy the **Internal Integration Secret** — it starts with `ntn_` (older ones
   start with `secret_`). This is your `NOTION_TOKEN`.
4. Open your writings database in Notion → top-right `•••` menu →
   **Connections** → **Connect to** → choose your integration. (Without this the
   integration can't see the database.)

### 3. Get the database ID

Open the database as a full page in your browser. The URL looks like:

```
https://www.notion.so/yourworkspace/1234abcd5678ef901234abcd5678ef90?v=...
```

The 32-character chunk before `?v=` is your `NOTION_DATABASE_ID`.

### 4. Put both values into the GitHub repo secrets

In the repo on GitHub: **Settings → Secrets and variables → Actions → New
repository secret**. Add two:

- `NOTION_TOKEN` → the `ntn_…` secret from step 2.
- `NOTION_DATABASE_ID` → the 32-char ID from step 3.

### 5. Turn it on / test it

- Go to the repo's **Actions** tab. If prompted, enable workflows.
- Open **Sync writings from Notion** → **Run workflow** to trigger it now
  instead of waiting for the top of the hour.
- After it finishes, check `writing.html` and your new `<slug>.html` on the site.

That's it. From now on, publishing = ticking the **Published** box in Notion.

---

## Good to know

- **Ordering:** newest `Date` first. New Notion pieces appear above your
  hand-written entries on the Writing page. To change where they sit, move the
  `<!-- NOTION:START -->` / `<!-- NOTION:END -->` markers in `writing.html`.
- **Editing a piece:** just edit it in Notion; the next sync overwrites its page.
- **Unpublishing:** uncheck **Published** (or delete the row). The next sync
  removes that page. Only files this tool generated are ever deleted — your
  hand-written pages are protected by an internal marker.
- **Speed:** updates appear within the hour. To publish instantly, run the
  workflow manually from the Actions tab.
- **Don't hand-edit** generated `<slug>.html` files or the block between the
  `NOTION` markers in `writing.html` — the next sync overwrites them. Edit in
  Notion instead.

## Run it locally (optional)

```bash
cd scripts/notion-sync
npm install
NOTION_TOKEN=ntn_xxx NOTION_DATABASE_ID=xxxx node sync.mjs
```
