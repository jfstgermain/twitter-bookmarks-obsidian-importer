#!/usr/bin/env node
/**
 * import.mjs — Import X (Twitter) bookmarks from an official X data archive
 * into an Obsidian vault, one note per bookmark.
 *
 * Usage:
 *   node import.mjs <path-to-unzipped-archive> [options]
 *
 * Requires Node >= 18 (built-in fetch). Zero dependencies.
 */

import fs from "node:fs";
import path from "node:path";
import process from "node:process";

// ---------------------------------------------------------------------------
// Defaults — personal vault paths (override with --output / --media-dir)
// ---------------------------------------------------------------------------
const VAULT = "/Users/jfstgermain/Library/Mobile Documents/iCloud~md~obsidian/Documents/Perso";
const DEFAULT_OUTPUT = path.join(VAULT, "Clippings");
const DEFAULT_MEDIA_DIR = path.join(VAULT, "05_Attachments", "Organized", "twitter-bookmarks");

const USAGE = `Import X (Twitter) bookmarks from an official X data archive into Obsidian notes.

Usage:
  node import.mjs <archive-dir> [options]

Arguments:
  <archive-dir>        Unzipped X archive (the folder containing data/)

Options:
  -o, --output <dir>   Notes output directory
                       (default: <vault>/Clippings)
      --media-dir <d>  Media output directory
                       (default: <vault>/05_Attachments/Organized/twitter-bookmarks)
      --media <mode>   "download" (default) or "url" (embed remote links only)
      --tags <a,b,c>   Comma-separated tags for created notes (default: clippings)
  -n, --dry-run        Show what would be created without writing anything
      --limit <n>      Import at most n bookmarks (0 = no limit, default)
  -v, --verbose        Log each note as it is processed
  -h, --help           Show this help
`;

function fail(msg) {
  console.error(`error: ${msg}`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------
function parseArgs(argv) {
  const opts = {
    archive: null,
    output: DEFAULT_OUTPUT,
    mediaDir: DEFAULT_MEDIA_DIR,
    media: "download",
    tags: ["clippings"],
    dryRun: false,
    limit: 0,
    verbose: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      if (i + 1 >= argv.length) fail(`missing value for ${a}`);
      return argv[++i];
    };
    switch (a) {
      case "-o":
      case "--output":
        opts.output = next();
        break;
      case "--media-dir":
        opts.mediaDir = next();
        break;
      case "--media": {
        const v = next();
        if (v !== "download" && v !== "url") fail(`--media must be "download" or "url", got "${v}"`);
        opts.media = v;
        break;
      }
      case "--tags":
        opts.tags = next()
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean);
        break;
      case "-n":
      case "--dry-run":
        opts.dryRun = true;
        break;
      case "--limit": {
        const n = Number(next());
        if (!Number.isFinite(n) || n < 0) fail(`--limit must be a non-negative number`);
        opts.limit = Math.floor(n);
        break;
      }
      case "-v":
      case "--verbose":
        opts.verbose = true;
        break;
      case "-h":
      case "--help":
        console.log(USAGE);
        process.exit(0);
        break;
      default:
        if (a.startsWith("-")) fail(`unknown option: ${a}\n\n${USAGE}`);
        if (opts.archive) fail(`unexpected extra argument: ${a}`);
        opts.archive = a;
    }
  }
  if (!opts.archive) fail(`no archive path given\n\n${USAGE}`);
  return opts;
}

// ---------------------------------------------------------------------------
// Archive parsing
// ---------------------------------------------------------------------------

/** Recursively visit every file under dir. */
function walk(dir, cb) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, cb);
    else cb(p);
  }
}

/** Locate bookmark data files (bookmarks.js / bookmarks.json, any part). */
function findBookmarkFiles(archiveDir) {
  const files = [];
  walk(archiveDir, (p) => {
    const base = path.basename(p);
    if (/^bookmarks?[^/]*\.(js|json)$/i.test(base) && !/folders/i.test(base)) files.push(p);
  });
  return files.sort();
}

/**
 * Parse a window.YTD.* assignment file (or plain JSON) into an array.
 * Archives start files with e.g.  window.YTD.bookmarks.part0 = [ ... ]
 */
function parseJsDataFile(filePath) {
  let raw = fs.readFileSync(filePath, "utf8");
  raw = raw.replace(/^\uFEFF/, "").replace(/^\s*window\.YTD\.[\w-]+(?:\.[\w-]+)*\s*=\s*/, "");
  raw = raw.trim().replace(/;\s*$/, "");
  return JSON.parse(raw);
}

/** Entries are shaped { bookmark: {...} } (or { tweet: {...} }); unwrap them. */
function extractPayload(entry) {
  if (entry == null || typeof entry !== "object") return null;
  return entry.bookmark ?? entry.tweet ?? entry;
}

const MONTHS = { Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5, Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11 };

/** Parse ISO strings or Twitter's "Mon Jun 10 08:30:00 +0000 2024" format. */
function parseDate(v) {
  if (!v) return null;
  const s = String(v);
  const m = s.match(/^(\w{3}) (\w{3}) (\d{2}) (\d{2}):(\d{2}):(\d{2}) ([+-]\d{4}) (\d{4})$/);
  if (m && MONTHS[m[2]] !== undefined) {
    // Archives use +0000, so treating as UTC is fine.
    return new Date(Date.UTC(+m[8], MONTHS[m[2]], +m[3], +m[4], +m[5], +m[6]));
  }
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}

function fmtDate(d) {
  return d ? d.toISOString().slice(0, 10) : "";
}

function asString(v) {
  return typeof v === "string" ? v : v == null ? null : String(v);
}

function asStringArray(v) {
  if (!Array.isArray(v)) return [];
  return v.map((x) => (typeof x === "string" ? x : asString(x?.url ?? x?.expandedUrl ?? x?.mediaUrl))).filter(Boolean);
}

/** Normalize an archive bookmark record into a common shape. */
function normalizeBookmark(b) {
  const id = asString(b.tweetId ?? b.id ?? b.tweet_id ?? b.id_str);
  if (!id) return null;
  return {
    id,
    text: asString(b.fullText ?? b.full_text ?? b.text) ?? "",
    createdAt: parseDate(b.createdAt ?? b.created_at),
    urls: asStringArray(b.expandedUrls ?? b.expanded_urls ?? b.urls),
    media: asStringArray(b.mediaUrls ?? b.media_urls ?? b.media),
    screenName: asString(b.screenName ?? b.screen_name ?? b.username ?? b.handle ?? b.authorScreenName),
    displayName: asString(b.displayName ?? b.display_name ?? b.name),
    inReplyToId: asString(b.inReplyToStatusId ?? b.inReplyToTweetId ?? b.inReplyToStatusId_str),
  };
}

/** Read + normalize every bookmark in the archive, deduplicated by tweet id. */
function loadBookmarks(archiveDir) {
  const files = findBookmarkFiles(archiveDir);
  if (files.length === 0) {
    console.error(`error: no bookmarks file found in "${archiveDir}" (looked for bookmarks*.js / bookmarks*.json).`);
    const dataDir = path.join(archiveDir, "data");
    if (fs.existsSync(dataDir)) {
      console.error(`Files in ${dataDir}:`);
      for (const f of fs.readdirSync(dataDir).slice(0, 40)) console.error(`  - ${f}`);
    }
    process.exit(1);
  }
  const byId = new Map();
  for (const file of files) {
    const entries = parseJsDataFile(file);
    if (!Array.isArray(entries)) fail(`${file}: unexpected content (not an array after the window.YTD prefix)`);
    for (const raw of entries) {
      const t = normalizeBookmark(extractPayload(raw) ?? {});
      if (t && !byId.has(t.id)) byId.set(t.id, t);
    }
  }
  const tweets = [...byId.values()].sort((a, b) => (a.createdAt?.getTime() ?? 0) - (b.createdAt?.getTime() ?? 0));
  return { files, tweets };
}

// ---------------------------------------------------------------------------
// Dedup — scan existing notes for status URLs in their `source:` frontmatter
// ---------------------------------------------------------------------------
function existingStatusIds(outputDir) {
  const ids = new Set();
  walk(outputDir, (p) => {
    if (!p.endsWith(".md")) return;
    let head;
    try {
      const fd = fs.openSync(p, "r");
      const buf = Buffer.alloc(1500);
      const bytes = fs.readSync(fd, buf, 0, buf.length, 0);
      fs.closeSync(fd);
      head = buf.toString("utf8", 0, bytes);
    } catch {
      return;
    }
    const m = head.match(/^source:\s*"?([^"\n]+)"?\s*$/m);
    const src = m?.[1];
    if (src && /https?:\/\/(www\.)?(x|twitter)\.com\//.test(src)) {
      const id = src.match(/\/status\/(\d+)/)?.[1];
      if (id) ids.add(id);
    }
  });
  return ids;
}

// ---------------------------------------------------------------------------
// Note building
// ---------------------------------------------------------------------------
const AUTHOR_URL_RE = (id) => new RegExp(`https?://(?:x|twitter)\\.com/([A-Za-z0-9_]{1,15})/status/${id}\\b`);

/** Best-effort author: explicit field, else infer from a canonical status URL. */
function resolveAuthor(t) {
  if (t.screenName) return { screenName: t.screenName, displayName: t.displayName ?? t.screenName };
  for (const u of t.urls) {
    const m = u.match(AUTHOR_URL_RE(t.id));
    if (m) return { screenName: m[1], displayName: m[1] };
  }
  return null;
}

function canonicalSource(t, author) {
  if (author) return `https://x.com/${author.screenName}/status/${t.id}`;
  for (const u of t.urls) {
    const m = u.match(AUTHOR_URL_RE(t.id));
    if (m) return `https://x.com/${m[1]}/status/${t.id}`;
  }
  return `https://x.com/i/web/status/${t.id}`;
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Replace t.co links with their expanded URLs (order-aligned; guarded by count). */
function replaceTcoLinks(text, urls) {
  if (!urls.length) return text;
  const tokens = [...text.matchAll(/https:\/\/t\.co\/[A-Za-z0-9]+/g)].map((m) => m[0]);
  if (tokens.length === 0 || tokens.length !== urls.length) return text;
  let out = text;
  tokens.forEach((tok, i) => {
    out = out.replace(tok, () => urls[i]);
  });
  return out;
}

/** Drop a trailing link that just points at the tweet's own media (embedded below). */
function stripTrailingMediaUrl(text, mediaUrls) {
  const bases = new Set(mediaUrls.map((u) => u.split("?")[0].replace(/:[a-z]+$/i, "")));
  const m = text.match(/\s*(https?:\/\/\S+)\s*$/);
  if (!m) return text;
  const base = m[1].split("?")[0].replace(/:[a-z]+$/i, "");
  if (bases.has(base) || /pbs\.twimg\.com\/media\//.test(base) || /video\.twimg\.com/.test(base)) {
    return text.slice(0, m.index).trimEnd();
  }
  return text;
}

/** Clipper-style title: first ~60 chars of the tweet, word-boundary trimmed. */
function noteTitle(t, author) {
  let s = t.text.replace(/\s+/g, " ").trim();
  if (!s) return author ? `Bookmark by @${author.screenName}` : `Bookmarked tweet ${t.id}`;
  if (s.length > 60) {
    s = s.slice(0, 61);
    const cut = s.lastIndexOf(" ");
    s = (cut > 30 ? s.slice(0, cut) : s.slice(0, 60)).trim();
  }
  return s.replace(/[.,;:!?\s]+$/, "") || `Bookmarked tweet ${t.id}`;
}

function sanitizeFilename(s) {
  let out = s
    .replace(/[/\\:*?"<>|\n\r\t]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^[.\s]+/, "");
  if (out.length > 80) out = out.slice(0, 80).trim();
  return out || "Untitled";
}

function yamlString(s) {
  return JSON.stringify(s); // JSON double-quoted strings are valid YAML flow scalars
}

function buildFrontmatter({ title, source, author, published, created, tags }) {
  const lines = ["---", `title: ${yamlString(title)}`, `source: ${yamlString(source)}`];
  if (author) lines.push("author:", `  - ${yamlString(`[[@${author.screenName}]]`)}`);
  lines.push(`published: ${published || ""}`, `created: ${created}`, `description:`, "tags:");
  for (const tag of tags) lines.push(`  - ${yamlString(tag)}`);
  lines.push("---", "");
  return lines.join("\n");
}

function isProbablyImageUrl(u) {
  return /pbs\.twimg\.com\/media\//.test(u) || /\.(jpe?g|png|webp|gif)(\?|$)/i.test(u);
}

/** Rewrite a CDN url to request the large variant. */
function toLargeVariant(u) {
  let out = u.replace(/:(small|medium|large|thumb|\d+x\d+)$/i, "");
  if (/[?&]name=/.test(out)) out = out.replace(/([?&])name=[^&]*/, "$1name=large");
  else out += out.includes("?") ? "&name=large" : "?name=large";
  return out;
}

const DOWNLOAD_TIMEOUT_MS = 15_000;

async function downloadImage(url, mediaDir, baseName) {
  const res = await fetch(toLargeVariant(url), {
    headers: { "user-agent": "twitter-bookmarks-obsidian-importer/0.1 (Obsidian vault importer)" },
    signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const type = (res.headers.get("content-type") || "").toLowerCase();
  let ext =
    url.match(/\.(jpe?g|png|webp|gif)(?:\?|$)/i)?.[1] ??
    (type.startsWith("image/") ? type.split("/")[1].split(";")[0] : null);
  if (!ext || !/^(jpe?g|png|webp|gif|avif)$/.test(ext)) throw new Error(`not an image (${type || "unknown type"})`);
  ext = ext === "jpeg" ? "jpg" : ext;
  const filename = `${baseName}.${ext}`;
  fs.writeFileSync(path.join(mediaDir, filename), Buffer.from(await res.arrayBuffer()));
  return filename;
}

/**
 * Build the full note for one bookmark. Returns { filename, content }.
 * mediaEmbeds: list of lines to append after the text.
 */
function buildBody(text, author, dateStr, mediaEmbeds) {
  const header = dateStr
    ? author
      ? `**${author.displayName}** @${author.screenName} ${dateStr}`
      : `**Unknown author** ${dateStr}`
    : author
      ? `**${author.displayName}** @${author.screenName}`
      : `**Unknown author**`;
  const parts = [header, "", text.trim()];
  if (mediaEmbeds.length) parts.push("", mediaEmbeds.join("\n"));
  return parts.join("\n").trimEnd() + "\n";
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  const opts = parseArgs(process.argv.slice(2));

  if (opts.archive.toLowerCase().endsWith(".zip")) {
    fail(`"${opts.archive}" is a zip. Unzip it first, e.g.:\n  unzip -d ~/Downloads/x-archive ${JSON.stringify(opts.archive)}`);
  }
  if (!fs.existsSync(opts.archive)) fail(`archive not found: ${opts.archive}`);

  const { files, tweets } = loadBookmarks(opts.archive);
  console.log(`Found ${tweets.length} bookmarked tweet(s) in ${files.length} file(s).`);
  if (tweets.length === 0) return;

  const existing = existingStatusIds(opts.output);
  if (!opts.dryRun) fs.mkdirSync(opts.output, { recursive: true });
  if (!opts.dryRun && opts.media === "download") fs.mkdirSync(opts.mediaDir, { recursive: true });

  const createdDate = fmtDate(new Date());
  let created = 0;
  let skipped = 0;
  let mediaDownloaded = 0;
  let mediaFailed = 0;
  const usedFilenames = new Set();

  for (const t of tweets) {
    if (existing.has(t.id)) {
      skipped++;
      if (opts.verbose) console.log(`  = skip (already in vault): ${t.id}`);
      continue;
    }
    if (opts.limit && created >= opts.limit) break;

    const author = resolveAuthor(t);
    const source = canonicalSource(t, author);
    const dateStr = fmtDate(t.createdAt);

    // --- text ---
    let text = replaceTcoLinks(t.text, t.urls);
    text = stripTrailingMediaUrl(text, t.media);

    // --- media ---
    const mediaEmbeds = [];
    const baseName = `x-${t.id}`;
    for (let i = 0; i < t.media.length; i++) {
      const url = t.media[i];
      const idx = t.media.length > 1 ? i + 1 : 1;
      if (opts.media === "download" && isProbablyImageUrl(url) && !opts.dryRun) {
        try {
          const filename = await downloadImage(url, opts.mediaDir, `${baseName}-${idx}`);
          mediaEmbeds.push(`![[${filename}]]`);
          mediaDownloaded++;
          continue;
        } catch (e) {
          mediaFailed++;
          if (opts.verbose) console.log(`  ! media download failed (${e.message}): ${url}`);
        }
      }
      if (isProbablyImageUrl(url)) mediaEmbeds.push(`![media](${url})`);
      else mediaEmbeds.push(`[▶ video](${url})`);
    }

    // --- filename (unique) ---
    let stem = sanitizeFilename(noteTitle(t, author));
    if (usedFilenames.has(stem) || fs.existsSync(path.join(opts.output, `${stem}.md`))) {
      stem = `${stem} - ${t.id.slice(-8)}`;
      if (usedFilenames.has(stem)) stem = `${stem}-${created}`;
    }
    usedFilenames.add(stem);

    const frontmatter = buildFrontmatter({
      title: stem,
      source,
      author,
      published: dateStr,
      created: createdDate,
      tags: opts.tags,
    });
    const content = `${frontmatter}\n${buildBody(text, author, dateStr, mediaEmbeds)}`;

    if (opts.verbose) console.log(`  + ${stem}.md  (${source})`);
    if (!opts.dryRun) fs.writeFileSync(path.join(opts.output, `${stem}.md`), content);
    created++;
  }

  if (opts.dryRun) {
    console.log(`Dry run — would create: ${created}, already in vault: ${skipped}. No files written.`);
  } else {
    console.log(`Created ${created} note(s) in ${opts.output}`);
    console.log(`Skipped ${skipped} (already in vault).`);
    if (opts.media === "download") {
      console.log(`Media: ${mediaDownloaded} downloaded${mediaFailed ? `, ${mediaFailed} fell back to remote links` : ""}.`);
    }
  }
}

main().catch((e) => fail(e.stack ?? e.message));
