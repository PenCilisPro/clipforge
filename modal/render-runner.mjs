#!/usr/bin/env node
/**
 * Modal render entrypoint — runs the ClipForge ffmpeg render for ONE clip.
 *
 * This is a thin wrapper around the worker's own renderer (lib/localRender.js),
 * so the Modal provider and the local provider produce byte-for-byte the same
 * footage: same filtergraph, same ASS captions, same 9:16 layouts, same
 * watermark/music mixing, and the same OOM fallback to 720x1280.
 *
 * usage: node render-runner.mjs <spec.json> <clipId>
 *
 * env:
 *   TMP_DIR          scratch dir for the encode (default /tmp/clipforge)
 *   RENDER_THREADS   ffmpeg thread count (Modal sets 4)
 *   RENDER_LIB_DIR   dir holding localRender.js — defaults to ./src/lib,
 *                    which is where the Modal image puts it
 */
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const [specPath, clipId] = process.argv.slice(2);
if (!specPath || !clipId) {
  console.error("usage: node render-runner.mjs <spec.json> <clipId>");
  process.exit(2);
}

const TMP_DIR = process.env.TMP_DIR ?? "/tmp/clipforge";
const localRenderUrl = process.env.RENDER_LIB_DIR
  ? new URL("localRender.js", pathToFileURL(`${process.env.RENDER_LIB_DIR}${path.sep}`)).href
  : new URL("./src/lib/localRender.js", import.meta.url).href;

const { submitRender } = await import(localRenderUrl);

const spec = JSON.parse(await fs.readFile(specPath, "utf8"));
await fs.mkdir(TMP_DIR, { recursive: true });

// submitRender renders inline, handles the OOM retry, and returns local-<clipId>.
const renderId = await submitRender(spec, null, { clipId });
const output = path.join(TMP_DIR, `render-${renderId}.mp4`);

// The Modal function parses this line to find (and move) the finished MP4.
console.log(`[render-runner] output ${output}`);
