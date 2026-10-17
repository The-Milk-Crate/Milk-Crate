// Builds the city lists Milk Crate uses: every city and town with 1,000+ people
// (not neighborhoods) in each country Milk Crate covers, largest first:
//   public/cities-us.json, public/cities-ca.json, public/cities-au.json
// Each row: name, state/province code, latitude, longitude, population.
// Data: GeoNames (CC BY 4.0) via the all-the-cities package.
//
// The output is committed, so this only needs running to refresh the data:
//   npm install --no-save all-the-cities@3.1.0 && node scripts/build-cities.mjs
import { writeFileSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const cities = require("all-the-cities");

// GeoNames numbers Canadian provinces and Australian states; Milk Crate uses the postal codes.
const REGION = {
  US: (code) => code,
  CA: (code) => ({ "01": "AB", "02": "BC", "03": "MB", "04": "NB", "05": "NL", "07": "NS", "08": "ON", "09": "PE", "10": "QC", "11": "SK", "12": "YT", "13": "NT", "14": "NU" })[code],
  AU: (code) => ({ "01": "ACT", "02": "NSW", "03": "NT", "04": "QLD", "05": "SA", "06": "TAS", "07": "VIC", "08": "WA" })[code],
};

for (const country of Object.keys(REGION)) {
  const best = new Map();
  for (const c of cities) {
    if (c.country !== country || c.population < 1000) continue;
    // Skip neighborhoods ("section of a populated place": West Raleigh, Harlem) and abandoned places.
    if (c.featureCode === "PPLX" || c.featureCode === "PPLQ") continue;
    const region = REGION[country](c.adminCode);
    if (!region) continue;
    const key = `${c.name}|${region}`;
    if ((best.get(key)?.c.population ?? -1) < c.population) best.set(key, { c, region });
  }
  const rows = [...best.values()]
    .sort((a, b) => b.c.population - a.c.population)
    .map(({ c, region }) => {
      const [lng, lat] = c.loc.coordinates;
      return [c.name, region, Math.round(lat * 1e4) / 1e4, Math.round(lng * 1e4) / 1e4, c.population];
    });
  writeFileSync(
    new URL(`../public/cities-${country.toLowerCase()}.json`, import.meta.url),
    JSON.stringify({ source: "GeoNames (CC BY 4.0), via all-the-cities", country, fields: ["name", "state", "lat", "lng", "population"], cities: rows }),
  );
  console.log(`${country}: wrote ${rows.length} cities`);
}
