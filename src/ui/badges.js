// Player identity art shared by the TV lobby and the phone join flow: seat = colour token + shape + number (never colour only).
export const SEATS = 4;
/** Player identity: colour token + shape + number (never colour only). Index = seat (0..3). */
export const SEAT_STYLE = [
  { shape: 'circle', color: 'var(--color-player-1)', label: 'circle' },
  { shape: 'triangle', color: 'var(--color-player-2)', label: 'triangle' },
  { shape: 'square', color: 'var(--color-player-3)', label: 'square' },
  { shape: 'diamond', color: 'var(--color-player-4)', label: 'diamond' },
];
export const SHAPES = { // 80x80 badge art from Prism's mock. y offsets keep the digit optically centred.
  circle: { d: '<circle cx="40" cy="40" r="38"/>', ty: 53 },
  triangle: { d: '<path d="M40 4 L76 70 Q78 76 72 76 L8 76 Q2 76 4 70Z"/>', ty: 60, fs: 30 },
  square: { d: '<rect x="4" y="4" width="72" height="72" rx="16"/>', ty: 53 },
  diamond: { d: '<path d="M40 2 L78 40 L40 78 L2 40Z" stroke-linejoin="round" stroke="var(--p)" stroke-width="6"/>', ty: 53 },
};
