// Game-wide constants (Parrot, src/core). Everything that needs "how many players" or "which quality" reads it here.
import { QUALITY_TIERS } from '../data/settings.js';

/** THE player limit for Party Mode. index.html passes it to PartyHost({ maxPlayers }). Forge load-tests 8 for headroom. */
export const MAX_PLAYERS = 4;

export const PHYSICS_HZ = 60;
export const FEEDBACK_HZ = 5;          // host -> phone fb messages (speed, gear, surface)
export const DEFAULT_VEHICLE = 'offroad_4x4';
export const VEHICLE_STATS_URL = (id) => `./vehicles/${id === 'offroad_4x4' ? 'trail-4x4' : id}.json`; // see INTEGRATION.md: offroad_4x4.json is Forma's descriptor, not a physics stats file
export const WORLD_URL = './src/world';

const params = () => new URLSearchParams(globalThis.location?.search || '');

/**
 * Quality tier. Priority: ?q=low|medium|high, then the saved setting (graphics.qualityTier), then 'auto':
 * phones and 3-4 split-screen views start on 'medium'/'low', a single view on a big screen on 'high'.
 * Vanta's renderer then steps resolution/shadows down on its own if frame rate drops.
 */
export function resolveTier(settings, views = 1) {
  const q = params().get('q');
  if (QUALITY_TIERS.includes(q)) return q;
  const saved = settings?.graphics?.qualityTier;
  if (QUALITY_TIERS.includes(saved)) return saved;
  const coarse = globalThis.matchMedia?.('(pointer: coarse)').matches;
  if (views >= 3) return 'low';
  if (views === 2 || coarse) return 'medium';
  return 'high';
}
