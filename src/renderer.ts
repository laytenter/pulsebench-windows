type ComponentId = "cpu" | "gpu" | "memory" | "storage";
type UiState = "idle" | "queued" | "running" | "completed" | "failed" | "cancelled";
type ComponentResult =
  | CpuBenchmarkUiResult
  | GpuBenchmarkUiResult
  | MemoryBenchmarkUiResult
  | StorageBenchmarkUiResult;

interface ComponentElements {
  card: HTMLElement;
  button: HTMLButtonElement;
  primary: HTMLElement;
  unit: HTMLElement;
  detail: HTMLElement;
  progress: HTMLElement;
  progressTrack: HTMLElement;
}

interface StoredRun extends BenchmarkRun {
  id: string;
  status: "completed";
  scope: ComponentId[];
  durationMs: number;
}

interface TimedGpuPass {
  draws: number;
  elapsedMs: number;
}

const COMPONENTS: readonly ComponentId[] = ["cpu", "gpu", "memory", "storage"];
const COMPONENT_LABELS: Record<ComponentId, string> = {
  cpu: "Processor",
  gpu: "Graphics",
  memory: "Memory",
  storage: "Storage",
};
const HISTORY_KEY = "pulsebench.history.v1";
const GPU_WIDTH = 1920;
const GPU_HEIGHT = 1080;
const GPU_WARMUP_MS = 2_000;
const GPU_DURATION_MS = 8_000;

function requiredById<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) {
    throw new Error("Missing required interface element: " + id);
  }
  return element as T;
}

function requiredQuery<T extends Element>(selector: string): T {
  const element = document.querySelector(selector);
  if (!element) {
    throw new Error("Missing required interface element: " + selector);
  }
  return element as T;
}

function componentElements(id: ComponentId): ComponentElements {
  const card = requiredQuery<HTMLElement>('[data-component="' + id + '"]');
  const progress = requiredById<HTMLElement>(id + "-progress");
  const progressTrack = progress.parentElement;
  if (!progressTrack) {
    throw new Error("Missing progress track for " + id);
  }

  return {
    card,
    button: requiredQuery<HTMLButtonElement>('[data-run="' + id + '"]'),
    primary: requiredById<HTMLElement>(id + "-primary"),
    unit: requiredQuery<HTMLElement>('[data-component="' + id + '"] .metric-unit'),
    detail: requiredById<HTMLElement>(id + "-detail"),
    progress,
    progressTrack,
  };
}

const ui = {
  runAllButton: requiredById<HTMLButtonElement>("run-all-button"),
  stopButton: requiredById<HTMLButtonElement>("stop-button"),
  exportButton: requiredById<HTMLButtonElement>("export-button"),
  refreshSystemButton: requiredById<HTMLButtonElement>("refresh-system-button"),
  clearHistoryButton: requiredById<HTMLButtonElement>("clear-history-button"),
  suiteStatus: requiredById<HTMLElement>("suite-status"),
  suiteStatusText: requiredById<HTMLElement>("suite-status-text"),
  suiteProgress: requiredById<HTMLElement>("suite-progress"),
  suiteProgressTrack: requiredById<HTMLElement>("suite-progress-track"),
  suiteProgressLabel: requiredById<HTMLElement>("suite-progress-label"),
  activityIcon: requiredById<HTMLElement>("activity-icon"),
  activityTitle: requiredById<HTMLElement>("activity-title"),
  activityMessage: requiredById<HTMLElement>("activity-message"),
  gpuCanvas: requiredById<HTMLCanvasElement>("gpu-canvas"),
  gpuRenderer: requiredById<HTMLElement>("gpu-renderer"),
  gpuPreviewState: requiredById<HTMLElement>("gpu-preview-state"),
  systemCpu: requiredById<HTMLElement>("system-cpu"),
  systemGpu: requiredById<HTMLElement>("system-gpu"),
  systemMemory: requiredById<HTMLElement>("system-memory"),
  systemOs: requiredById<HTMLElement>("system-os"),
  historyList: requiredById<HTMLOListElement>("history-list"),
  runtimeLabel: requiredById<HTMLElement>("runtime-label"),
  toast: requiredById<HTMLElement>("toast"),
  components: {
    cpu: componentElements("cpu"),
    gpu: componentElements("gpu"),
    memory: componentElements("memory"),
    storage: componentElements("storage"),
  } satisfies Record<ComponentId, ComponentElements>,
};

let benchmarkBusy = false;
let cancelRequested = false;
let activePlan: ComponentId[] = [];
let activePlanIndex = 0;
let currentSystemInfo: SystemInfo | null = null;
let runHistory: StoredRun[] = [];
let selectedRun: StoredRun | null = null;
let toastTimer: number | undefined;
let removeProgressListener: (() => void) | undefined;

class GpuCancellationError extends Error {
  constructor() {
    super("Graphics benchmark cancelled.");
    this.name = "GpuCancellationError";
  }
}

class GpuBenchmarkHarness {
  readonly renderer: string;

  private readonly canvas: HTMLCanvasElement;
  private readonly gl: WebGL2RenderingContext;
  private readonly program: WebGLProgram;
  private readonly vertexArray: WebGLVertexArrayObject;
  private readonly timeLocation: WebGLUniformLocation;
  private readonly iterationLocation: WebGLUniformLocation;
  private readonly isCancelled: () => boolean;
  private readonly shouldAnimate: () => boolean;
  private running = false;
  private contextLost = false;
  private previewFrameId = 0;
  private lastPreviewTime = Number.NEGATIVE_INFINITY;
  private previewHasDrawn = false;

  constructor(
    canvas: HTMLCanvasElement,
    isCancelled: () => boolean,
    shouldAnimate: () => boolean,
  ) {
    this.canvas = canvas;
    this.isCancelled = isCancelled;
    this.shouldAnimate = shouldAnimate;
    this.canvas.width = GPU_WIDTH;
    this.canvas.height = GPU_HEIGHT;

    const context = canvas.getContext("webgl2", {
      alpha: false,
      antialias: false,
      depth: false,
      stencil: false,
      desynchronized: true,
      failIfMajorPerformanceCaveat: true,
      powerPreference: "high-performance",
      preserveDrawingBuffer: false,
    });

    if (!context) {
      throw new Error("WebGL2 is unavailable on this graphics configuration.");
    }

    this.gl = context;
    this.program = this.createProgram();
    const vertexArray = context.createVertexArray();
    if (!vertexArray) {
      throw new Error("Unable to create the WebGL2 vertex array.");
    }
    this.vertexArray = vertexArray;

    const timeLocation = context.getUniformLocation(this.program, "uTime");
    const iterationLocation = context.getUniformLocation(this.program, "uIteration");
    if (!timeLocation || !iterationLocation) {
      throw new Error("The GPU workload uniforms were optimized away.");
    }
    this.timeLocation = timeLocation;
    this.iterationLocation = iterationLocation;

    const debugInfo = context.getExtension("WEBGL_debug_renderer_info") as
      | { UNMASKED_RENDERER_WEBGL: number }
      | null;
    const rendererParameter = debugInfo
      ? debugInfo.UNMASKED_RENDERER_WEBGL
      : context.RENDERER;
    this.renderer = String(context.getParameter(rendererParameter));
    if (/swiftshader|llvmpipe|softpipe|software|basic render driver/i.test(this.renderer)) {
      throw new Error("Hardware graphics acceleration is required for the GPU benchmark.");
    }

    context.disable(context.BLEND);
    context.disable(context.CULL_FACE);
    context.disable(context.DEPTH_TEST);
    context.disable(context.DITHER);
    context.disable(context.SCISSOR_TEST);
    context.bindVertexArray(this.vertexArray);
    context.useProgram(this.program);
    context.viewport(0, 0, GPU_WIDTH, GPU_HEIGHT);

    canvas.addEventListener("webglcontextlost", (event) => {
      event.preventDefault();
      this.contextLost = true;
      ui.gpuPreviewState.textContent = "Unavailable";
      ui.gpuRenderer.textContent = "Graphics context lost — restart PulseBench to test again.";
    });
  }

  startPreview(): void {
    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const frame = (time: number): void => {
      if (
        !this.contextLost &&
        !this.running &&
        this.shouldAnimate() &&
        document.visibilityState === "visible" &&
        time - this.lastPreviewTime >= 66 &&
        (!reduceMotion || !this.previewHasDrawn)
      ) {
        this.drawFrame(time / 1_000, 0);
        this.lastPreviewTime = time;
        this.previewHasDrawn = true;
      }
      this.previewFrameId = window.requestAnimationFrame(frame);
    };
    this.previewFrameId = window.requestAnimationFrame(frame);
  }

  stopPreview(): void {
    window.cancelAnimationFrame(this.previewFrameId);
  }

  async run(onProgress: (ratio: number, message: string) => void): Promise<GpuBenchmarkUiResult> {
    if (this.contextLost || this.gl.isContextLost()) {
      return this.failure("The WebGL2 graphics context is unavailable.");
    }

    this.running = true;
    ui.gpuPreviewState.textContent = "Warming up";

    try {
      onProgress(0, "Warming the 1920 × 1080 shader workload…");
      await this.runPass(GPU_WARMUP_MS, (ratio) => {
        onProgress(ratio * 0.2, "Warming the 1920 × 1080 shader workload…");
      });

      if (this.isCancelled()) {
        throw new GpuCancellationError();
      }

      this.gl.finish();
      ui.gpuPreviewState.textContent = "Measuring";
      const measured = await this.runPass(GPU_DURATION_MS, (ratio) => {
        onProgress(0.2 + ratio * 0.8, "Measuring uncapped fullscreen draws…");
      });

      const elapsedSeconds = measured.elapsedMs / 1_000;
      const drawsPerSecond = measured.draws / elapsedSeconds;
      const gpixelsPerSecond =
        (drawsPerSecond * GPU_WIDTH * GPU_HEIGHT) / 1_000_000_000;

      onProgress(1, "Graphics benchmark complete.");
      ui.gpuPreviewState.textContent = "Complete";

      return {
        status: "completed",
        durationMs: measured.elapsedMs,
        warmupMs: GPU_WARMUP_MS,
        width: GPU_WIDTH,
        height: GPU_HEIGHT,
        draws: measured.draws,
        drawsPerSecond,
        gpixelsPerSecond,
        renderer: this.renderer,
      };
    } catch (error) {
      if (error instanceof GpuCancellationError || this.isCancelled()) {
        ui.gpuPreviewState.textContent = "Cancelled";
        return {
          status: "cancelled",
          durationMs: 0,
          warmupMs: GPU_WARMUP_MS,
          width: GPU_WIDTH,
          height: GPU_HEIGHT,
          draws: 0,
          drawsPerSecond: 0,
          gpixelsPerSecond: 0,
          renderer: this.renderer,
          message: "Graphics benchmark cancelled.",
        };
      }
      ui.gpuPreviewState.textContent = "Failed";
      return this.failure(errorMessage(error));
    } finally {
      this.running = false;
    }
  }

  private failure(message: string): GpuBenchmarkUiResult {
    return {
      status: "failed",
      durationMs: 0,
      warmupMs: GPU_WARMUP_MS,
      width: GPU_WIDTH,
      height: GPU_HEIGHT,
      draws: 0,
      drawsPerSecond: 0,
      gpixelsPerSecond: 0,
      renderer: this.renderer || "Unknown adapter",
      error: message,
    };
  }

  private async runPass(
    durationMs: number,
    onProgress: (ratio: number) => void,
  ): Promise<TimedGpuPass> {
    const start = performance.now();
    let now = start;
    let draws = 0;
    let batchSize = 2;

    while (now - start < durationMs) {
      if (this.isCancelled()) {
        throw new GpuCancellationError();
      }

      const batchStart = performance.now();
      const frameTime = batchStart / 1_000;
      for (let index = 0; index < batchSize; index += 1) {
        this.drawFrame(frameTime, draws + index);
      }
      this.gl.finish();
      const batchElapsed = performance.now() - batchStart;
      draws += batchSize;

      if (batchElapsed < 10 && batchSize < 64) {
        batchSize = Math.min(64, batchSize * 2);
      } else if (batchElapsed > 42 && batchSize > 1) {
        batchSize = Math.max(1, Math.floor(batchSize / 2));
      }

      now = performance.now();
      onProgress(Math.min(1, (now - start) / durationMs));
      await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
    }

    return { draws, elapsedMs: now - start };
  }

  private drawFrame(timeSeconds: number, iteration: number): void {
    this.gl.useProgram(this.program);
    this.gl.bindVertexArray(this.vertexArray);
    this.gl.viewport(0, 0, GPU_WIDTH, GPU_HEIGHT);
    this.gl.uniform1f(this.timeLocation, timeSeconds);
    this.gl.uniform1f(this.iterationLocation, iteration);
    this.gl.drawArrays(this.gl.TRIANGLES, 0, 3);
  }

  private createProgram(): WebGLProgram {
    const vertexSource = [
      "#version 300 es",
      "precision highp float;",
      "out vec2 vUv;",
      "const vec2 positions[3] = vec2[3](",
      "  vec2(-1.0, -1.0),",
      "  vec2( 3.0, -1.0),",
      "  vec2(-1.0,  3.0)",
      ");",
      "void main() {",
      "  vec2 position = positions[gl_VertexID];",
      "  vUv = position * 0.5 + 0.5;",
      "  gl_Position = vec4(position, 0.0, 1.0);",
      "}",
    ].join("\n");

    const fragmentSource = [
      "#version 300 es",
      "precision highp float;",
      "in vec2 vUv;",
      "uniform float uTime;",
      "uniform float uIteration;",
      "out vec4 outColor;",
      "void main() {",
      "  vec2 p = (vUv - 0.5) * vec2(1.7777778, 1.0);",
      "  float pulse = uTime * 0.18 + uIteration * 0.00037;",
      "  vec2 z = p + vec2(sin(pulse) * 0.11, cos(pulse * 0.83) * 0.08);",
      "  vec3 energy = vec3(0.0);",
      "  for (int i = 0; i < 8; ++i) {",
      "    float radius = clamp(dot(z, z), 0.17, 3.6);",
      "    z = abs(z) / radius - vec2(0.69, 0.46);",
      "    float wave = 0.5 + 0.5 * sin(z.x * 4.8 + z.y * 3.2 + pulse + float(i));",
      "    energy += vec3(0.08, 0.16, 0.21) * wave / (1.0 + abs(z.x + z.y));",
      "  }",
      "  float vignette = smoothstep(1.16, 0.16, length(p));",
      "  vec3 base = vec3(0.012, 0.035, 0.055);",
      "  vec3 colour = base + energy * vec3(0.42, 1.12, 1.36) * vignette;",
      "  colour += 0.08 * vec3(0.05, 0.62, 0.88) * sin(vec3(0.0, 1.4, 2.8) + pulse);",
      "  colour = colour / (1.0 + colour);",
      "  outColor = vec4(pow(max(colour, 0.0), vec3(0.82)), 1.0);",
      "}",
    ].join("\n");

    const vertexShader = this.compileShader(this.gl.VERTEX_SHADER, vertexSource);
    const fragmentShader = this.compileShader(this.gl.FRAGMENT_SHADER, fragmentSource);
    const program = this.gl.createProgram();
    if (!program) {
      throw new Error("Unable to create the GPU workload program.");
    }

    this.gl.attachShader(program, vertexShader);
    this.gl.attachShader(program, fragmentShader);
    this.gl.linkProgram(program);
    this.gl.deleteShader(vertexShader);
    this.gl.deleteShader(fragmentShader);

    if (!this.gl.getProgramParameter(program, this.gl.LINK_STATUS)) {
      const message = this.gl.getProgramInfoLog(program) || "Unknown program link error.";
      this.gl.deleteProgram(program);
      throw new Error("GPU workload link failed: " + message);
    }
    return program;
  }

  private compileShader(type: number, source: string): WebGLShader {
    const shader = this.gl.createShader(type);
    if (!shader) {
      throw new Error("Unable to create a GPU workload shader.");
    }
    this.gl.shaderSource(shader, source);
    this.gl.compileShader(shader);

    if (!this.gl.getShaderParameter(shader, this.gl.COMPILE_STATUS)) {
      const message = this.gl.getShaderInfoLog(shader) || "Unknown shader compile error.";
      this.gl.deleteShader(shader);
      throw new Error("GPU workload compile failed: " + message);
    }
    return shader;
  }
}

let gpuHarness: GpuBenchmarkHarness | null = null;

function clampRatio(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.max(0, Math.min(1, value));
}

function numeric(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : null;
}

function nestedNumeric(
  value: Record<string, unknown>,
  parent: string,
  child: string,
): number | undefined {
  const nested = record(value[parent]);
  return nested ? numeric(nested[child]) : undefined;
}

function normalizedStatus(value: unknown): BenchmarkStatus {
  return value === "failed" || value === "cancelled" || value === "completed"
    ? value
    : "completed";
}

function normalizeCpu(value: unknown): CpuBenchmarkUiResult {
  const source = record(value) || {};
  const status = normalizedStatus(source.status);
  const singleThreadMops =
    numeric(source.singleThreadMops) ??
    ((nestedNumeric(source, "singleThread", "operationsPerSecond") ?? Number.NaN) /
      1_000_000);
  const multiThreadMops =
    numeric(source.multiThreadMops) ??
    ((nestedNumeric(source, "allThreads", "operationsPerSecond") ?? Number.NaN) /
      1_000_000);
  const scaling = numeric(source.scaling) ?? numeric(source.scalingFactor);

  if (
    status === "completed" &&
    (!Number.isFinite(singleThreadMops) ||
      !Number.isFinite(multiThreadMops) ||
      scaling === undefined)
  ) {
    return {
      ...source,
      status: "failed",
      error: "Processor benchmark returned incomplete measurements.",
    };
  }

  return {
    ...source,
    status,
    singleThreadMops,
    multiThreadMops,
    scaling,
    logicalThreads: numeric(source.logicalThreads),
  };
}

function normalizeMemory(value: unknown): MemoryBenchmarkUiResult {
  const source = record(value) || {};
  const status = normalizedStatus(source.status);
  const throughputGiBs =
    numeric(source.throughputGiBs) ?? numeric(source.gigabytesPerSecond);
  if (status === "completed" && throughputGiBs === undefined) {
    return {
      ...source,
      status: "failed",
      error: "Memory benchmark returned an incomplete measurement.",
    };
  }
  return { ...source, status, throughputGiBs };
}

function normalizeStorage(value: unknown): StorageBenchmarkUiResult {
  const source = record(value) || {};
  const status = normalizedStatus(source.status);
  const writeMiBs =
    numeric(source.writeMiBs) ?? numeric(source.writeMegabytesPerSecond);
  const readMiBs =
    numeric(source.readMiBs) ?? numeric(source.readMegabytesPerSecond);
  if (
    status === "completed" &&
    (writeMiBs === undefined || readMiBs === undefined)
  ) {
    return {
      ...source,
      status: "failed",
      error: "Storage benchmark returned incomplete measurements.",
    };
  }
  return { ...source, status, writeMiBs, readMiBs };
}

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message) {
    return error.message;
  }
  if (typeof error === "string" && error.trim()) {
    return error;
  }
  return "The benchmark could not be completed.";
}

function isCancellationError(error: unknown): boolean {
  const message = errorMessage(error).toLowerCase();
  return (
    cancelRequested ||
    message.includes("cancel") ||
    message.includes("abort") ||
    (error instanceof Error && error.name === "AbortError")
  );
}

function setSuiteState(state: UiState, label: string): void {
  ui.suiteStatus.dataset.state = state;
  ui.suiteStatusText.textContent = label;
}

function setActivity(title: string, message: string, icon: string): void {
  ui.activityTitle.textContent = title;
  ui.activityMessage.textContent = message;
  ui.activityIcon.textContent = icon;
}

function setComponentProgress(id: ComponentId, ratio: number): void {
  const percentage = Math.round(clampRatio(ratio) * 100);
  const elements = ui.components[id];
  elements.progress.style.width = percentage + "%";
  elements.progressTrack.setAttribute("aria-valuenow", String(percentage));
}

function setSuiteProgress(ratio: number): void {
  const percentage = Math.round(clampRatio(ratio) * 100);
  ui.suiteProgress.style.width = percentage + "%";
  ui.suiteProgressLabel.textContent = percentage + "%";
  ui.suiteProgressTrack.setAttribute("aria-valuenow", String(percentage));
}

function setComponentState(id: ComponentId, state: UiState, detail?: string): void {
  const elements = ui.components[id];
  elements.card.dataset.state = state;
  if (detail) {
    elements.detail.textContent = detail;
  }
}

function resetComponentForRun(id: ComponentId): void {
  const elements = ui.components[id];
  elements.primary.textContent = "—";
  elements.unit.hidden = false;
  setComponentState(id, "queued", "Queued for this run");
  setComponentProgress(id, 0);
}

function setBusy(value: boolean): void {
  benchmarkBusy = value;
  ui.runAllButton.disabled = value;
  ui.stopButton.disabled = !value;
  ui.refreshSystemButton.disabled = value;
  for (const id of COMPONENTS) {
    ui.components[id].button.disabled = value;
  }
  ui.exportButton.disabled = value || !selectedRun;
}

function displayNumber(value: number | undefined, maximumFractionDigits = 2): string {
  if (value === undefined || !Number.isFinite(value)) {
    return "—";
  }
  return new Intl.NumberFormat(undefined, {
    maximumFractionDigits,
    minimumFractionDigits: maximumFractionDigits > 0 ? 1 : 0,
  }).format(value);
}

function resultMessage(result: ComponentResult): string {
  return (
    (typeof result.error === "string" && result.error) ||
    (typeof result.message === "string" && result.message) ||
    (result.status === "cancelled" ? "Test cancelled." : "Test failed.")
  );
}

function renderComponentResult(id: ComponentId, result: ComponentResult): void {
  const elements = ui.components[id];
  if (result.status !== "completed") {
    elements.primary.textContent =
      result.status === "cancelled" ? "Stopped" : "Failed";
    elements.unit.hidden = true;
    setComponentState(id, result.status, resultMessage(result));
    setComponentProgress(id, result.status === "cancelled" ? 0 : 1);
    return;
  }

  elements.unit.hidden = false;
  setComponentState(id, "completed");
  setComponentProgress(id, 1);

  if (id === "cpu") {
    const cpu = result as CpuBenchmarkUiResult;
    elements.primary.textContent = displayNumber(cpu.multiThreadMops, 1);
    elements.detail.textContent =
      displayNumber(cpu.singleThreadMops, 1) +
      " single · " +
      displayNumber(cpu.scaling, 2) +
      "× scaling · " +
      displayNumber(cpu.logicalThreads, 0) +
      " threads";
  } else if (id === "gpu") {
    const gpu = result as GpuBenchmarkUiResult;
    elements.primary.textContent = displayNumber(gpu.gpixelsPerSecond, 2);
    elements.detail.textContent =
      displayNumber(gpu.drawsPerSecond, 1) +
      " draws/s · " +
      displayNumber(gpu.width, 0) +
      " × " +
      displayNumber(gpu.height, 0);
  } else if (id === "memory") {
    const memory = result as MemoryBenchmarkUiResult;
    elements.primary.textContent = displayNumber(memory.throughputGiBs, 2);
    const bufferBytes = numeric(memory.bufferBytes);
    elements.detail.textContent = bufferBytes
      ? formatBytes(bufferBytes) + " copy workload"
      : "Sustained memory copy throughput";
  } else {
    const storage = result as StorageBenchmarkUiResult;
    elements.primary.textContent = displayNumber(storage.writeMiBs, 1);
    elements.detail.textContent =
      displayNumber(storage.readMiBs, 1) + " MiB/s buffered read · temporary file";
  }
}

function markRemainingCancelled(plan: ComponentId[], fromIndex: number): void {
  for (let index = fromIndex; index < plan.length; index += 1) {
    const id = plan[index];
    if (ui.components[id].card.dataset.state !== "completed") {
      ui.components[id].primary.textContent = "Stopped";
      ui.components[id].unit.hidden = true;
      setComponentState(id, "cancelled", "Not run after cancellation.");
      setComponentProgress(id, 0);
    }
  }
}

function resultFor(run: BenchmarkRun, id: ComponentId): ComponentResult | undefined {
  return run[id] as ComponentResult | undefined;
}

function assignResult(
  run: BenchmarkRun,
  id: ComponentId,
  value: ComponentResult,
): void {
  if (id === "cpu") {
    run.cpu = value as CpuBenchmarkUiResult;
  } else if (id === "gpu") {
    run.gpu = value as GpuBenchmarkUiResult;
  } else if (id === "memory") {
    run.memory = value as MemoryBenchmarkUiResult;
  } else {
    run.storage = value as StorageBenchmarkUiResult;
  }
}

function updateActiveProgress(id: ComponentId, ratio: number, message: string): void {
  if (!benchmarkBusy || activePlan[activePlanIndex] !== id) {
    return;
  }
  const safeRatio = clampRatio(ratio);
  setComponentProgress(id, safeRatio);
  setSuiteProgress((activePlanIndex + safeRatio) / activePlan.length);
  setActivity(COMPONENT_LABELS[id] + " test in progress", message, "•••");
}

function handleBridgeProgress(event: BenchmarkProgress): void {
  let component: ComponentId | null = null;
  if (event.benchmark === "cpu-single" || event.benchmark === "cpu-multi") {
    component = "cpu";
  } else if (event.benchmark === "memory") {
    component = "memory";
  } else if (event.benchmark === "storage") {
    component = "storage";
  }

  if (!component || activePlan[activePlanIndex] !== component) {
    return;
  }

  let ratio = clampRatio(event.completedRatio);
  if (event.benchmark === "cpu-single") {
    ratio *= 0.4;
  } else if (event.benchmark === "cpu-multi") {
    ratio = 0.4 + ratio * 0.6;
  }
  updateActiveProgress(component, ratio, event.message);
}

async function executeComponent(id: ComponentId): Promise<ComponentResult> {
  const api = window.pulsebench;
  if (id === "cpu") {
    return normalizeCpu(await api.runCpu());
  }
  if (id === "memory") {
    return normalizeMemory(await api.runMemory());
  }
  if (id === "storage") {
    return normalizeStorage(await api.runStorage());
  }
  if (!gpuHarness) {
    return {
      status: "failed",
      error: "WebGL2 is unavailable, so the graphics test cannot run.",
    };
  }
  return gpuHarness.run((ratio, message) => {
    updateActiveProgress("gpu", ratio, message);
  });
}

async function beginRun(plan: ComponentId[]): Promise<void> {
  if (benchmarkBusy || !window.pulsebench) {
    return;
  }

  const startedAt = new Date();
  const run: BenchmarkRun = {
    schemaVersion: 1,
    startedAt: startedAt.toISOString(),
    completedAt: "",
    systemInfo: currentSystemInfo,
    id:
      typeof crypto.randomUUID === "function"
        ? crypto.randomUUID()
        : String(Date.now()),
    scope: [...plan],
  };

  cancelRequested = false;
  activePlan = [...plan];
  activePlanIndex = 0;
  for (const id of plan) {
    resetComponentForRun(id);
  }
  setSuiteProgress(0);
  setSuiteState("running", plan.length === COMPONENTS.length ? "Running suite" : "Running test");
  setActivity("Preparing benchmarks", "Starting a clean, sequential measurement pass.", "•••");
  setBusy(true);

  try {
    for (let index = 0; index < plan.length; index += 1) {
      activePlanIndex = index;
      const id = plan[index];
      if (cancelRequested) {
        markRemainingCancelled(plan, index);
        break;
      }

      setComponentState(id, "running", "Preparing workload…");
      setComponentProgress(id, 0);
      setActivity(
        COMPONENT_LABELS[id] + " test in progress",
        id === "gpu"
          ? "Warming the fixed 1920 × 1080 shader workload."
          : "Preparing a repeatable local workload.",
        "•••",
      );

      let result: ComponentResult;
      try {
        result = await executeComponent(id);
      } catch (error) {
        result = isCancellationError(error)
          ? { status: "cancelled", message: "Test cancelled." }
          : { status: "failed", error: errorMessage(error) };
      }

      assignResult(run, id, result);
      renderComponentResult(id, result);
      setSuiteProgress((index + 1) / plan.length);

      if (result.status === "cancelled") {
        cancelRequested = true;
        markRemainingCancelled(plan, index + 1);
        break;
      }
    }

    const allCompleted = plan.every(
      (id) => resultFor(run, id)?.status === "completed",
    );
    const anyFailed = plan.some((id) => resultFor(run, id)?.status === "failed");

    if (allCompleted) {
      const completedAt = new Date();
      run.completedAt = completedAt.toISOString();
      run.status = "completed";
      run.durationMs = completedAt.getTime() - startedAt.getTime();
      const storedRun = run as StoredRun;
      saveCompletedRun(storedRun);
      setSuiteProgress(1);
      setSuiteState("completed", "Complete");
      setActivity(
        plan.length === COMPONENTS.length ? "Suite complete" : "Test complete",
        "Results were saved to local history and are ready to export.",
        "✓",
      );
      showToast("Benchmark complete. Results saved locally.");
    } else if (cancelRequested) {
      setSuiteState("cancelled", "Cancelled");
      setActivity(
        "Benchmark stopped",
        "Partial measurements were not added to completed-run history.",
        "■",
      );
    } else if (anyFailed) {
      setSuiteState("failed", "Finished with errors");
      setActivity(
        "Some tests could not finish",
        "Review the affected card for details. Completed-run history was not changed.",
        "!",
      );
    }
  } finally {
    activePlan = [];
    activePlanIndex = 0;
    setBusy(false);
  }
}

async function requestStop(): Promise<void> {
  if (!benchmarkBusy || cancelRequested) {
    return;
  }
  cancelRequested = true;
  ui.stopButton.disabled = true;
  setActivity(
    "Stopping safely",
    "Waiting for the current measurement batch to finish…",
    "■",
  );
  try {
    await Promise.resolve(window.pulsebench.cancel());
  } catch {
    // Local GPU cancellation is independent of the native engine.
  }
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return "Unknown";
  }
  if (bytes < 1024 ** 3) {
    return (
      new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 }).format(
        bytes / 1024 ** 2,
      ) + " MiB"
    );
  }
  const gibibytes = bytes / 1024 ** 3;
  return (
    new Intl.NumberFormat(undefined, {
      maximumFractionDigits: gibibytes >= 10 ? 0 : 1,
    }).format(gibibytes) + " GiB"
  );
}

function humanPlatform(platform: string | undefined): string {
  if (!platform) {
    return "Windows";
  }
  if (platform.toLowerCase() === "win32") {
    return "Windows";
  }
  return platform;
}

function renderSystemInfo(info: SystemInfo): void {
  const memoryBytes = info.totalMemoryBytes ?? info.memoryBytes ?? 0;
  const graphics =
    info.gpuRenderer ||
    info.gpuAdapters?.find((adapter) => Boolean(adapter.trim())) ||
    gpuHarness?.renderer ||
    "Unavailable";
  const osName = info.osName || humanPlatform(info.platform);
  const osVersion = info.osVersion || info.release || "";
  const osDescription = osVersion.toLowerCase().startsWith("windows")
    ? osVersion
    : osName + (osVersion ? " " + osVersion : "");

  ui.systemCpu.textContent =
    info.cpuModel +
    (info.logicalThreads ? " · " + info.logicalThreads + " threads" : "");
  ui.systemCpu.title = ui.systemCpu.textContent;
  ui.systemGpu.textContent = graphics;
  ui.systemGpu.title = graphics;
  ui.systemMemory.textContent = formatBytes(memoryBytes);
  ui.systemOs.textContent = osDescription + " · " + info.architecture;
  ui.systemOs.title = ui.systemOs.textContent;

  const appLabel = info.appVersion ? "PulseBench " + info.appVersion : "PulseBench";
  const electronLabel = info.electronVersion
    ? " · Electron " + info.electronVersion
    : "";
  ui.runtimeLabel.textContent = appLabel + electronLabel;
}

async function loadSystemInfo(): Promise<void> {
  ui.refreshSystemButton.disabled = true;
  try {
    const info = await window.pulsebench.getSystemInfo();
    currentSystemInfo = info;
    renderSystemInfo(info);
  } catch (error) {
    ui.systemCpu.textContent = "Unavailable";
    ui.systemGpu.textContent = gpuHarness?.renderer || "Unavailable";
    ui.systemMemory.textContent = "Unavailable";
    ui.systemOs.textContent = "Unavailable";
    ui.runtimeLabel.textContent = "Benchmark engine unavailable";
    showToast("Could not read system details: " + errorMessage(error), "error");
  } finally {
    ui.refreshSystemButton.disabled = benchmarkBusy;
  }
}

function isStoredRun(value: unknown): value is StoredRun {
  const candidate = record(value);
  return Boolean(
    candidate &&
      candidate.schemaVersion === 1 &&
      candidate.status === "completed" &&
      typeof candidate.id === "string" &&
      typeof candidate.startedAt === "string" &&
      typeof candidate.completedAt === "string" &&
      Array.isArray(candidate.scope),
  );
}

function loadHistory(): StoredRun[] {
  try {
    const serialized = window.localStorage.getItem(HISTORY_KEY);
    if (!serialized) {
      return [];
    }
    const parsed: unknown = JSON.parse(serialized);
    return Array.isArray(parsed) ? parsed.filter(isStoredRun).slice(0, 5) : [];
  } catch {
    return [];
  }
}

function persistHistory(): void {
  try {
    window.localStorage.setItem(HISTORY_KEY, JSON.stringify(runHistory.slice(0, 5)));
  } catch {
    showToast("History could not be saved on this PC.", "error");
  }
}

function saveCompletedRun(run: StoredRun): void {
  runHistory = [run, ...runHistory.filter((item) => item.id !== run.id)].slice(0, 5);
  selectedRun = run;
  persistHistory();
  renderHistory();
}

function runTitle(run: StoredRun): string {
  return run.scope.length === COMPONENTS.length
    ? "All tests"
    : run.scope.map((id) => COMPONENT_LABELS[id]).join(" + ");
}

function runSummary(run: StoredRun): string {
  const summary: string[] = [];
  if (run.cpu?.status === "completed") {
    summary.push(displayNumber(run.cpu.multiThreadMops, 1) + " Mops/s CPU");
  }
  if (run.gpu?.status === "completed") {
    summary.push(displayNumber(run.gpu.gpixelsPerSecond, 2) + " Gpixel/s GPU");
  }
  if (run.memory?.status === "completed") {
    summary.push(displayNumber(run.memory.throughputGiBs, 2) + " GiB/s RAM");
  }
  if (run.storage?.status === "completed") {
    summary.push(displayNumber(run.storage.writeMiBs, 1) + " MiB/s write");
  }
  return summary.join(" · ");
}

function formatRunTime(isoDate: string): string {
  const date = new Date(isoDate);
  if (Number.isNaN(date.getTime())) {
    return "Saved run";
  }
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

function selectStoredRun(run: StoredRun): void {
  selectedRun = run;
  for (const id of COMPONENTS) {
    const result = resultFor(run, id);
    if (result) {
      renderComponentResult(id, result);
    } else {
      const elements = ui.components[id];
      elements.primary.textContent = "—";
      elements.unit.hidden = false;
      setComponentState(id, "idle", "Not included in this run");
      setComponentProgress(id, 0);
    }
  }
  ui.exportButton.disabled = benchmarkBusy;
  renderHistory();
  setActivity("Saved run selected", formatRunTime(run.completedAt), "↗");
}

function renderHistory(): void {
  ui.historyList.replaceChildren();
  ui.clearHistoryButton.hidden = runHistory.length === 0;

  if (runHistory.length === 0) {
    const empty = document.createElement("li");
    empty.className = "empty-history";
    const icon = document.createElement("span");
    icon.setAttribute("aria-hidden", "true");
    icon.textContent = "↗";
    const copy = document.createElement("p");
    copy.textContent = "Your five latest completed runs will appear here.";
    empty.append(icon, copy);
    ui.historyList.append(empty);
    return;
  }

  for (const run of runHistory) {
    const item = document.createElement("li");
    const button = document.createElement("button");
    button.type = "button";
    button.className = "history-entry";
    button.setAttribute(
      "aria-label",
      "View " + runTitle(run) + " from " + formatRunTime(run.completedAt),
    );
    if (selectedRun?.id === run.id) {
      button.setAttribute("aria-current", "true");
    }

    const name = document.createElement("span");
    name.className = "history-name";
    name.textContent = runTitle(run);
    const time = document.createElement("time");
    time.className = "history-time";
    time.dateTime = run.completedAt;
    time.textContent = formatRunTime(run.completedAt);
    const summary = document.createElement("span");
    summary.className = "history-summary";
    summary.textContent = runSummary(run);
    button.append(name, time, summary);
    button.addEventListener("click", () => selectStoredRun(run));
    item.append(button);
    ui.historyList.append(item);
  }
}

function clearHistory(): void {
  runHistory = [];
  selectedRun = null;
  try {
    window.localStorage.removeItem(HISTORY_KEY);
  } catch {
    // The in-memory history is still cleared if storage is unavailable.
  }
  renderHistory();
  ui.exportButton.disabled = true;
  showToast("Local benchmark history cleared.");
}

async function exportSelectedRun(): Promise<void> {
  if (!selectedRun || benchmarkBusy) {
    return;
  }
  ui.exportButton.disabled = true;
  const originalText = ui.exportButton.textContent;
  ui.exportButton.textContent = "Exporting…";

  try {
    const response: unknown = await window.pulsebench.exportResults(selectedRun);
    if (typeof response === "string") {
      showToast("Results exported to " + response);
      return;
    }
    const exportResult = record(response);
    if (exportResult?.canceled === true || exportResult?.cancelled === true) {
      return;
    }
    if (exportResult?.success === false) {
      throw new Error(
        typeof exportResult.error === "string"
          ? exportResult.error
          : "The results file could not be written.",
      );
    }
    const path =
      (typeof exportResult?.filePath === "string" && exportResult.filePath) ||
      (typeof exportResult?.path === "string" && exportResult.path);
    showToast(path ? "Results exported to " + path : "Results exported.");
  } catch (error) {
    showToast("Export failed: " + errorMessage(error), "error");
  } finally {
    ui.exportButton.textContent = originalText;
    ui.exportButton.disabled = benchmarkBusy || !selectedRun;
  }
}

function showToast(message: string, kind: "info" | "error" = "info"): void {
  if (toastTimer !== undefined) {
    window.clearTimeout(toastTimer);
  }
  ui.toast.textContent = message;
  ui.toast.dataset.kind = kind;
  ui.toast.hidden = false;
  toastTimer = window.setTimeout(() => {
    ui.toast.hidden = true;
    toastTimer = undefined;
  }, 4_500);
}

function bindInteractions(): void {
  ui.runAllButton.addEventListener("click", () => {
    void beginRun([...COMPONENTS]);
  });
  ui.stopButton.addEventListener("click", () => {
    void requestStop();
  });
  ui.exportButton.addEventListener("click", () => {
    void exportSelectedRun();
  });
  ui.refreshSystemButton.addEventListener("click", () => {
    void loadSystemInfo();
  });
  ui.clearHistoryButton.addEventListener("click", clearHistory);

  for (const id of COMPONENTS) {
    ui.components[id].button.addEventListener("click", () => {
      void beginRun([id]);
    });
  }
}

async function initialize(): Promise<void> {
  bindInteractions();
  runHistory = loadHistory();
  selectedRun = runHistory[0] || null;
  renderHistory();
  ui.exportButton.disabled = !selectedRun;

  try {
    gpuHarness = new GpuBenchmarkHarness(
      ui.gpuCanvas,
      () => cancelRequested,
      () => !benchmarkBusy,
    );
    ui.gpuRenderer.textContent = gpuHarness.renderer;
    ui.gpuRenderer.title = gpuHarness.renderer;
    ui.gpuPreviewState.textContent = "Idle";
    gpuHarness.startPreview();
  } catch (error) {
    ui.gpuRenderer.textContent = errorMessage(error);
    ui.gpuPreviewState.textContent = "Unavailable";
    setComponentState("gpu", "failed", "WebGL2 is unavailable on this PC.");
  }

  if (!window.pulsebench) {
    setSuiteState("failed", "Engine unavailable");
    setActivity(
      "Benchmark engine unavailable",
      "Restart PulseBench. The secure renderer bridge did not load.",
      "!",
    );
    ui.runtimeLabel.textContent = "Secure bridge unavailable";
    ui.runAllButton.disabled = true;
    for (const id of COMPONENTS) {
      ui.components[id].button.disabled = true;
    }
    return;
  }

  const possibleCleanup = window.pulsebench.onProgress(handleBridgeProgress);
  if (typeof possibleCleanup === "function") {
    removeProgressListener = possibleCleanup;
  }

  await loadSystemInfo();
  setSuiteState("idle", "Ready");
  setActivity(
    "Ready to benchmark",
    "Close heavy apps for the cleanest comparison.",
    "✓",
  );
}

window.addEventListener("beforeunload", () => {
  removeProgressListener?.();
  gpuHarness?.stopPreview();
});

void initialize();
