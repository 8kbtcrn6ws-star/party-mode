// Public exports of src/physics (SpaceX). Other folders import only from here.
export { createVehicle, Vehicle, setDefaultSurfaceLookup } from './vehicle.js';
export { toSpec, PHYSICS_DEFAULTS } from './stats.js';
export { SURFACES, BASE_MU, SURFACE_NAMES_BY_ID, surfacesToJSON, applySurfaces, loadSurfaces } from './surfaces.js';
export { initPhysics, createFixedStepper, createPhysicsWorld, PHYSICS_HZ } from './world.js';
export { createStreamingTerrain, attachStreamingTerrain, createChunkStore, loadTerrain, loadWorld, createTerrainTrimesh, createTerrain, createFunctionTerrain, createTerrainCollider } from './terrain.js';
export { loadVehicleStats, applyGeometryDescriptor, modelToPhysics, MODEL_FORWARDS } from './geometry.js';
export { decodePng } from './png.js';
export { readBytes } from './io.js';
