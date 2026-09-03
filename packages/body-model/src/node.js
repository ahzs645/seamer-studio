// The same loader, reading the files off disk. Kept on its own entry point so a
// browser bundle never has to resolve `node:fs`.

import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { loadBodyModel, modelFolder } from "./assets.js";

async function fetchJson(url) {
  return JSON.parse(await readFile(new URL(url), "utf8"));
}

async function fetchBytes(url) {
  const bytes = await readFile(new URL(url));
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
}

// `folder` is a file: URL or a path; the package's own `models/` by default.
function loadBodyModelFromDisk(folder = modelFolder, options = {}) {
  const url = folder instanceof URL ? folder.href : folder.startsWith("file:") ? folder : pathToFileURL(folder).href;
  return loadBodyModel(url, { ...options, fetchJson, fetchBytes });
}

export { loadBodyModelFromDisk, fetchJson, fetchBytes };
