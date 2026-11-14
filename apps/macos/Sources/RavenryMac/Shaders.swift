// Shaders in the usual custom-shader shape: a `mainImage(out vec4
// fragColor, in vec2 fragCoord)` over iChannel0, the picture under it, with
// iResolution, iTime, iTimeDelta, iFrame and iMouse. This app keeps no
// third-party code: it compiles its Metal from source at launch
// (Renderer.swift), so the shaders
// are ported to MSL by hand: each body below is the GLSL of the maintainer's mockup
// (scratchpad build2/ink/ravenry-shaders-mockup.html) line for line, read
// through a small prelude (vec2 is float2, texture() samples iChannel0 with
// GLSL's y-up coordinates, fragCoord from the bottom left), with `out vec4`
// written `thread vec4 &`. A shader's functions are members of one struct
// that holds the uniforms and the channel, since MSL has no globals.
//
// - ink: the first launch's animation (Ink.swift). Its layout is not baked:
//   the window's size, the raven's place in the middle and the start
//   screen's icon (where the mark lands) come from the real views each
//   frame, in iLayout.
// - bloom, crt: the pane effects (Settings > Appearance > Pane effect),
//   drawn by Renderer.encode over a pane's own drawing, only when it draws.

import Metal
import simd

enum CustomShader: String, CaseIterable {
    case ink, bloom, crt

    /// The raven's body (hub/brand/ravenry/icon.svg, shared/icons/app-icon.svg), the mark Ink draws.
    static let ravenBody = "M95 34 C89 28 82 24 75 23 C66 21 58 24 54 30 C50 36 46 40 40 46 C32 54 24 64 18 74 L6 92 L20 94 L28 84 C36 80 48 78 56 76 C68 72 76 62 76 52 C76 46 74 43 78 40 C84 37 90 36 95 34 Z"
    /// Where the glyph sits in the 1024 icon: translate(89.11 24.00) scale(8.0539).
    static let iconGlyph = (x: 89.11, y: 24.00, scale: 8.0539)
    /// The glyph's centre, in its own units (the mockup's GLYPH_C).
    static let glyphCentre = SIMD2<Float>(50.5, 58.5)

    /// The path as a polygon, each curve in `seg` straight pieces (the mockup's flatten()).
    static func flatten(_ d: String, seg: Int) -> [SIMD2<Double>] {
        var toks: [String] = []
        var cur = ""
        for ch in d {
            if "MCLZ".contains(ch) { if !cur.isEmpty { toks.append(cur); cur = "" }; toks.append(String(ch)) }
            else if ch == " " || ch == "," { if !cur.isEmpty { toks.append(cur); cur = "" } }
            else { cur.append(ch) }
        }
        if !cur.isEmpty { toks.append(cur) }
        var pts: [SIMD2<Double>] = []
        var i = 0, cmd = "", at = SIMD2<Double>(0, 0)
        func num(_ k: Int) -> Double { Double(toks[k]) ?? 0 }
        while i < toks.count {
            if "MCLZ".contains(toks[i]) { cmd = toks[i]; i += 1; if cmd == "Z" { continue } }
            if cmd == "M" || cmd == "L" { at = SIMD2(num(i), num(i + 1)); pts.append(at); i += 2 }
            else if cmd == "C" {
                let a = SIMD2(num(i), num(i + 1)), b = SIMD2(num(i + 2), num(i + 3)), e = SIMD2(num(i + 4), num(i + 5))
                i += 6
                for s in 1...seg {
                    let u = Double(s) / Double(seg), v = 1 - u
                    pts.append(v * v * v * at + 3 * v * v * u * a + 3 * v * u * u * b + u * u * u * e)
                }
                at = e
            } else { i += 1 }
        }
        if let f = pts.first, let l = pts.last, pts.count > 1, abs(f.x - l.x) < 1e-6, abs(f.y - l.y) < 1e-6 { pts.removeLast() }
        return pts
    }

    static let poly = flatten(ravenBody, seg: 8)

    /// File-scope declarations a shader needs (constant arrays).
    var globals: String {
        switch self {
        case .ink:
            let p = CustomShader.poly
            let list = p.map { String(format: "vec2(%.2f,%.2f)", $0.x, $0.y) }.joined(separator: ", ")
            return "#define POLY_N \(p.count)\nconstant vec2 POLY[POLY_N] = { \(list) };\n"
        default: return ""
        }
    }

    /// The shader's body, in MSL (see the top).
    var body: String {
        switch self {
        case .ink: return inkBody
        case .bloom: return bloomBody
        case .crt: return crtBody
        }
    }
}

private let noise = """
float hash12(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * .1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
float vnoise(vec2 p) {
  vec2 i = floor(p), f = fract(p); vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash12(i), hash12(i + vec2(1, 0)), u.x), mix(hash12(i + vec2(0, 1)), hash12(i + vec2(1, 1)), u.x), u.y);
}
float fbm(vec2 p) {
  float s = 0.0, a = 0.5; mat2 m = mat2(1.6, 1.2, -1.2, 1.6);
  for (int i = 0; i < 5; i++) { s += a * vnoise(p); p = m * p; a *= 0.5; }
  return s;
}
"""

// Ink (3.4 s). Pale ink gathers into the raven, the eye opens, the mark
// flies to its place and the window washes in around it. Window points,
// top-left origin: iLayout[0].xy the window's size, iLayout[1] the mark in
// the middle (centre x, y, points per glyph unit), iLayout[2] the mark on
// the start screen's icon, iLayout[3] the icon's tile (centre, half side,
// corner), iLayout[4].rgb the colour around the icon.
private let inkBody = """
#define VIRT   iLayout[0].xy
#define MARK_A iLayout[1].xyz
#define MARK_B iLayout[2].xyz
#define ICON   iLayout[3]
#define SHEET  iLayout[4].rgb
#define GLYPH_C vec2(50.5, 58.5)
\(noise)
float sdPoly(vec2 p) {
  const int N = POLY_N;
  float d = dot(p - POLY[0], p - POLY[0]); float s = 1.0;
  for (int i = 0; i < N; i++) {
    int j = i == 0 ? N - 1 : i - 1;
    vec2 e = POLY[j] - POLY[i], w = p - POLY[i];
    vec2 b = w - e * clamp(dot(w, e) / dot(e, e), 0.0, 1.0);
    d = min(d, dot(b, b));
    bvec3 c = bvec3(p.y >= POLY[i].y, p.y < POLY[j].y, e.x * w.y > e.y * w.x);
    if (all(c) || all(not(c))) s = -s;
  }
  return s * sqrt(d);
}
float sdBox(vec2 p, vec2 b) { vec2 d = abs(p) - b; return length(max(d, 0.0)) + min(max(d.x, d.y), 0.0); }
float sdSeg(vec2 p, vec2 a, vec2 b, float r) { vec2 pa = p - a, ba = b - a; return length(pa - ba * clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0)) - r; }
float sdMark(vec2 g) {
  float d = sdPoly(g);
  d = min(d, sdBox(g - vec2(52.5, 80.0), vec2(2.5, 6.0)));
  d = min(d, sdBox(g - vec2(62.5, 79.0), vec2(2.5, 7.0)));
  return min(d, sdSeg(g, vec2(34.0, 88.0), vec2(86.0, 88.0), 3.0));
}
float inOut(float x) { x = clamp(x, 0.0, 1.0); return x < 0.5 ? 4.0 * x * x * x : 1.0 - pow(-2.0 * x + 2.0, 3.0) * 0.5; }

vec3 windowAt(vec2 uv, float blurPx) {
  vec3 s = texture(iChannel0, uv).rgb;
  if (blurPx < 0.05) return s;
  vec2 o = blurPx / iResolution.xy;
  s += texture(iChannel0, uv + vec2( o.x,  o.y)).rgb + texture(iChannel0, uv + vec2(-o.x,  o.y)).rgb;
  s += texture(iChannel0, uv + vec2( o.x, -o.y)).rgb + texture(iChannel0, uv + vec2(-o.x, -o.y)).rgb;
  return s / 5.0;
}

void mainImage(thread vec4 &fragColor, in vec2 fragCoord) {
  const vec3 BG  = vec3(0.043, 0.043, 0.047);
  const vec3 INK = vec3(0.949, 0.949, 0.957);
  const vec3 EYE = vec3(0.039, 0.518, 1.000);
  float t = iTime;
  vec2 uv = fragCoord / iResolution.xy;
  vec2 p = vec2(uv.x, 1.0 - uv.y) * VIRT;
  float devPx = VIRT.y / iResolution.y;

  // Where the mark is: large in the middle, then home to the icon.
  float k = inOut((t - 2.15) / 0.75);
  vec2 c = mix(MARK_A.xy, MARK_B.xy, k);
  float u = exp(mix(log(MARK_A.z), log(MARK_B.z), k));
  vec2 g = (p - c) / u + GLYPH_C;
  float pxG = devPx / u;

  // Ink gathering: the shape seen through a swirl that relaxes to nothing.
  float pA = smoothstep(0.05, 2.0, t);
  float spread = pow(1.0 - pA, 2.0);
  vec2 q = g * 0.03;
  vec2 w1 = vec2(fbm(q + vec2(0.0, t * 0.35)), fbm(q + vec2(5.2, 1.3) - t * 0.3)) - 0.5;
  vec2 w2 = vec2(fbm(q * 2.1 + 3.0 * w1 + vec2(1.7, 9.2) + t * 0.25), fbm(q * 2.1 + 3.0 * w1 + vec2(8.3, 2.8) - t * 0.2)) - 0.5;
  float d = sdMark(g + (w1 * 1.2 + w2 * 0.9) * 95.0 * spread);
  float soft = max(pxG * 0.7, 20.0 * pow(spread, 0.75));
  float body = 1.0 - smoothstep(-soft, soft, d);
  float wisp = smoothstep(0.40, 0.80, fbm(g * 0.05 + w2 * 4.0 - t * 0.1));
  float halo = wisp * exp(-max(d, 0.0) / (4.0 + 28.0 * spread)) * spread;
  float dens = clamp(body + halo * 0.75, 0.0, 1.0) * smoothstep(0.0, 0.8, t);
  vec3 inkCol = mix(vec3(0.22, 0.38, 0.66), INK, smoothstep(0.25, 0.9, dens + (1.0 - spread) * 0.6));
  float aura = exp(-max(d, 0.0) / 9.0) * smoothstep(1.3, 2.0, t) * (1.0 - k) * 0.10;

  // The eye opens with one ripple.
  float eD = length(g - vec2(65.0, 32.0)) - 6.5;
  float eyeOn = smoothstep(1.75, 2.1, t);
  float eye = (1.0 - smoothstep(-pxG * 0.7, pxG * 0.7, eD)) * eyeOn;
  float rT = t - 1.85;
  float ripple = rT > 0.0 ? exp(-abs(eD - rT * 75.0) / 2.0) * (1.0 - smoothstep(0.0, 0.7, rT)) * 0.5 : 0.0;
  float eGlow = exp(-max(eD, 0.0) / 6.0) * eyeOn * (0.18 + 0.5 * (1.0 - smoothstep(2.1, 2.9, t)));

  // The window washes in from the icon, like ink spreading in water.
  vec2 homeUV = vec2(MARK_B.x / VIRT.x, 1.0 - MARK_B.y / VIRT.y);
  float settle = 1.0 - smoothstep(2.55, 3.35, t);
  vec2 cuv = homeUV + (uv - homeUV) / (1.0 + 0.02 * settle);
  vec3 win = windowAt(cuv, settle * 0.8);
  // The icon's own tile stays empty until the mark lands in it.
  vec2 ib = abs(p - ICON.xy) - ICON.z + ICON.w;
  float inIcon = 1.0 - smoothstep(-devPx, devPx, length(max(ib, 0.0)) + min(max(ib.x, ib.y), 0.0) - ICON.w);
  win = mix(win, SHEET, inIcon * (1.0 - smoothstep(2.85, 3.05, t)));
  float r = length(p - MARK_B.xy) / VIRT.y;
  float n = fbm(p / VIRT.y * 5.0 + vec2(t * 0.2, 0.0));
  float front = (t - 2.55) * 2.4;
  // (GLSL's smoothstep(front, front - 0.3, x), its edges in order.)
  float wash = max(1.0 - smoothstep(front - 0.3, front, r + (n - 0.5) * 0.4), smoothstep(3.15, 3.4, t));
  vec3 col = mix(BG, win, wash);

  float markA = 1.0 - smoothstep(3.0, 3.2, t);
  col = mix(col, inkCol, dens * markA);
  col += INK * aura * markA;
  col = mix(col, EYE, eye * markA);
  col += EYE * (eGlow + ripple) * markA * 0.55;
  // Ended: the window itself, not a blend that rounds a step away from it.
  if (t >= 3.4) col = texture(iChannel0, uv).rgb;
  fragColor = vec4(col, 1.0);
}
"""

// Soft bloom. Bright glyphs bleed a little light into the dark around them.
// One pass, 24 taps on a golden-angle spiral.
private let bloomBody = """
void mainImage(thread vec4 &fragColor, in vec2 fragCoord) {
  vec2 uv = fragCoord / iResolution.xy;
  vec3 c = texture(iChannel0, uv).rgb;
  float R = 0.012 * iResolution.y;
  vec3 acc = vec3(0.0); float wsum = 0.0;
  for (int i = 0; i < 24; i++) {
    float fi = float(i) + 0.5;
    float r = sqrt(fi / 24.0) * R;
    float a = fi * 2.3999632;
    vec3 s = texture(iChannel0, uv + vec2(cos(a), sin(a)) * r / iResolution.xy).rgb;
    float w = exp(-2.0 * r * r / (R * R));
    acc += s * smoothstep(0.25, 0.85, dot(s, vec3(0.2126, 0.7152, 0.0722))) * w;
    wsum += w;
  }
  fragColor = vec4(c + acc / wsum * 0.9, 1.0);
}
"""

// CRT curve. A slight bend, faint scanlines and a soft edge glow. Text in
// the middle of the pane stays sharp.
private let crtBody = """
float sdRound(vec2 p, vec2 b, float r) { vec2 q = abs(p) - b + r; return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r; }
void mainImage(thread vec4 &fragColor, in vec2 fragCoord) {
  vec2 res = iResolution.xy;
  vec2 c = fragCoord / res * 2.0 - 1.0;
  vec2 cc = c * (1.0 + 0.022 * vec2(c.y * c.y, c.x * c.x));
  vec2 uv = cc * 0.5 + 0.5;
  vec2 ca = c * 0.7 / res;
  vec3 col = vec3(texture(iChannel0, uv + ca).r, texture(iChannel0, uv).g, texture(iChannel0, uv - ca).b);
  vec3 glow = vec3(0.0); float R = 0.007 * res.y;
  for (int i = 0; i < 8; i++) {
    float a = float(i) * 0.7853982;
    vec3 s = texture(iChannel0, uv + vec2(cos(a), sin(a)) * R / res).rgb;
    glow += s * smoothstep(0.3, 0.9, dot(s, vec3(0.2126, 0.7152, 0.0722)));
  }
  col += glow / 8.0 * 0.35;
  col *= 0.93 + 0.07 * cos(uv.y * res.y * 2.0944);
  vec2 vg = uv * (1.0 - uv);
  col *= mix(0.8, 1.0, pow(clamp(16.0 * vg.x * vg.y, 0.0, 1.0), 0.25));
  col *= 1.0 - smoothstep(-1.5 / res.y, 1.5 / res.y, sdRound(cc, vec2(1.0), 0.04));
  fragColor = vec4(col, 1.0);
}
"""

/// Runs a custom shader over a texture: one triangle over the
/// target, the source as iChannel0. One pipeline per shader, compiled the
/// first time it is used (a few ms), shared by every pane and window.
final class ShaderHost {
    static let shared = ShaderHost()
    let device: MTLDevice?
    private var pipes: [CustomShader: MTLRenderPipelineState] = [:]
    private(set) var errors: [String] = []
    private var frame: Int32 = 0

    init() { device = MTLCreateSystemDefaultDevice() }

    /// The uniforms, as the prelude reads them (16-byte rows).
    struct Uniforms {
        var resolution: SIMD4<Float>
        var time: SIMD4<Float> // iTime, iTimeDelta, iFrame
        var mouse: SIMD4<Float>
        var layout: (SIMD4<Float>, SIMD4<Float>, SIMD4<Float>, SIMD4<Float>, SIMD4<Float>)
    }

    static func source(_ s: CustomShader) -> String {
        """
        #include <metal_stdlib>
        using namespace metal;
        typedef float2 vec2; typedef float3 vec3; typedef float4 vec4; typedef float2x2 mat2; typedef bool3 bvec3; typedef int2 ivec2;
        #define in
        struct Uniforms { float4 res; float4 time; float4 mouse; float4 layout[5]; };
        \(s.globals)
        struct Shader {
          float3 iResolution; float iTime; float iTimeDelta; int iFrame; float4 iMouse;
          thread const float4 *iLayout;
          texture2d<float> iChannel0; sampler smp;
        #define texture(ch, uv) ch.sample(smp, float2((uv).x, 1.0 - (uv).y))
        \(s.body)
        #undef texture
        };
        struct FxOut { float4 pos [[position]]; };
        vertex FxOut fx_vertex(uint vid [[vertex_id]]) {
          float2 p = float2((vid << 1) & 2, vid & 2);
          FxOut o; o.pos = float4(p * 2 - 1, 0, 1); return o;
        }
        fragment float4 fx_fragment(FxOut v [[stage_in]], constant Uniforms &u [[buffer(0)]], texture2d<float> ch0 [[texture(0)]]) {
          constexpr sampler s(filter::linear, address::clamp_to_edge);
          float4 lay[5] = { u.layout[0], u.layout[1], u.layout[2], u.layout[3], u.layout[4] };
          Shader sh;
          sh.iResolution = u.res.xyz; sh.iTime = u.time.x; sh.iTimeDelta = u.time.y; sh.iFrame = int(u.time.z); sh.iMouse = u.mouse;
          sh.iLayout = lay; sh.iChannel0 = ch0; sh.smp = s;
          float4 c = float4(0.0);
          sh.mainImage(c, float2(v.pos.x, u.res.y - v.pos.y));
          return float4(c.rgb, 1.0);
        }
        """
    }

    func pipeline(_ s: CustomShader) -> MTLRenderPipelineState? {
        if let p = pipes[s] { return p }
        guard let dev = device else { return nil }
        do {
            let lib = try dev.makeLibrary(source: ShaderHost.source(s), options: nil)
            let d = MTLRenderPipelineDescriptor()
            d.vertexFunction = lib.makeFunction(name: "fx_vertex")
            d.fragmentFunction = lib.makeFunction(name: "fx_fragment")
            d.colorAttachments[0].pixelFormat = .bgra8Unorm
            let p = try dev.makeRenderPipelineState(descriptor: d)
            pipes[s] = p
            return p
        } catch {
            errors.append("\(s.rawValue): \(error)")
            NSLog("RavenryMac: shader \(s.rawValue): \(error)")
            return nil
        }
    }

    /// Draws `shader` over `source` into `target` (same pixel size or not).
    @discardableResult
    func encode(_ shader: CustomShader, source: MTLTexture, into target: MTLTexture, commandBuffer cb: MTLCommandBuffer,
                time: Double = 0, delta: Double = 1.0 / 60, layout: [SIMD4<Float>] = []) -> Bool {
        guard let p = pipeline(shader) else { return false }
        let pass = MTLRenderPassDescriptor()
        pass.colorAttachments[0].texture = target
        pass.colorAttachments[0].loadAction = .dontCare
        pass.colorAttachments[0].storeAction = .store
        guard let enc = cb.makeRenderCommandEncoder(descriptor: pass) else { return false }
        let l = (0..<5).map { $0 < layout.count ? layout[$0] : SIMD4<Float>(repeating: 0) }
        frame &+= 1
        var u = Uniforms(resolution: SIMD4(Float(target.width), Float(target.height), 1, 0),
                         time: SIMD4(Float(time), Float(delta), Float(frame), 0), mouse: .zero,
                         layout: (l[0], l[1], l[2], l[3], l[4]))
        enc.setRenderPipelineState(p)
        enc.setFragmentBytes(&u, length: MemoryLayout<Uniforms>.stride, index: 0)
        enc.setFragmentTexture(source, index: 0)
        enc.drawPrimitives(type: .triangle, vertexStart: 0, vertexCount: 3)
        enc.endEncoding()
        return true
    }
}
