// Surface table for the vehicle physics (SpaceX). Source of truth is this object; ../../surfaces.json is the
// same table as plain JSON for tools/other languages (tests/surfaces-sync check keeps them identical), and
// loadSurfaces(url) can replace values at runtime without a code change.
//
// grip   : tyre friction multiplier relative to hard dirt. These are the architecture.md starting values
//          (tarmac/hard dirt 1.0, gravel .75, mud .45, sand .55, snow .4, ice .15, water .6).
//          Rows marked "added" are not in the doc table (grass, rock) and were derived from Pixel's tuned prototype.
// side   : sideways stiffness multiplier (Rapier side friction stiffness), from Pixel's prototype.
// roll   : rolling resistance, N per (m/s) per tonne per wheel (Pixel's prototype units).
// sink   : how far tyres dig in (drives extra drag and cuts engine force); `sinkSlowOnly` = sinks mostly when slow (sand).
// Final tyre friction used by the vehicle = BASE_MU * tyres.gripScale * grip * tyres.surfaceGrip[id].
export const BASE_MU = 0.70; // hard-dirt friction of the stock all-terrain tyre (Pixel's tuned dirt value)

export const SURFACES = {
  tarmac: { id: 8,  name: 'Tarmac', grip: 1.0,  side: 0.95, roll: 90,   sink: 0.00, colour: 0x4a4a4e }, // doc row "tarmac/hard dirt"
  dirt:   { id: 0,  name: 'Dirt',   grip: 1.0,  side: 0.85, roll: 140,  sink: 0.00, colour: 0x8a6a45 },
  grass:  { id: 1,  name: 'Grass',  grip: 0.71, side: 0.75, roll: 220,  sink: 0.00, colour: 0x557f35 }, // added
  gravel: { id: 2,  name: 'Gravel', grip: 0.75, side: 0.70, roll: 260,  sink: 0.02, colour: 0x8f8a80 },
  mud:    { id: 3,  name: 'Mud',    grip: 0.45, side: 0.45, roll: 900,  sink: 0.10, colour: 0x4b3622 },
  sand:   { id: 4,  name: 'Sand',   grip: 0.55, side: 0.55, roll: 650,  sink: 0.06, colour: 0xd8c08a, sinkSlowOnly: true },
  snow:   { id: 5,  name: 'Snow',   grip: 0.40, side: 0.40, roll: 380,  sink: 0.04, colour: 0xeef2f6 },
  water:  { id: 6,  name: 'Water',  grip: 0.60, side: 0.50, roll: 700,  sink: 0.00, colour: 0x5a4a35 }, // shallow-water bed; depth drag handled separately
  rock:   { id: 7,  name: 'Rock',   grip: 1.21, side: 0.90, roll: 120,  sink: 0.00, colour: 0x6f6b66 }, // added
  ice:    { id: 9,  name: 'Ice',    grip: 0.15, side: 0.25, roll: 40,   sink: 0.00, colour: 0xbfe3f2 },
};

export const SURFACE_NAMES_BY_ID = Object.fromEntries(Object.entries(SURFACES).map(([k, v]) => [v.id, k]));

/** Plain-JSON form of the table (what game/surfaces.json contains). */
export const surfacesToJSON = () => JSON.parse(JSON.stringify({ baseMu: BASE_MU, surfaces: SURFACES }));

/** Merge a surfaces.json-shaped object over the built-in table (mutates SURFACES). */
export function applySurfaces(json) {
  if (typeof json.baseMu === 'number') /* BASE_MU is const; exposed through surfaceBaseMu() */ _baseMu = json.baseMu;
  for (const [k, v] of Object.entries(json.surfaces || {})) SURFACES[k] = { ...(SURFACES[k] || {}), ...v };
  for (const k of Object.keys(SURFACE_NAMES_BY_ID)) delete SURFACE_NAMES_BY_ID[k];
  for (const [k, v] of Object.entries(SURFACES)) SURFACE_NAMES_BY_ID[v.id] = k;
}
let _baseMu = BASE_MU;
export const surfaceBaseMu = () => _baseMu;

/** Fetch (browser) or read (Node) a surfaces.json and apply it. */
export async function loadSurfaces(url) {
  const { readText } = await import('./io.js');
  applySurfaces(JSON.parse(await readText(url)));
}
