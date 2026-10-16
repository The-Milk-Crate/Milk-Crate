// Builds public/cities-us.json: every US city and town with 1,000+ people (not neighborhoods)
// (name, state, latitude, longitude, population), largest first.
// Data: GeoNames (CC BY 4.0) via the all-the-cities package.
//
// The output is committed, so this only needs running to refresh the data:
//   npm install --no-save all-the-cities@3.1.0 && node scripts/build-cities.mjs
import { writeFileSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const cities = require("all-the-cities");

const best = new Map();
for (const c of cities) {
  if (c.country !== "US" || c.population < 1000) continue;
  // Skip neighborhoods ("section of a populated place": West Raleigh, Harlem) and abandoned places.
  if (c.featureCode === "PPLX" || c.featureCode === "PPLQ") continue;
  const key = `${c.name}|${c.adminCode}`;
  if ((best.get(key)?.population ?? -1) < c.population) best.set(key, c);
}
const rows = [...best.values()]
  .sort((a, b) => b.population - a.population)
  .map((c) => {
    const [lng, lat] = c.loc.coordinates;
    return [c.name, c.adminCode, Math.round(lat * 1e4) / 1e4, Math.round(lng * 1e4) / 1e4, c.population];
  });
writeFileSync(
  new URL("../public/cities-us.json", import.meta.url),
  JSON.stringify({ source: "GeoNames (CC BY 4.0), via all-the-cities", fields: ["name", "state", "lat", "lng", "population"], cities: rows }),
);
console.log(`Wrote ${rows.length} cities`);
