// TV stage scaler (DESIGN.md "Global rules"): a fixed 1920x1080 stage scaled uniformly into its parent, centred, letterbox = bg colour.
//   const { root, stage, screen, dispose } = createStage(parentEl);   // put TV UI in `screen` (or `stage`)
// scale = min(w/1920, h/1080). No re-layout for other aspect ratios. Also hides the mouse cursor after `hideCursorMs` of idle (Interaction rules).
export const TV_W = 1920, TV_H = 1080;

export function createStage(parent, { theme = 'dark', hideCursorMs = 3000, className = '' } = {}) {
  const doc = parent.ownerDocument;
  const root = doc.createElement('div'); root.className = `pm-root ${className}`.trim();
  if (theme === 'day') root.setAttribute('data-theme', 'day');
  const stage = doc.createElement('div'); stage.className = 'pm-stage';
  const screen = doc.createElement('div'); screen.className = 'pm-screen';
  stage.appendChild(screen); root.appendChild(stage); parent.appendChild(root);

  let scale = 1;
  const fit = () => {
    const w = root.clientWidth || parent.clientWidth || TV_W, h = root.clientHeight || parent.clientHeight || TV_H;
    scale = Math.min(w / TV_W, h / TV_H);
    stage.style.transform = `translate(${(-TV_W * scale) / 2}px, ${(-TV_H * scale) / 2}px) scale(${scale})`;
    root.style.setProperty('--pm-scale', String(scale));
  };
  fit();
  const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(fit) : null; ro?.observe(root);
  const onWin = () => fit(); doc.defaultView.addEventListener('resize', onWin);

  let idle = 0;
  const wake = () => { root.classList.remove('is-idle-cursor'); clearTimeout(idle); if (hideCursorMs > 0) idle = setTimeout(() => root.classList.add('is-idle-cursor'), hideCursorMs); };
  root.addEventListener('pointermove', wake); root.addEventListener('pointerdown', wake); wake();

  return {
    root, stage, screen,
    get scale() { return scale; },
    fit,
    dispose() { ro?.disconnect(); doc.defaultView.removeEventListener('resize', onWin); clearTimeout(idle); root.remove(); },
  };
}
