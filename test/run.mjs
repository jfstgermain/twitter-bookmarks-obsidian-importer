#!/usr/bin/env node
/**
 * Integration test for import.mjs.
 * Builds a fake X archive + a local HTTP media server, then verifies:
 *   1. notes are created with correct frontmatter/body
 *   2. t.co links are expanded
 *   3. media is downloaded from the CDN and embedded as a wikilink
 *   4. failed media downloads fall back to remote links
 *   5. existing notes (matched by status id) are skipped
 *   6. re-running imports nothing new (idempotent)
 *   7. --dry-run writes nothing
 * No network access required.
 */

import { createServer } from "node:http";
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const runChild = promisify(execFile);

const root = path.dirname(fileURLToPath(import.meta.url));
const importer = path.join(root, "..", "import.mjs");

// 1x1 JPEG
const JPEG_B64 =
  "/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPDs0NDT/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAABAAEDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/9oADAMBAAIRAxEAPwD3+iiigD//2Q==";

let failures = 0;
function check(cond, msg) {
  if (cond) console.log(`  ok   ${msg}`);
  else {
    failures++;
    console.error(`  FAIL ${msg}`);
  }
}

async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tb-importer-test-"));
  const archiveDir = path.join(tmp, "archive", "data");
  const vault = path.join(tmp, "vault");
  const clippings = path.join(vault, "Clippings");
  fs.mkdirSync(archiveDir, { recursive: true });
  fs.mkdirSync(clippings, { recursive: true });

  // --- local media server (stands in for pbs.twimg.com) ---
  let port = 0;
  const server = createServer((req, res) => {
    if (req.url.startsWith("/pix.jpg")) {
      res.writeHead(200, { "content-type": "image/jpeg" });
      res.end(Buffer.from(JPEG_B64, "base64"));
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  port = server.address().port;

  // --- fixture archive: modern shape, old date format, media, canonical-URL author ---
  const bookmarks = [
    {
      bookmark: {
        tweetId: "1111111111111111111",
        fullText: "Great thread about building in public https://t.co/aaaa1111",
        createdAt: "2024-06-03T12:00:00.000Z",
        expandedUrls: ["https://example.com/thread/1"],
        mediaUrls: [],
      },
    },
    {
      bookmark: {
        tweetId: "2222222222222222222",
        fullText: "This one is already clipped, should be skipped",
        createdAt: "Mon Jun 10 08:30:00 +0000 2024",
        expandedUrls: [],
        mediaUrls: [],
        screenName: "naval",
      },
    },
    {
      bookmark: {
        tweetId: "3333333333333333333",
        fullText: "Check out this chart https://t.co/cccc3333",
        createdAt: "2025-01-15T09:00:00.000Z",
        expandedUrls: [
          "https://x.com/visuallyrich/status/3333333333333333333",
          "https://pbs.twimg.com/media/ZZZZZZnopeZZZZ.jpg",
        ],
        mediaUrls: [`http://127.0.0.1:${port}/missing.jpg?format=jpg&name=small`],
      },
    },
    {
      bookmark: {
        tweetId: "4444444444444444444",
        fullText: "Local media test",
        createdAt: "2025-02-01T00:00:00.000Z",
        expandedUrls: [],
        mediaUrls: [`http://127.0.0.1:${port}/pix.jpg?format=jpg&name=small`],
      },
    },
  ];
  fs.writeFileSync(path.join(archiveDir, "bookmarks.js"), `window.YTD.bookmarks.part0 = ${JSON.stringify(bookmarks, null, 1)}`);

  // --- pre-existing clipper-style note covering tweet 2222 ---
  fs.writeFileSync(
    path.join(clippings, "Already clipped.md"),
    `---\ntitle: "Already clipped"\nsource: "https://x.com/naval/status/2222222222222222222"\nauthor:\n  - "[[@naval]]"\npublished: 2024-06-10\ncreated: 2024-06-11\ndescription:\ntags:\n  - "clippings"\n---\n\nbody\n`,
  );

  async function run(args) {
    // async so the local media server (same process) can respond while the child runs
    const { stdout } = await runChild(process.execPath, [importer, ...args], { encoding: "utf8", timeout: 120_000 });
    return stdout;
  }

  try {
    // --- run 1: normal import ---
    console.log("run 1: import");
    const out1 = await run(["--output", clippings, "--media-dir", path.join(vault, "Attachments"), "--tags", "clippings,x-bookmark", path.join(tmp, "archive")]);
    if (process.env.VERBOSE) console.log(out1);

    const mdFiles = fs.readdirSync(clippings).filter((f) => f.endsWith(".md"));
    check(mdFiles.length === 4, `4 notes in Clippings after import (got ${mdFiles.length})`);
    check(/Created 3 note/.test(out1), "reports 3 created");
    check(/Skipped 1/.test(out1), "reports 1 skipped");

    const read = (f) => fs.readFileSync(path.join(clippings, f), "utf8");
    const find = (needle) => mdFiles.find((f) => read(f).includes(needle));

    const n1 = find("1111111111111111111");
    check(Boolean(n1), "note for tweet 1111 exists");
    if (n1) {
      const c = read(n1);
      check(c.includes('source: "https://x.com/i/web/status/1111111111111111111"'), "1111: fallback source URL");
      check(c.includes("https://example.com/thread/1"), "1111: t.co link expanded");
      check(!c.includes("t.co/aaaa1111"), "1111: t.co token removed");
      check(c.includes('  - "clippings"') && c.includes('  - "x-bookmark"'), "1111: both tags present");
      check(c.includes("published: 2024-06-03"), "1111: published date");
    }

    const n3 = find("3333333333333333333");
    check(Boolean(n3), "note for tweet 3333 exists");
    if (n3) {
      const c = read(n3);
      check(c.includes('source: "https://x.com/visuallyrich/status/3333333333333333333"'), "3333: author inferred from canonical URL");
      check(c.includes('"[[@visuallyrich]]"'), "3333: author wikilink in frontmatter");
      check(c.includes("**visuallyrich** @visuallyrich 2025-01-15"), "3333: body header");
      check(c.includes("![media](http://127.0.0.1:" + port + "/missing.jpg?format=jpg&name=small)"), "3333: failed download fell back to remote embed");
    }

    const n4 = find("4444444444444444444");
    check(Boolean(n4), "note for tweet 4444 exists");
    if (n4) {
      const c = read(n4);
      check(c.includes("![[x-4444444444444444444-1.jpg]]"), "4444: wikilink embed of downloaded media");
    }
    check(
      fs.existsSync(path.join(vault, "Attachments", "x-4444444444444444444-1.jpg")),
      "media file downloaded into media dir",
    );

    // --- run 2: idempotent re-run ---
    console.log("run 2: re-run (dedup)");
    const out2 = await run(["--output", clippings, "--media-dir", path.join(vault, "Attachments"), path.join(tmp, "archive")]);
    check(/Created 0 note/.test(out2), "second run creates 0 notes");
    const mdFiles2 = fs.readdirSync(clippings).filter((f) => f.endsWith(".md"));
    check(mdFiles2.length === 4, "no new files after re-run");

    // --- run 3: dry run on a fresh vault writes nothing ---
    console.log("run 3: dry-run");
    const fresh = path.join(tmp, "fresh-vault", "Clippings");
    const out3 = await run(["--output", fresh, "--media", "url", "--dry-run", path.join(tmp, "archive")]);
    check(/would create: 4/i.test(out3), "dry-run reports 4 would-be notes");
    check(!fs.existsSync(fresh) || fs.readdirSync(fresh).length === 0, "dry-run wrote no files");
  } finally {
    server.close();
    if (!process.env.KEEP) fs.rmSync(tmp, { recursive: true, force: true });
    else console.log(`\nkept temp dir: ${tmp}`);
  }

  console.log(failures === 0 ? "\nALL TESTS PASSED" : `\n${failures} TEST(S) FAILED`);
  process.exitCode = failures === 0 ? 0 : 1;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
