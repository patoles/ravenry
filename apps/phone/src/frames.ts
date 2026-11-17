// A video's first frame as a picture (the pickvideo round's fourth part,
// 2026-11-16): drawn once by a player of its own, one video at a time, shown
// over a thumbnail waiting for it while it loads, and that player let go at
// once (paused, its source dropped, taken off the page), so a thumbnail
// (the swipe track, the strip) holds no player. Kept as <video> elements, a
// pick's thumbnails were made again at each redraw, each a player loading its
// video; the ones left behind went on loading until, on an iPad, the video
// being watched loaded for ever.

/** A video's first frame drawn (an object URL), null when the video cannot be read, undefined when not yet. */
const done = new Map<string, string | null>();
/** The videos that could not be read at all (a thumbnail says it is missing). */
const broken = new Set<string>();
const waiting = new Map<string, Promise<string | null>>();
let line: Promise<unknown> = Promise.resolve();

/** The videos this engine cannot decode (the webm round, 2026-11-17): the still that says so takes their place. */
const cant = new Set<string>();
const types = new Map<string, string>();
/** Whether this engine cannot play the video at `url`: the hub's type (`videoType`) it says it cannot play, or a player that refused its type or no frame seen before. */
export function videoCant(url: string, type?: string | null): boolean {
  if (type) types.set(url, type);
  if (cant.has(url)) return true;
  const t = type || types.get(url);
  try { if (t && document.createElement('video').canPlayType(t) === '') { cant.add(url); return true; } } catch { /* none */ }
  return false;
}
export const markCant = (url: string): void => { cant.add(url); };

export const frameNow = (url: string): string | null | undefined => done.get(url);

/** A frame drawn on a canvas the page may show but not read: `canvas:<url>` in place of a picture's URL. */
export const CANVAS = 'canvas:';
const drawnOn = new Map<string, HTMLCanvasElement>();
/** A canvas of its own with the video's first frame (one drawn but not readable), for a thumbnail; null when none. */
export function frameCanvas(url: string): HTMLCanvasElement | null {
  const src = drawnOn.get(url);
  if (!src) return null;
  const c = document.createElement('canvas');
  c.width = src.width;
  c.height = src.height;
  c.dataset.frame = url;
  c.getContext('2d')?.drawImage(src, 0, 0);
  return c;
}
export const frameBroken = (url: string): boolean => broken.has(url);

/** The first frame of the video at `url`: drawn once, the videos one after another. */
export function frameOf(url: string): Promise<string | null> {
  if (done.has(url)) return Promise.resolve(done.get(url) ?? null);
  let p = waiting.get(url);
  if (!p) {
    // A frame that could not be drawn (and a video that can be read) is asked for again by the next thumbnail drawn.
    // Asked again (three times in all) while a thumbnail on the page waits for it.
    const waits = () => [...document.querySelectorAll<HTMLImageElement>('img[data-frame]')].some((i) => i.dataset.frame === url && i.isConnected);
    const tries = async (): Promise<string | null> => { for (let k = 0; k < 3; k++) { if (cant.has(url)) return null; const u = await grab(url); if (u || broken.has(url) || cant.has(url) || !waits()) return u; } return null; };
    p = line.then(tries).then((u) => { if (u || broken.has(url) || cant.has(url)) done.set(url, u); waiting.delete(url); return u; });
    line = p.catch(() => null);
    waiting.set(url, p);
  }
  return p;
}

function grab(url: string): Promise<string | null> {
  return new Promise((resolve) => {
    const v = document.createElement('video');
    v.muted = true;
    v.playsInline = true;
    v.preload = 'auto';
    for (const a of ['muted', 'playsinline', 'webkit-playsinline']) v.setAttribute(a, '');
    v.setAttribute('aria-hidden', 'true');
    v.tabIndex = -1;
    // On the page, where the frame will show (an iPhone loads a video's first frame only for one it draws): over a
    // thumbnail waiting for it, else a speck in a corner.
    // A redraw that takes the thumbnail away moves it to the one that took its place.
    const home = () => {
      const host = [...document.querySelectorAll<HTMLImageElement>('img[data-frame]')].find((i) => i.dataset.frame === url && i.isConnected && i.parentElement && i.getClientRects().length);
      if (v.isConnected && (host ? v.parentElement === host.parentElement : v.parentElement === document.body)) return;
      Object.assign(v.style, host
        ? { left: '', bottom: '', position: 'absolute', inset: '0', width: '100%', height: '100%', objectFit: 'contain', pointerEvents: 'none', opacity: '1' }
        : { inset: '', position: 'fixed', left: '0', bottom: '0', width: '2px', height: '2px', opacity: '0.01', pointerEvents: 'none' });
      (host ? host.parentElement! : document.body).appendChild(v);
    };
    home();
    const moving = setInterval(home, 300);
    let over = false;
    const end = (out: string | null) => {
      if (over) return;
      over = true;
      clearTimeout(timer);
      clearInterval(moving);
      v.pause();
      v.removeAttribute('src');
      v.load();
      v.remove();
      resolve(out);
    };
    // Its size read and no frame in 15 s: this engine cannot decode it.
    const timer = setTimeout(() => { if (v.readyState === 1) cant.add(url); end(null); }, 15000);
    // Drawn: some pixel has colour (an engine that has not decoded the frame draws nothing at all).
    let drawn = false;
    const draw = (): boolean => {
      if (drawn) return true;
      const w = v.videoWidth, hh = v.videoHeight;
      if (!w || !hh || v.readyState < 2) return false;
      const k = Math.min(1, 1920 / w);
      const c = document.createElement('canvas');
      c.width = Math.max(1, Math.round(w * k));
      c.height = Math.max(1, Math.round(hh * k));
      const g = c.getContext('2d');
      if (!g) { end(null); return true; }
      try {
        const has = (): boolean => { const px = g.getImageData(0, 0, c.width, c.height).data; for (let i = 3; i < px.length; i += 4 * 97) if (px[i]) return true; return false; };
        g.drawImage(v, 0, 0, c.width, c.height);
        if (!has()) return false;
        drawn = true;
        c.toBlob((b) => end(b ? URL.createObjectURL(b) : null), 'image/jpeg', 0.86);
      } catch (e) {
        // A frame the page may draw but not read (WebKit's own WebM player through the iPhone app's shell: a
        // SecurityError): the canvas it was drawn on is the frame, shown as it is (frameCanvas).
        if ((e as Error).name === 'SecurityError') { drawn = true; drawnOn.set(url, c); end(`${CANVAS}${url}`); } else end(null);
      }
      return true;
    };
    let played = false;
    const tryDraw = () => {
      if (over || draw()) return;
      // Not decoded until it plays (some engines): a moment of it, muted, then drawn.
      if (played) return;
      played = true;
      // Drawn at the first moment it shows; given up after a second of it.
      v.addEventListener('timeupdate', () => { if (!over && v.currentTime > 0) { if (draw()) v.pause(); else if (v.currentTime > 1) end(null); } });
      const pl = v.play();
      if (pl && pl.catch) pl.catch(() => end(null));
    };
    v.addEventListener('seeked', tryDraw);
    v.addEventListener('loadeddata', () => { if (!v.seeking) tryDraw(); });
    // A type it does not play (MEDIA_ERR_SRC_NOT_SUPPORTED): it cannot play here; else (a decode error can pass) it cannot be read now.
    v.addEventListener('error', () => { if (v.error && v.error.code === 4) cant.add(url); else broken.add(url); end(null); });
    v.src = `${url}#t=0.001`;
  });
}
