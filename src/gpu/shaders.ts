/**
 * WGSL sources for the two GPU passes. Strings only — the pipelines and buffers
 * that consume them live in `webgpu.ts`.
 *
 * The contract with `webgpu.ts` (keep in sync):
 *   - the samples buffer is FRAME_SAMPLES = 2048 f32, written once per frame;
 *   - 2048 / 8 = 256 columns, one invocation each, workgroup_size(8) => 32 groups;
 *   - a column is `vec4(min, max, center, rms)` of its 8 samples;
 *   - the uniforms buffer is two vec4<f32> = 32 bytes (see Uniforms below).
 */

/**
 * Compute pass: 256 columns × 8 samples → vec4(minimum, maximum, center, rms).
 * The per-column summary is what the fragment shader draws; it is much cheaper
 * than re-reading all 2048 samples per pixel.
 */
export const COMPUTE_WGSL = /* wgsl */ `
const COLUMN_COUNT: u32 = 256u;
const SAMPLES_PER_COLUMN: u32 = 8u;

@group(0) @binding(0) var<storage, read> samples: array<f32>;
@group(0) @binding(1) var<storage, read_write> columns: array<vec4<f32>>;

@compute @workgroup_size(8)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  let column = id.x;
  if (column >= COLUMN_COUNT) {
    return;
  }
  let base = column * SAMPLES_PER_COLUMN;
  var minimum = 1.0;
  var maximum = -1.0;
  var sum = 0.0;
  var sumSquares = 0.0;
  for (var i = 0u; i < SAMPLES_PER_COLUMN; i = i + 1u) {
    let value = samples[base + i];
    minimum = min(minimum, value);
    maximum = max(maximum, value);
    sum = sum + value;
    sumSquares = sumSquares + value * value;
  }
  let center = sum / f32(SAMPLES_PER_COLUMN);
  let rms = sqrt(sumSquares / f32(SAMPLES_PER_COLUMN));
  columns[column] = vec4<f32>(minimum, maximum, center, rms);
}
`;

/**
 * Render pass: a fullscreen triangle and one stylized, symmetric waveform.
 * The samples were display-normalised (auto-gain) before upload, so a
 * full-scale column has an excursion of ~1 and `ampScale` (uniform) decides how
 * much of the panel height that maps to. Colour energy/crest still come from the
 * RAW rms/peak values, so brightness follows the real signal, not the gain.
 */
export const RENDER_WGSL = /* wgsl */ `
struct Uniforms {
  params0: vec4<f32>, // time (s), display level 0..1, crest 0..1, aspect
  params1: vec4<f32>, // columns (f32), amplitude scale, unused, unused
};

@group(0) @binding(0) var<uniform> u: Uniforms;
@group(0) @binding(1) var<storage, read> columns: array<vec4<f32>>;

/** Half-height of one column's excursion from its mean (the value being drawn). */
fn columnAmplitude(index: u32) -> f32 {
  let data = columns[index];
  return max(abs(data.y - data.z), abs(data.z - data.x));
}

struct VSOut {
  @builtin(position) position: vec4<f32>,
  @location(0) uv: vec2<f32>,
};

@vertex
fn vs(@builtin(vertex_index) index: u32) -> VSOut {
  // One oversized triangle covers the viewport; uv 0..1 spans the visible area.
  var corners = array<vec2<f32>, 3>(
    vec2<f32>(-1.0, -1.0),
    vec2<f32>(3.0, -1.0),
    vec2<f32>(-1.0, 3.0)
  );
  let clip = corners[index];
  var out: VSOut;
  out.position = vec4<f32>(clip, 0.0, 1.0);
  out.uv = clip * 0.5 + vec2<f32>(0.5, 0.5);
  return out;
}

@fragment
fn fs(input: VSOut) -> @location(0) vec4<f32> {
  let uv = input.uv;
  let time = u.params0.x;
  let level = u.params0.y;
  let crest = u.params0.z;
  let aspect = u.params0.w;
  let columnsFloat = u.params1.x;
  let ampScale = u.params1.y;

  // Which of the 256 columns is under this fragment?
  var column = u32(floor(uv.x * columnsFloat));
  column = min(column, u32(columnsFloat) - 1u);
  let lastColumn = u32(columnsFloat) - 1u;
  let columnData = columns[column];
  let center = columnData.z;
  let columnRms = columnData.w;

  // Symmetric envelope: the larger excursion from the column mean, with one
  // neighbour-smoothing pass (same as the Canvas2D fallback) so columns at a
  // waveform peak — where eight samples barely span anything — don't punch
  // visible notches down to the centre line. The samples are display-normalised
  // by the auto-gain in visualizer.ts, so this is a stylized view of the
  // waveform rather than a scope trace.
  let neighbourLeft = max(column, 1u) - 1u;
  let neighbourRight = min(column + 1u, lastColumn);
  let amplitude = (columnAmplitude(neighbourLeft) + columnAmplitude(column) * 2.0 + columnAmplitude(neighbourRight)) * 0.25;
  let midline = 0.5 + center * 0.22;
  let halfHeight = clamp(amplitude * ampScale + 0.008, 0.0, 0.49);
  let distanceFromMid = abs(uv.y - midline);
  let edgeFade = smoothstep(0.0, 0.05, min(uv.x, 1.0 - uv.x));

  // ---- dark backdrop + vignette -----------------------------------------
  var color = vec3<f32>(0.016, 0.020, 0.036);
  let vignette = 1.0 - smoothstep(0.15, 1.15, distance(uv, vec2<f32>(0.5, 0.5)));
  color = color + vec3<f32>(0.020, 0.026, 0.055) * vignette;

  // ---- subtle grid + centre line ----------------------------------------
  let gridX = fract(uv.x * 16.0);
  let gridY = fract(uv.y * 8.0);
  let lineX = 1.0 - smoothstep(0.0, 0.012, min(gridX, 1.0 - gridX));
  let lineY = 1.0 - smoothstep(0.0, 0.012, min(gridY, 1.0 - gridY));
  color = color + vec3<f32>(0.050, 0.070, 0.130) * (lineX + lineY);
  color = color + vec3<f32>(0.090, 0.115, 0.220) * (1.0 - smoothstep(0.0, 0.0022, abs(uv.y - 0.5)));

  // ---- palette: violet -> cyan, driven by display level -------------------
  let violet = vec3<f32>(0.52, 0.31, 1.0);
  let cyan = vec3<f32>(0.13, 0.85, 0.94);
  let energy = clamp(level, 0.0, 1.0);
  let loudness = clamp(crest, 0.0, 1.0);
  let gradient = clamp(uv.x * 0.82 + energy * 0.35, 0.0, 1.0);
  let base = mix(violet, cyan, gradient);
  let breathe = 0.82 + 0.18 * sin(time * 0.7);
  let strength = (0.68 + energy * 0.85 + loudness * 0.35) * breathe;

  // soft additive glow bleeding out of the envelope
  let glow = exp(-max(distanceFromMid - halfHeight, 0.0) * (22.0 + aspect * 6.0));
  // The samples are display-normalised, so columnRms is O(1); the small
  // coefficient keeps the halo subtle instead of washing out the panel.
  color = color + base * glow * (0.10 + columnRms * 0.18) * 0.80 * strength;

  // filled symmetric envelope
  let inside = 1.0 - smoothstep(halfHeight - 0.003, halfHeight + 0.003, distanceFromMid);
  let depth = clamp(distanceFromMid / max(halfHeight, 0.0005), 0.0, 1.0);
  color = color + base * inside * (0.16 + 0.42 * depth) * strength;

  // bright rim at the envelope edge
  let rim = 1.0 - smoothstep(0.0, 0.008, abs(distanceFromMid - halfHeight));
  color = color + mix(base, vec3<f32>(1.0, 1.0, 1.0), 0.60) * rim * (0.30 + columnRms * 0.35) * strength;

  color = clamp(color, vec3<f32>(0.0, 0.0, 0.0), vec3<f32>(1.0, 1.0, 1.0));
  color = color * (0.25 + 0.75 * edgeFade);
  return vec4<f32>(color, 1.0);
}
`;
