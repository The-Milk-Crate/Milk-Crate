// Builds src/data/regions-ca.json and src/data/regions-au.json: Canada's provinces and
// territories and Australia's states and territories as TopoJSON (object "regions",
// properties name / code / country), for the maps. US states come from the us-atlas package.
// Data: Natural Earth 1:10m admin-1 and lakes (public domain). Province shapes reach out to the
// border through the Great Lakes, so the larger lakes are cut out to show the real shore.
//
// The output is committed, so this only needs running to refresh the data:
//   curl -LO https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_10m_admin_1_states_provinces.geojson
//   curl -LO https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_10m_lakes.geojson
//   npm install --no-save mapshaper@0.6
//   node scripts/build-regions.mjs ne_10m_admin_1_states_provinces.geojson ne_10m_lakes.geojson
import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import mapshaper from "mapshaper";

const src = JSON.parse(readFileSync(process.argv[2], "utf8"));
const lakes = process.argv[3];
if (!lakes) throw new Error("Give the lakes file too (see the top of this script).");
// How much detail to keep (Canada's Arctic coast is enormous, so it keeps less).
const DETAIL = { CA: { simplify: "25%", minArea: "3km2" }, AU: { simplify: "60%", minArea: "1km2" } };
const dir = mkdtempSync(join(tmpdir(), "regions-"));

for (const country of Object.keys(DETAIL)) {
  const features = [];
  for (const f of src.features) {
    const p = f.properties;
    if (p.iso_a2 !== country) continue;
    let code = p.iso_3166_2.split("-")[1];
    let name = p.name.replace("Québec", "Quebec");
    if (code.startsWith("X")) {
      // Australia's external territories: Jervis Bay is drawn as part of the NSW coast, the far-off islands are left out.
      if (!/Jervis/.test(p.name)) continue;
      code = "NSW";
    }
    if (code === "NSW") name = "New South Wales"; // Lord Howe Island too
    features.push({ ...f, properties: { name, code, country } });
  }
  const input = join(dir, `${country}.geojson`);
  writeFileSync(input, JSON.stringify({ type: "FeatureCollection", features }));
  const out = new URL(`../src/data/regions-${country.toLowerCase()}.json`, import.meta.url).pathname;
  const { simplify, minArea } = DETAIL[country];
  await mapshaper.runCommands(
    `-i ${input} ${lakes} combine-files -rename-layers regions,lakes -filter target=lakes 'scalerank <= 4' -erase lakes target=regions ` +
      `-dissolve code copy-fields=name,country target=regions -simplify ${simplify} keep-shapes target=regions ` +
      `-filter-islands min-area=${minArea} target=regions -o target=regions format=topojson quantization=1e5 ${out}`,
  );
  console.log(`${country}: wrote ${out}`);
}
