// Used by .github/workflows/build.yml before a release build.
// Sets the app version, turns on signed update files, and points the
// app's updater at this repository's newest GitHub Release.
import { readFileSync, writeFileSync } from "node:fs";

const { VERSION, REPO, HAS_KEY } = process.env;
if (HAS_KEY !== "true") {
  console.log("::error::Add the TAURI_SIGNING_PRIVATE_KEY and TAURI_SIGNING_PRIVATE_KEY_PASSWORD secrets (see README → Automatic updates).");
  process.exit(1);
}
if (!VERSION || !REPO) throw new Error("VERSION and REPO must be set");

const file = "src-tauri/tauri.conf.json";
const conf = JSON.parse(readFileSync(file, "utf8"));
conf.version = VERSION;
conf.bundle.createUpdaterArtifacts = true;
conf.plugins.updater.endpoints = [`https://github.com/${REPO}/releases/latest/download/latest.json`];
writeFileSync(file, JSON.stringify(conf, null, 2) + "\n");
console.log(`Milk Crate ${VERSION}, updates from ${conf.plugins.updater.endpoints[0]}`);
