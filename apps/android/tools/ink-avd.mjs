#!/usr/bin/env node
// Writes the launch's Ink (docs/PHONE.md, The launch; the approved mockup
// variant A, phoneink A): the splash's AnimatedVectorDrawable and the still
// mark, for night and day, from the mark's own geometry (brand/ravenry, the
// launcher's foreground). Ink drops gather and merge into the raven inside the
// splash circle and its eye opens with one ripple, in 1000 ms; then the app's
// own exit (InkLaunch.kt) flies the mark to the board's top bar.
//
// A vector cannot run the Mac's ink shader, so the ink is drawn with what an
// AVD has: paths with fill and stroke alpha and colour, group translate,
// scale and rotation, motion along a path, and a path morph (the body from a
// small wobbly blob to the raven, the same commands). Soft edges are extra
// copies, larger and fainter.
//
//   node tools/ink-avd.mjs        (in apps/android; writes res/drawable*/ink_*.xml)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'app', 'src', 'main', 'res');
const BODY = [['M',95,34],['C',89,28,82,24,75,23],['C',66,21,58,24,54,30],['C',50,36,46,40,40,46],['C',32,54,24,64,18,74],
  ['L',6,92],['L',20,94],['L',28,84],['C',36,80,48,78,56,76],['C',68,72,76,62,76,52],['C',76,46,74,43,78,40],['C',84,37,90,36,95,34]];
const f2 = (n) => (+n).toFixed(2).replace(/\.?0+$/, '') || '0';
const segsToD = (segs) => segs.map((s) => s[0] + s.slice(1).map(f2).join(',')).join(' ') + ' Z';
const BODY_D = segsToD(BODY);
const LEGS_D = 'M50,74 h5 v12 h-5 Z M60,72 h5 v14 h-5 Z';
const PERCH_D = 'M34,85 H86 a3,3 0 0 1 0,6 H34 a3,3 0 0 1 0,-6 Z';
const EYE = { x: 65, y: 32, r: 6.5 };
const GC = { x: 50.5, y: 58.5 };
const C = { x: 52, y: 58 };
const S = 1.55; // dp per mark unit in the 288 dp splash icon (the mockup's SPL.s)
const circle = (cx, cy, r) => `M${f2(cx - r)},${f2(cy)} a${f2(r)},${f2(r)} 0 1,0 ${f2(2 * r)},0 a${f2(r)},${f2(r)} 0 1,0 ${f2(-2 * r)},0 Z`;

const TH = {
  night: { ink: '#F2F2F4', early: '#3D5C94', eye: '#0A84FF' },
  day: { ink: '#1D1D1F', early: '#7F93B5', eye: '#2F6FEB' },
};
const alphaHex = (a) => Math.round(a * 255).toString(16).padStart(2, '0').toUpperCase();
const argb = (hex, a = 1) => `#${alphaHex(a)}${hex.slice(1)}`;

// ---- the geometry of variant A (phoneink-mock/src/ink.html)
const BLOB = BODY.map((s) => { const o = [s[0]]; for (let i = 1; i < s.length; i += 2) { const dx = s[i] - C.x, dy = s[i + 1] - C.y; const a = Math.atan2(dy, dx);
  const r = 8 + 3.2 * Math.sin(3 * a + 1.3) + 1.6 * Math.cos(5 * a); o.push(C.x + Math.cos(a) * r, C.y + Math.sin(a) * r); } return o; });
const BLOB_D = segsToD(BLOB);
let seed = 11; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
const TARGETS = [[40,60],[55,45],[66,34],[72,50],[30,68],[18,80],[48,66],[62,62],[80,36],[58,30],[44,88],[70,88],[36,75],[52,82],[26,76],[64,44],[47,54],[74,30],[58,88],[12,88]];
const DROPS = TARGETS.map((tg, i) => { const a0 = rnd() * Math.PI * 2; const r0 = 22 + rnd() * 40;
  return { tg, a0, r0, rad: 1.6 + Math.pow(rnd(), 1.6) * 5.4, d: i * 0.018 + rnd() * 0.03, turn: 0.9 + rnd() * 0.5 }; });
function dropPos(dp, u) { const tx = dp.tg[0] - C.x, ty = dp.tg[1] - C.y; const aT = Math.atan2(ty, tx), rT = Math.hypot(tx, ty);
  let a1 = aT; while (a1 < dp.a0 + dp.turn) a1 += Math.PI * 2; a1 -= Math.PI * 2; if (a1 < dp.a0) a1 += Math.PI * 2;
  const a = dp.a0 + (a1 - dp.a0) * u, r = dp.r0 + (rT - dp.r0) * u; return [C.x + Math.cos(a) * r, C.y + Math.sin(a) * r]; }

// ---- interpolators (the mockup's curves)
const I = { FOSI: 'fosi', EMPH: 'emph', STD: 'std', LIN: 'lin', RIPPLE: 'ripple' };
const INTERP = { fosi: [0.4, 0, 0.2, 1], emph: [0.05, 0.7, 0.1, 1], std: [0.2, 0, 0, 1], ripple: [0.2, 0.6, 0.35, 1] };
const interp = (k) => (k === 'lin' ? '@android:interpolator/linear' : `@interpolator/ink_${k}`);
const ms = (t) => Math.round(t * 1000);

function anim(prop, from, to, t0, t1, k = 'lin', type = 'floatType') {
  return `    <objectAnimator android:propertyName="${prop}" android:valueFrom="${from}" android:valueTo="${to}" android:valueType="${type}" android:startOffset="${ms(t0)}" android:duration="${Math.max(1, ms(t1 - t0))}" android:interpolator="${interp(k)}"/>`;
}
function motion(pathData, t0, t1, k) {
  return `    <objectAnimator android:propertyXName="translateX" android:propertyYName="translateY" android:pathData="${pathData}" android:startOffset="${ms(t0)}" android:duration="${ms(t1 - t0)}" android:interpolator="${interp(k)}"/>`;
}

function build(th) {
  const T = TH[th];
  const targets = []; // [name, animators]
  let vec = '';
  // drops: a group moved along its swirl, scaled; three circles for the soft edge
  DROPS.forEach((dp, i) => {
    const a0 = 0.04 + dp.d, a1 = 0.56 + dp.d * 0.5;
    const pts = []; for (let k = 0; k <= 24; k++) pts.push(dropPos(dp, k / 24));
    const pd = 'M' + pts.map((p) => `${f2(p[0])},${f2(p[1])}`).join(' L');
    const [x0, y0] = pts[0];
    vec += `      <group android:name="d${i}" android:translateX="${f2(x0)}" android:translateY="${f2(y0)}" android:scaleX="0.7" android:scaleY="0.7">\n`;
    [[1.8, 0.1], [1.35, 0.22], [1, 1]].forEach(([k, a], j) => {
      vec += `        <path android:name="d${i}p${j}" android:pathData="${circle(0, 0, dp.rad * k)}" android:fillColor="${T.early}" android:fillAlpha="0"/>\n`;
      targets.push([`d${i}p${j}`, [
        anim('fillAlpha', 0, 0.62 * a, 0, 0.16), anim('fillAlpha', 0.62 * a, 0, 0.44, 0.66),
        anim('fillColor', T.early, T.ink, 0.2, 0.6, 'lin', 'colorType'),
      ]]);
    });
    vec += '      </group>\n';
    targets.push([`d${i}`, [motion(pd, a0, a1, I.FOSI), anim('scaleX', 0.7, 1.25, a0, a1, I.FOSI), anim('scaleY', 0.7, 1.25, a0, a1, I.FOSI)]]);
  });
  // the body: morph from the blob, a rotation relaxing, its halo strokes
  vec += `      <group android:name="bodyRot" android:pivotX="${C.x}" android:pivotY="${C.y}" android:rotation="-38">\n`;
  vec += `        <path android:name="halo1" android:pathData="${BLOB_D}" android:strokeColor="${T.early}" android:strokeWidth="14" android:strokeAlpha="0" android:strokeLineJoin="round"/>\n`;
  vec += `        <path android:name="halo2" android:pathData="${BLOB_D}" android:strokeColor="${T.early}" android:strokeWidth="6" android:strokeAlpha="0" android:strokeLineJoin="round"/>\n`;
  vec += `        <path android:name="body" android:pathData="${BLOB_D}" android:fillColor="${T.early}" android:fillAlpha="0"/>\n      </group>\n`;
  const morph = (t0, t1) => anim('pathData', BLOB_D, BODY_D, t0, t1, I.FOSI, 'pathType');
  targets.push(['bodyRot', [anim('rotation', -38, 0, 0.12, 0.72, I.FOSI)]]);
  targets.push(['body', [morph(0.12, 0.72), anim('fillAlpha', 0, 1, 0.16, 0.56), anim('fillColor', T.early, T.ink, 0.22, 0.66, 'lin', 'colorType')]]);
  for (const [n, w0, w1, a] of [['halo1', 14, 4, 0.07], ['halo2', 6, 1.5, 0.12]]) {
    targets.push([n, [morph(0.12, 0.72), anim('strokeAlpha', 0, a, 0.18, 0.4), anim('strokeAlpha', a, 0, 0.55, 0.85), anim('strokeWidth', w0, w1, 0.3, 0.9),
      anim('strokeColor', T.early, T.ink, 0.22, 0.66, 'lin', 'colorType')]]);
  }
  // the perch (scaleX from its centre), the legs (scaleY from the perch)
  vec += `      <group android:name="perch" android:pivotX="60" android:pivotY="88" android:scaleX="0.25"><path android:name="perchP" android:pathData="${PERCH_D}" android:fillColor="${T.early}" android:fillAlpha="0"/></group>\n`;
  vec += `      <group android:name="legs" android:pivotY="86" android:scaleY="0"><path android:name="legsP" android:pathData="${LEGS_D}" android:fillColor="${T.early}" android:fillAlpha="0"/></group>\n`;
  targets.push(['perch', [anim('scaleX', 0.25, 1, 0.34, 0.72, I.EMPH)]]);
  targets.push(['perchP', [anim('fillAlpha', 0, 1, 0.34, 0.6), anim('fillColor', T.early, T.ink, 0.4, 0.7, 'lin', 'colorType')]]);
  targets.push(['legs', [anim('scaleY', 0, 1, 0.5, 0.74, I.EMPH)]]);
  targets.push(['legsP', [anim('fillAlpha', 0, 1, 0.5, 0.66), anim('fillColor', T.early, T.ink, 0.4, 0.7, 'lin', 'colorType')]]);
  // the eye: its glow, the eye opening (scale), one ripple
  vec += `      <group android:name="eye" android:pivotX="${EYE.x}" android:pivotY="${EYE.y}" android:scaleX="0" android:scaleY="0">\n`;
  vec += `        <path android:name="glow1" android:pathData="${circle(EYE.x, EYE.y, EYE.r * 2.3)}" android:fillColor="${T.eye}" android:fillAlpha="0"/>\n`;
  vec += `        <path android:name="glow2" android:pathData="${circle(EYE.x, EYE.y, EYE.r * 1.5)}" android:fillColor="${T.eye}" android:fillAlpha="0"/>\n`;
  vec += `        <path android:name="iris" android:pathData="${circle(EYE.x, EYE.y, EYE.r)}" android:fillColor="${T.eye}"/>\n      </group>\n`;
  targets.push(['eye', [anim('scaleX', 0, 1.15, 0.7, 0.8, I.EMPH), anim('scaleY', 0, 1.15, 0.7, 0.8, I.EMPH), anim('scaleX', 1.15, 1, 0.8, 0.86), anim('scaleY', 1.15, 1, 0.8, 0.86)]]);
  targets.push(['glow1', [anim('fillAlpha', 0, 0.4 * 0.45, 0.7, 0.8), anim('fillAlpha', 0.4 * 0.45, 0.18 * 0.45, 0.8, 1.0)]]);
  targets.push(['glow2', [anim('fillAlpha', 0, 0.4, 0.7, 0.8), anim('fillAlpha', 0.4, 0.18, 0.8, 1.0)]]);
  const R = 46 / EYE.r;
  vec += `      <group android:name="ripple" android:pivotX="${EYE.x}" android:pivotY="${EYE.y}"><path android:name="rippleP" android:pathData="${circle(EYE.x, EYE.y, EYE.r)}" android:strokeColor="${T.eye}" android:strokeWidth="0.43" android:strokeAlpha="0"/></group>\n`;
  targets.push(['ripple', [anim('scaleX', 1, R, 0.76, 1.0, I.RIPPLE), anim('scaleY', 1, R, 0.76, 1.0, I.RIPPLE)]]);
  targets.push(['rippleP', [anim('strokeAlpha', 0, 0.6, 0.755, 0.765), anim('strokeAlpha', 0.6, 0, 0.765, 1.0), anim('strokeWidth', 3, 0.09, 0.76, 1.0, I.RIPPLE)]]);

  const root = `    <group android:translateX="${f2(144 - GC.x * S)}" android:translateY="${f2(144 - GC.y * S)}" android:scaleX="${S}" android:scaleY="${S}">\n`;
  const avd = `<?xml version="1.0" encoding="utf-8"?>
<!-- Generated by apps/android/tools/ink-avd.mjs: do not edit. The launch's Ink, variant A (docs/PHONE.md, The launch). -->
<animated-vector xmlns:android="http://schemas.android.com/apk/res/android" xmlns:aapt="http://schemas.android.com/aapt">
  <aapt:attr name="android:drawable">
    <vector android:width="288dp" android:height="288dp" android:viewportWidth="288" android:viewportHeight="288">
${root}${vec}    </group>
    </vector>
  </aapt:attr>
${targets.map(([n, as]) => `  <target android:name="${n}">\n    <aapt:attr name="android:animation">\n      <set android:ordering="together">\n${as.map((a) => '    ' + a).join('\n')}\n      </set>\n    </aapt:attr>\n  </target>`).join('\n')}
</animated-vector>
`;
  const still = `<?xml version="1.0" encoding="utf-8"?>
<!-- Generated by apps/android/tools/ink-avd.mjs: do not edit. The launch's last frame, held: the still mark (Android 8 to 11, animations off). -->
<vector xmlns:android="http://schemas.android.com/apk/res/android" android:width="288dp" android:height="288dp" android:viewportWidth="288" android:viewportHeight="288">
${root}      <path android:pathData="${BODY_D}" android:fillColor="${T.ink}"/>
      <path android:pathData="${LEGS_D} ${PERCH_D}" android:fillColor="${T.ink}"/>
      <path android:pathData="${circle(EYE.x, EYE.y, EYE.r * 2.3)}" android:fillColor="${argb(T.eye, 0.18 * 0.45)}"/>
      <path android:pathData="${circle(EYE.x, EYE.y, EYE.r * 1.5)}" android:fillColor="${argb(T.eye, 0.18)}"/>
      <path android:pathData="${circle(EYE.x, EYE.y, EYE.r)}" android:fillColor="${T.eye}"/>
    </group>
</vector>
`;
  return { avd, still };
}

const write = (rel, text) => { const f = path.join(ROOT, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, text); console.log('wrote', path.relative(process.cwd(), f)); };
for (const [k, [a, b, c, d]] of Object.entries(INTERP)) {
  write(`interpolator/ink_${k}.xml`, `<?xml version="1.0" encoding="utf-8"?>\n<!-- Generated by apps/android/tools/ink-avd.mjs. -->\n<pathInterpolator xmlns:android="http://schemas.android.com/apk/res/android" android:controlX1="${a}" android:controlY1="${b}" android:controlX2="${c}" android:controlY2="${d}"/>\n`);
}
const day = build('day'), night = build('night');
write('drawable/ink_splash.xml', day.avd);
write('drawable-night/ink_splash.xml', night.avd);
write('drawable/ink_still.xml', day.still);
write('drawable-night/ink_still.xml', night.still);
// The constants the app's exit draws with (InkLaunch.kt reads them from here).
console.log(JSON.stringify({ S, GC, EYE }));
