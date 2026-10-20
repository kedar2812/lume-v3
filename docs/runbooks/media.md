# Media and the render service

Media (in the sidebar) is where a business keeps the files it sends leads: brochures, price lists, photos, videos.
Each file shows its content as its thumbnail, and opens in LUME's own viewer. Plan:
`docs/superpowers/plans/2026-10-20-media-tab.md`.

The thumbnails, and the pages of a Word, Excel or PowerPoint file, are made by LUME's **render service**
(`apps/render`, image `render`). It is part of every install: it runs beside the API in `infra/docker-compose.yml`.

## What it does

The API sends it a file's bytes and gets back:

- a thumbnail (WebP, 960 px on its longest side at most) of a photo, a video's frame a tenth of the way in, or a
  PDF's first page, with the page count, the video's length and the size where known;
- a PDF of a Word, Excel, PowerPoint or text file, which LUME shows page by page and makes the thumbnail from.

Each file is rendered once, however many times it's added: the preview belongs to the bytes.

## Why it's safe to run

- **No way out.** It sits on the `render` network, which is `internal: true` and shared only with the API. It can't
  reach the internet, the database, or any other LUME service. Nothing reaches it but the API.
- **Nothing kept.** Each job runs in a folder of its own on a tmpfs (`/tmp`, 768 MB), removed when the job ends. The
  container is read-only, runs as `node`, has no Linux capabilities, and may start at most 128 processes.
- **Limits.** One job at a time; at most 8 waiting (the API is told to come back later after that). A request body of
  26 MB at most. Every tool is stopped after 45 seconds, together with anything it started. LibreOffice runs with
  macros off, links and external data never fetched, and formulas never recalculated (`apps/render/src/profile.ts`).
  The container has 1 GB of memory.
- **It checks what it's sent.** The API reads every file's type from its bytes before keeping it; the render service
  checks them again, so a file can't choose which of the tools' readers opens it.

## Without it

Set `LUME_RENDER_URL=` (empty) in `.env` and stop the service (`docker compose stop render`). Media still works: each
file shows its kind instead of its content, photos, videos and PDFs still open in the viewer, and Word and PowerPoint
files say LUME can't show them on this server and can still be sent.

## Reading its logs

```sh
docker compose logs --tail 100 render
```

One line per job: the route, the file's type, the answer and how long it took. No file names and no content are
logged. A `422` is a file the tools couldn't render (a broken or locked PDF, a conversion past 45 s): Media shows that
file by its kind, and an admin can try again from the viewer's Info. A run of `503` means files arrive faster than it
renders them; LUME tries each again later by itself.

## Fonts

Debian's Noto fonts cover Latin, Devanagari, Arabic and most other scripts; Liberation, Carlito and Caladea stand in
for Arial, Times New Roman, Calibri and Cambria with the same widths, so pages break where they did in Office.
Chinese, Japanese and Korean aren't included (they would double the image); such text shows as boxes in a thumbnail,
and the file itself is untouched.
