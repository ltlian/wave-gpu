/**
 * WebGPU renderer: one storage buffer of samples, one compute pass that folds
 * them into 256 per-column summaries, one fullscreen-triangle fragment pass that
 * draws the stylized waveform.
 *
 * The compute/render contract is documented in `shaders.ts`. This module owns
 * everything GPU-side: adapter/device, shader modules and their diagnostics,
 * pipelines, bind groups, resize handling and the per-frame command encoding.
 * It returns `null` (after reporting why) if any step fails so `visualizer.ts`
 * can fall back to Canvas2D.
 *
 * No GPU is available in the build/test container, so this file is written
 * defensively: every WebGPU call that can throw is caught and turned into a
 * human-readable message instead of an unhandled rejection.
 */

import { FRAME_SAMPLES } from '../../shared/audio.ts';
import { COMPUTE_WGSL, RENDER_WGSL } from './shaders.ts';
import type { BackendFrame, CanvasSize, RenderBackend } from './visualizer.ts';

/** 2048 samples / 8 per column = 256 columns (must match the WGSL constants). */
const SAMPLES_PER_COLUMN = 8;
const COLUMN_COUNT = FRAME_SAMPLES / SAMPLES_PER_COLUMN;
const COMPUTE_WORKGROUP_SIZE = 8;
/** Two vec4<f32>: params0 (time, level, crest, aspect) and params1 (columns, ampScale, -, -). */
const UNIFORM_BYTES = 32;
const MAX_FRAME_ERRORS = 3;

/**
 * lib.dom in TypeScript 7 ships the WebGPU interfaces but not the usage-flag
 * globals; the browser provides this one at runtime. Declared locally (module
 * scope) so the project needs no extra typings package.
 */
declare const GPUBufferUsage: {
  readonly COPY_DST: GPUBufferUsageFlags;
  readonly STORAGE: GPUBufferUsageFlags;
  readonly UNIFORM: GPUBufferUsageFlags;
};

function describeError(error: unknown): string {
  if (typeof error === 'string') return error;
  if (error instanceof Error) return error.message;
  if (typeof error === 'object' && error !== null) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === 'string') return message;
  }
  return String(error);
}

async function requestAdapter(gpu: GPU, report: (message: string) => void): Promise<GPUAdapter | null> {
  try {
    const adapter = await gpu.requestAdapter({ powerPreference: 'high-performance' });
    if (!adapter) {
      report('No compatible WebGPU adapter was found — the Canvas2D fallback will be used.');
      return null;
    }
    return adapter;
  } catch (error) {
    report(`WebGPU requestAdapter() failed: ${describeError(error)} — the Canvas2D fallback will be used.`);
    return null;
  }
}

async function requestDevice(adapter: GPUAdapter, report: (message: string) => void): Promise<GPUDevice | null> {
  try {
    return await adapter.requestDevice();
  } catch (error) {
    report(`WebGPU requestDevice() failed: ${describeError(error)} — the Canvas2D fallback will be used.`);
    return null;
  }
}

/**
 * Run `build` under a validation error scope and surface whatever the validation
 * layer reports. Pipeline/buffer creation is synchronous but its validation
 * errors arrive asynchronously through popErrorScope, so this has to be async.
 */
async function withValidationScope<T>(
  device: GPUDevice,
  report: (message: string) => void,
  label: string,
  build: () => T,
): Promise<T | null> {
  device.pushErrorScope('validation');
  let result: T | null = null;
  let failure: string | null = null;
  try {
    result = build();
  } catch (error) {
    failure = `WebGPU ${label} failed: ${describeError(error)}`;
  }
  const scopeError = await device.popErrorScope().catch(() => null);
  if (scopeError) {
    report(`WebGPU ${label} validation failed: ${scopeError.message}`);
    return null;
  }
  if (failure !== null) {
    report(failure);
    return null;
  }
  return result;
}

interface ShaderModules {
  compute: GPUShaderModule;
  render: GPUShaderModule;
}

interface GpuResources {
  sampleBuffer: GPUBuffer;
  columnBuffer: GPUBuffer;
  uniformBuffer: GPUBuffer;
  computePipeline: GPUComputePipeline;
  renderPipeline: GPURenderPipeline;
  computeBindGroup: GPUBindGroup;
  renderBindGroup: GPUBindGroup;
}

async function createShaderModules(
  device: GPUDevice,
  report: (message: string) => void,
): Promise<ShaderModules | null> {
  const modules = await withValidationScope<ShaderModules>(device, report, 'shader compilation', () => ({
    compute: device.createShaderModule({ label: 'wave columns compute', code: COMPUTE_WGSL }),
    render: device.createShaderModule({ label: 'wave waveform render', code: RENDER_WGSL }),
  }));
  if (!modules) return null;

  // getCompilationInfo() reports WGSL syntax/semantic errors even when module
  // creation itself succeeded; those are worth showing instead of a blank stage.
  const compileErrors: string[] = [];
  const named: ReadonlyArray<readonly [string, GPUShaderModule]> = [
    ['compute', modules.compute],
    ['render', modules.render],
  ];
  for (const [name, module] of named) {
    try {
      const info = await module.getCompilationInfo();
      for (const message of info.messages) {
        if (message.type === 'error') {
          const line = message.lineNum > 0 ? ` (line ${message.lineNum})` : '';
          compileErrors.push(`${name} WGSL${line}: ${message.message}`);
        }
      }
    } catch (error) {
      report(`WebGPU getCompilationInfo(${name}) failed: ${describeError(error)}`);
    }
  }
  if (compileErrors.length > 0) {
    for (const message of compileErrors) report(message);
    return null;
  }
  return modules;
}

async function createResources(
  device: GPUDevice,
  format: GPUTextureFormat,
  modules: ShaderModules,
  report: (message: string) => void,
): Promise<GpuResources | null> {
  return withValidationScope<GpuResources>(device, report, 'GPU resource setup', () => {
    const sampleBuffer = device.createBuffer({
      label: 'wave samples (2048 f32)',
      size: FRAME_SAMPLES * Float32Array.BYTES_PER_ELEMENT,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    const columnBuffer = device.createBuffer({
      label: 'wave columns (256 vec4)',
      size: COLUMN_COUNT * 4 * Float32Array.BYTES_PER_ELEMENT,
      usage: GPUBufferUsage.STORAGE,
    });
    const uniformBuffer = device.createBuffer({
      label: 'wave uniforms (2 vec4)',
      size: UNIFORM_BYTES,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    // 'auto' layouts are derived from the WGSL: compute sees
    // (read storage samples, read_write storage columns), render sees
    // (uniform params, read storage columns). The bind groups below match.
    const computePipeline = device.createComputePipeline({
      label: 'wave compute pipeline',
      layout: 'auto',
      compute: { module: modules.compute, entryPoint: 'main' },
    });
    const renderPipeline = device.createRenderPipeline({
      label: 'wave render pipeline',
      layout: 'auto',
      vertex: { module: modules.render, entryPoint: 'vs' },
      fragment: { module: modules.render, entryPoint: 'fs', targets: [{ format }] },
      primitive: { topology: 'triangle-list', cullMode: 'none' },
    });
    const computeBindGroup = device.createBindGroup({
      label: 'wave compute bindings',
      layout: computePipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: sampleBuffer } },
        { binding: 1, resource: { buffer: columnBuffer } },
      ],
    });
    const renderBindGroup = device.createBindGroup({
      label: 'wave render bindings',
      layout: renderPipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: uniformBuffer } },
        { binding: 1, resource: { buffer: columnBuffer } },
      ],
    });

    return {
      sampleBuffer,
      columnBuffer,
      uniformBuffer,
      computePipeline,
      renderPipeline,
      computeBindGroup,
      renderBindGroup,
    };
  });
}

export async function createWebGpuBackend(
  canvas: HTMLCanvasElement,
  report: (message: string) => void,
): Promise<RenderBackend | null> {
  const gpu: GPU | undefined = navigator.gpu;
  if (!gpu) {
    report('WebGPU is not available in this browser — the Canvas2D fallback will be used.');
    return null;
  }

  const adapter = await requestAdapter(gpu, report);
  if (!adapter) return null;

  const requestedDevice = await requestDevice(adapter, report);
  if (!requestedDevice) return null;
  // Explicit annotation keeps the non-null type visible inside the closures below.
  const device: GPUDevice = requestedDevice;

  let deviceDestroyed = false;
  const destroyDevice = (): void => {
    if (deviceDestroyed) return;
    deviceDestroyed = true;
    try {
      device.destroy();
    } catch {
      // already lost/destroyed
    }
  };

  const modules = await createShaderModules(device, report);
  if (!modules) {
    destroyDevice();
    return null;
  }

  const format = gpu.getPreferredCanvasFormat();
  const resources = await createResources(device, format, modules, report);
  if (!resources) {
    destroyDevice();
    return null;
  }
  const {
    sampleBuffer,
    uniformBuffer,
    computePipeline,
    renderPipeline,
    computeBindGroup,
    renderBindGroup,
  } = resources;

  // Touch the canvas only after the pipeline is known-good, so a failure here
  // can still be handled by the Canvas2D fallback (which may need a fresh
  // canvas, since a 'webgpu' context blocks getContext('2d')).
  let canvasContext: GPUCanvasContext | null = null;
  try {
    canvasContext = canvas.getContext('webgpu') as unknown as GPUCanvasContext | null;
  } catch (error) {
    report(`WebGPU canvas context creation failed: ${describeError(error)} — the Canvas2D fallback will be used.`);
    destroyDevice();
    return null;
  }
  if (!canvasContext) {
    report('WebGPU: canvas.getContext("webgpu") returned null — the Canvas2D fallback will be used.');
    destroyDevice();
    return null;
  }
  const gpuContext = canvasContext;

  let configured = false;
  let configuredWidth = 0;
  let configuredHeight = 0;
  const configure = (): void => {
    gpuContext.configure({ device, format, alphaMode: 'opaque' });
    configured = true;
    configuredWidth = canvas.width;
    configuredHeight = canvas.height;
  };
  try {
    configure();
  } catch (error) {
    report(`WebGPU context.configure() failed: ${describeError(error)} — the Canvas2D fallback will be used.`);
    destroyDevice();
    return null;
  }

  const sampleData = new Float32Array(FRAME_SAMPLES);
  const uniforms = new Float32Array(8);
  const maxTextureSize = device.limits.maxTextureDimension2D;
  let destroyed = false;
  let frameErrorCount = 0;

  const uncapturedErrorListener = (event: GPUUncapturedErrorEvent): void => {
    report(`WebGPU error: ${describeError(event.error)}`);
  };
  device.addEventListener('uncapturederror', uncapturedErrorListener);

  // A lost device means every later call is invalid; report it once instead of
  // failing silently (the frame loop keeps running against a dead device).
  device.lost
    .then((info) => {
      if (!destroyed && info.reason !== 'destroyed') {
        report(`WebGPU device lost: ${info.message || info.reason}`);
      }
    })
    .catch(() => {
      // The spec's promise resolves rather than rejects; ignore the theoretical rejection.
    });

  function resize(size: CanvasSize): void {
    if (destroyed) return;
    const dpr = size.dpr > 0 ? size.dpr : 1;
    const width = Math.max(1, Math.min(maxTextureSize, Math.round(size.width * dpr)));
    const height = Math.max(1, Math.min(maxTextureSize, Math.round(size.height * dpr)));
    if (canvas.width !== width) canvas.width = width;
    if (canvas.height !== height) canvas.height = height;
    if (!configured || width !== configuredWidth || height !== configuredHeight) {
      try {
        configure();
      } catch (error) {
        report(`WebGPU context.configure() on resize failed: ${describeError(error)}`);
      }
    }
  }

  function render(frame: BackendFrame): void {
    if (destroyed || !configured) return;
    if (frame.samples.length < FRAME_SAMPLES) return;
    try {
      sampleData.set(frame.samples.subarray(0, FRAME_SAMPLES));
      uniforms[0] = frame.time;
      uniforms[1] = frame.level;
      uniforms[2] = frame.crest;
      uniforms[3] = canvas.height > 0 ? canvas.width / canvas.height : 1;
      uniforms[4] = COLUMN_COUNT;
      uniforms[5] = frame.ampScale;
      device.queue.writeBuffer(sampleBuffer, 0, sampleData);
      device.queue.writeBuffer(uniformBuffer, 0, uniforms);

      const encoder = device.createCommandEncoder({ label: 'wave frame' });
      const computePass = encoder.beginComputePass({ label: 'wave columns' });
      computePass.setPipeline(computePipeline);
      computePass.setBindGroup(0, computeBindGroup);
      computePass.dispatchWorkgroups(Math.ceil(COLUMN_COUNT / COMPUTE_WORKGROUP_SIZE));
      computePass.end();

      const renderPass = encoder.beginRenderPass({
        label: 'wave waveform',
        colorAttachments: [
          {
            view: gpuContext.getCurrentTexture().createView(),
            clearValue: { r: 0.016, g: 0.02, b: 0.036, a: 1 },
            loadOp: 'clear',
            storeOp: 'store',
          },
        ],
      });
      renderPass.setPipeline(renderPipeline);
      renderPass.setBindGroup(0, renderBindGroup);
      renderPass.draw(3);
      renderPass.end();
      device.queue.submit([encoder.finish()]);
    } catch (error) {
      if (frameErrorCount < MAX_FRAME_ERRORS) {
        frameErrorCount += 1;
        report(`WebGPU render failed: ${describeError(error)}`);
      }
    }
  }

  function destroy(): void {
    if (destroyed) return;
    destroyed = true;
    device.removeEventListener('uncapturederror', uncapturedErrorListener);
    try {
      gpuContext.unconfigure();
    } catch {
      // the context may already be gone
    }
    destroyDevice();
  }

  return { backend: 'webgpu', resize, render, destroy };
}
