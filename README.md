# twitter-bookmarks-obsidian-importer

Imports all your X (Twitter) bookmarks from an official **X data archive** into an
Obsidian vault — one markdown note per bookmarked tweet, in the Obsidian Web Clipper
format, with deduplication so it's safe to re-run.

Zero dependencies. Requires Node >= 18.

## How to get your archive

1. On X (web or app): **Settings and privacy → Your account → Download an archive of your data**
2. Confirm your password; X emails you a download link when it's ready (24h+)
3. Unzip it:

```bash
unzip -d ~/Downloads/x-archive ~/Downloads/twitter-*.zip
```

## Usage

```bash
node import.mjs ~/Downloads/x-archive
```

Notes land in your vault's `Clippings/` folder; images are downloaded into
`05_Attachments/Organized/twitter-bookmarks/`. Defaults point at your Perso vault.

To sync again later, request a fresh archive and run the same command — only
bookmarks not already in the vault get imported.

### Options

| Option | Description |
| --- | --- |
| `-o, --output <dir>` | Notes output directory (default: `<vault>/Clippings`) |
| `--media-dir <dir>` | Media output directory (default: `<vault>/05_Attachments/Organized/twitter-bookmarks`) |
| `--media <mode>` | `download` (default) or `url` (embed remote links only, no downloads) |
| `--tags <a,b,c>` | Tags for created notes (default: `clippings`) |
| `-n, --dry-run` | Show what would be created without writing anything |
| `--limit <n>` | Import at most n bookmarks (0 = no limit) |
| `-v, --verbose` | Log each note as it is processed |
| `-h, --help` | Show help |

Dry run first is a good idea:

```bash
node import.mjs ~/Downloads/x-archive --dry-run
node import.mjs ~/Downloads/x-archive            # for real
node import.mjs ~/Downloads/x-archive --limit 10 # small trial batch
```

## Output format

One note per bookmark, matching the Obsidian Web Clipper frontmatter style:

```markdown
---
title: "The best time to test the archive format was 20 years ago"
source: "https://x.com/naval/status/2222222222222222222"
author:
  - "[[@naval]]"
published: 2024-06-10
created: 2026-09-22
description:
tags:
  - "clippings"
---

**naval** @naval 2024-06-10

The best time to test the archive format was 20 years ago. The second best time is now.

Details: https://example.com/post
```

`t.co` short links are expanded to their real URLs, and links that merely point at
the tweet's own media are removed (the media is embedded instead).

## Media handling

- Images are fetched from X's public CDN at large size and saved as
  `x-<tweetId>-<n>.jpg|png|webp|gif`, embedded with Obsidian `![[wikilinks]]`
- If a download fails (e.g. offline), the remote URL is embedded instead, so
  nothing is lost
- Videos can't be extracted from archives (they're served as HLS streams) —
  they are embedded as plain links
- Use `--media url` to skip downloads entirely

## Deduplication

On every run, the importer scans all `.md` files in the output folder (recursively)
for `source:` frontmatter values and extracts the status id. Bookmarks already in
the vault are skipped, so re-running with a new archive only adds new bookmarks.

## Limitations

- Only the bookmarked tweet itself is imported — not its reply thread (the archive
  contains no thread data for other people's tweets)
- The author handle is best-effort: bookmarks.js doesn't always include it, so the
  script infers it from the tweet's canonical URL; otherwise the note has no author
  and `source` falls back to `https://x.com/i/web/status/<id>`
- Bookmarks are absent from very old archives (X added them ~2023)

## Testing

```bash
npm test
```

Runs an integration test against a fixture archive and a local HTTP media server —
no network access needed.
