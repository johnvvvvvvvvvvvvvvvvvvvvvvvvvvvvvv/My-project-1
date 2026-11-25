import {
  DEFAULT_ROBOT_SPEC,
  QUAT_IDENTITY,
  SimClient,
  diffDrive,
  mulberry32,
  parseRobotSpec,
  quatFromYaw,
  type BodyDescriptor,
  type RobotInfo,
  type RobotSpec,
  type RobotTelemetry,
} from '../backend';
import { SnapshotInterpolator } from './render/interpolator';
import { AdaptiveQuality, QUALITY_LEVELS } from './render/quality';
import { SceneView } from './render/scene-view';

const $ = <T extends HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`#${id} missing`);
  return el as T;
};

/* ---------------- فحص البيئة ---------------- */
function showEnv(): boolean {
  const canvas = document.createElement('canvas');
  const checks: Array<[string, boolean]> = [
    ['crossOriginIsolated (COOP/COEP)', self.crossOriginIsolated === true],
    ['SharedArrayBuffer', typeof SharedArrayBuffer !== 'undefined'],
    ['Web Workers', typeof Worker !== 'undefined'],
    ['OffscreenCanvas', typeof OffscreenCanvas !== 'undefined'],
    ['WebGL2', canvas.getContext('webgl2') !== null],
    ['WebGPU', 'gpu' in navigator],
  ];
  $('env').innerHTML =
    '<table>' +
    checks
      .map(([l, ok]) => `<tr><td>${l}</td><td class="${ok ? 'ok' : 'bad'}">${ok ? '✔' : '✘'}</td></tr>`)
      .join('') +
    '</table>';
  return checks[0]?.[1] === true && checks[4]?.[1] === true;
}

const staticBox = (
  x: number, y: number, z: number,
  hx: number, hy: number, hz: number,
  rotation = { ...QUAT_IDENTITY },
): BodyDescriptor => ({
  type: 'static',
  shape: { kind: 'box', halfExtents: { x: hx, y: hy, z: hz } },
  transform: { position: { x, y, z }, rotation },
  friction: 0.6,
});

const looseBox = (x: number, y: number, z: number, half: number): BodyDescriptor => ({
  type: 'dynamic',
  shape: { kind: 'box', halfExtents: { x: half, y: half, z: half } },
  transform: { position: { x, y, z }, rotation: { ...QUAT_IDENTITY } },
  mass: 0.3,
  friction: 0.6,
  restitution: 0.05,
});

const ball = (x: number, y: number, z: number, radius: number): BodyDescriptor => ({
  type: 'dynamic',
  shape: { kind: 'sphere', radius },
  transform: { position: { x, y, z }, rotation: { ...QUAT_IDENTITY } },
  mass: 0.3,
  friction: 0.5,
  restitution: 0.4,
});

const fmt = (n: number, d = 2): string => (n >= 0 ? ' ' : '') + n.toFixed(d);

async function main(): Promise<void> {
  if (!showEnv()) {
    $('error').textContent = 'العزل (COOP/COEP) أو WebGL2 غير متاح، لا يمكن التشغيل. انظر README.md';
    return;
  }

  let client: SimClient;
  try {
    client = await SimClient.create({ maxBodies: 2048 });
  } catch (e) {
    $('error').textContent = e instanceof Error ? e.message : String(e);
    return;
  }
  client.onError = (m) => ($('error').textContent = `خطأ في المحاكاة: ${m}`);
  $('demo').hidden = false;

  /* ---------------- الرسم ---------------- */
  const quality = new AdaptiveQuality(2);
  const canvas = $<HTMLCanvasElement>('view');
  let view: SceneView;
  try {
    view = new SceneView({ canvas, maxBodies: client.config.maxBodies, quality });
  } catch (e) {
    $('error').textContent = `تعذّر بدء الرسم: ${e instanceof Error ? e.message : String(e)}`;
    return;
  }
  const raw = client.reader.createOutput();
  const smooth = client.reader.createOutput();
  const interp = new SnapshotInterpolator(client.config.maxBodies);

  /* ---------------- المشهد ---------------- */
  const rand = mulberry32(1234);
  let bodyTotal = 0;
  let sceneVersion = 0;

  async function track(desc: BodyDescriptor): Promise<void> {
    const version = sceneVersion;
    const { slot } = await client.addBody(desc);
    if (version !== sceneVersion) return; // أُعيد التعيين أثناء الانتظار
    if (slot >= 0) view.setBody(slot, desc.shape);
    bodyTotal++;
  }

  async function addBoxes(n: number): Promise<void> {
    for (let i = 0; i < n; i++) {
      await track(looseBox((rand() - 0.5) * 8, 1 + rand() * 4, (rand() - 0.5) * 8, 0.06 + rand() * 0.08));
    }
  }

  async function addBalls(n: number): Promise<void> {
    for (let i = 0; i < n; i++) {
      await track(ball((rand() - 0.5) * 8, 1 + rand() * 4, (rand() - 0.5) * 8, 0.05 + rand() * 0.07));
    }
  }

  async function buildArena(): Promise<void> {
    await track({
      type: 'static',
      shape: { kind: 'plane' },
      transform: { position: { x: 0, y: 0, z: 0 }, rotation: { ...QUAT_IDENTITY } },
      friction: 0.6,
    });
    // جدران ساحة 12×12 م
    await track(staticBox(0, 0.25, -6, 6.2, 0.25, 0.1));
    await track(staticBox(0, 0.25, 6, 6.2, 0.25, 0.1));
    await track(staticBox(-6, 0.25, 0, 0.1, 0.25, 6.2));
    await track(staticBox(6, 0.25, 0, 0.1, 0.25, 6.2));
    // منحدر خفيف (12°) يرتفع نحو +X
    const slope = (12 * Math.PI) / 180;
    await track(
      staticBox(3, 1.2 * Math.sin(slope) + 0.01 * Math.cos(slope), 0, 1.2, 0.01, 0.8, {
        x: 0,
        y: 0,
        z: Math.sin(slope / 2),
        w: Math.cos(slope / 2),
      }),
    );
    await addBoxes(12);
    await addBalls(6);
  }

  /* ---------------- الروبوت ---------------- */
  // البدء عند x=-3 (طرف الساحة)؛ ملف المواصفات يستطيع تغيير ذلك عبر spawn
  let currentSpec: RobotSpec = {
    ...DEFAULT_ROBOT_SPEC,
    casters: DEFAULT_ROBOT_SPEC.casters.map((c) => ({ ...c })),
    spawn: { ...DEFAULT_ROBOT_SPEC.spawn, x: -3 },
  };
  let robot: RobotInfo | null = null;
  const specMsg = $('spec-msg');

  function showSpecMessage(text: string, ok: boolean): void {
    specMsg.textContent = text;
    specMsg.className = ok ? 'ok' : 'bad';
  }

  async function spawnRobot(spec: RobotSpec): Promise<boolean> {
    const version = sceneVersion;
    let info: RobotInfo;
    try {
      info = await client.addRobot(spec);
    } catch (e) {
      showSpecMessage(`مواصفات مرفوضة: ${e instanceof Error ? e.message : String(e)}`, false);
      return false;
    }
    if (version !== sceneVersion) return false;
    for (const b of info.bodies) if (b.slot >= 0) view.setBody(b.slot, b.shape, b.color);
    const chassis = info.bodies.find((b) => b.role === 'chassis');
    if (chassis) view.follow(chassis.slot);
    robot = info;
    currentSpec = spec;
    lastSent = '';
    refreshCameraUi();
    showSpecMessage(`الروبوت: ${spec.name}`, true);
    return true;
  }

  function despawnRobot(): void {
    if (!robot) return;
    client.removeRobot(robot.robotId);
    for (const b of robot.bodies) view.removeBody(b.slot);
    robot = null;
  }

  async function buildScene(): Promise<void> {
    sceneVersion++;
    robot = null;
    view.clearBodies();
    bodyTotal = 0;
    await buildArena();
    await spawnRobot(currentSpec);
  }

  /* ---------------- الأزرار ---------------- */
  let paused = false;
  let speed = 1;
  $('btn-pause').onclick = () => {
    paused = !paused;
    if (paused) client.pause(); else client.resume();
    $('btn-pause').textContent = paused ? 'استئناف' : 'إيقاف مؤقت';
  };
  $('btn-step').onclick = () => client.stepOnce();
  $<HTMLSelectElement>('sel-speed').onchange = (e) => {
    speed = Number((e.target as HTMLSelectElement).value);
    client.setSpeed(speed);
  };
  $('btn-add').onclick = () => void addBoxes(20);
  $('btn-add-balls').onclick = () => void addBalls(20);
  $('btn-reset').onclick = () => {
    client.reset();
    void buildScene();
  };

  /* الجودة */
  const sel = $<HTMLSelectElement>('sel-quality');
  sel.innerHTML =
    '<option value="auto" selected>تلقائي</option>' +
    ['الأدنى', 'منخفضة', 'متوسطة', 'عالية'].map((label, i) => `<option value="${i}">${label}</option>`).join('');
  sel.onchange = () => quality.setManual(sel.value === 'auto' ? null : Number(sel.value));

  /* الكاميرا */
  const selLabel = $('sel-label');
  const btnFollow = $<HTMLButtonElement>('btn-follow');
  function refreshCameraUi(): void {
    const s = view.selected;
    selLabel.textContent = s === null ? '' : `المحدد: خانة ${s}`;
    btnFollow.disabled = s === null && view.following === null;
    btnFollow.textContent = view.following !== null ? 'إلغاء التتبع' : 'تتبع المحدد';
  }
  view.onSelect = refreshCameraUi;
  btnFollow.onclick = () => {
    if (view.following !== null) view.follow(null);
    else view.follow(view.selected);
    refreshCameraUi();
  };
  $('btn-cam-reset').onclick = () => {
    view.resetCamera();
    refreshCameraUi();
  };

  /* مواصفات الروبوت من ملف */
  $('btn-robot-reset').onclick = () => {
    despawnRobot();
    void spawnRobot(currentSpec);
  };
  $('btn-spec-download').onclick = () => {
    const blob = new Blob([JSON.stringify(currentSpec, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'robot-spec.json';
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  };
  const fileInput = $<HTMLInputElement>('file-spec');
  fileInput.onchange = async () => {
    const file = fileInput.files?.[0];
    fileInput.value = '';
    if (!file) return;
    let spec: RobotSpec;
    try {
      spec = parseRobotSpec(await file.text());
    } catch (e) {
      showSpecMessage(e instanceof Error ? e.message : String(e), false);
      return;
    }
    despawnRobot();
    if (!(await spawnRobot(spec))) await spawnRobot(currentSpec); // فشل: ارجع للروبوت السابق
  };

  /* ---------------- القيادة بلوحة المفاتيح ---------------- */
  const keys = new Set<string>();
  const DRIVE_KEYS = new Set([
    'KeyW', 'KeyA', 'KeyS', 'KeyD', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space', 'ShiftLeft', 'ShiftRight',
  ]);
  let lastSent = '';

  function updateDrive(): void {
    if (!robot) return;
    const g = robot.geometry;
    const fwd = (keys.has('KeyW') || keys.has('ArrowUp') ? 1 : 0) - (keys.has('KeyS') || keys.has('ArrowDown') ? 1 : 0);
    const turn = (keys.has('KeyA') || keys.has('ArrowLeft') ? 1 : 0) - (keys.has('KeyD') || keys.has('ArrowRight') ? 1 : 0);
    const boost = keys.has('ShiftLeft') || keys.has('ShiftRight') ? 1.6 : 1;
    const braking = keys.has('Space');
    // السرعة الخطية تبلغ 70% من الحد الأقصى للعجلات، والدوران حتى 3 راديان/ث
    const vMax = 0.7 * g.maxWheelVelocity * g.wheelRadius * boost;
    const wMax = 3 * boost;
    const { left, right } = braking ? { left: 0, right: 0 } : diffDrive(fwd * vMax, turn * wMax, g);
    const key = `${robot.robotId}:${left.toFixed(3)}:${right.toFixed(3)}`;
    if (key === lastSent) return;
    lastSent = key;
    client.setMotorTargets(robot.robotId, { left, right });
  }

  const isTyping = (t: EventTarget | null): boolean =>
    t instanceof HTMLInputElement || t instanceof HTMLSelectElement || t instanceof HTMLTextAreaElement;

  window.addEventListener('keydown', (e) => {
    if (isTyping(e.target) || !DRIVE_KEYS.has(e.code)) return;
    e.preventDefault();
    keys.add(e.code);
    updateDrive();
  });
  window.addEventListener('keyup', (e) => {
    if (!DRIVE_KEYS.has(e.code)) return;
    keys.delete(e.code);
    updateDrive();
  });
  window.addEventListener('blur', () => {
    keys.clear();
    updateDrive();
  });

  /* ---------------- القياسات ---------------- */
  let simText = '';
  let telemetryText = '';
  client.onStats = (s) => {
    simText = `sim: ${s.stepsPerSecond.toFixed(0)} steps/s | ${s.stepMs.toFixed(3)} ms/step | t=${s.time.toFixed(2)}s`;
  };
  client.onTelemetry = (list: RobotTelemetry[]) => {
    const t = list.find((r) => r.robotId === robot?.robotId);
    if (!t) return;
    const deg = (t.yaw * 180) / Math.PI;
    const maxT = currentSpec.motor.maxTorque;
    telemetryText =
      `pose: x=${fmt(t.x)} z=${fmt(t.z)} heading=${fmt(deg, 0)}°\n` +
      t.motors
        .map(
          (m) =>
            `${m.id.padEnd(5)} target=${fmt(m.target, 1)} rad/s  actual=${fmt(m.velocity, 1)} rad/s  torque=${fmt(m.torque, 3)}/${maxT} N·m`,
        )
        .join('\n');
  };

  await buildScene();
  refreshCameraUi();

  /* ---------------- حلقة الرسم ---------------- */
  let last = performance.now();
  let fpsEma = 60;
  let msEma = 16.7;
  let statsAt = 0;

  function frame(now: number): void {
    const dt = Math.min((now - last) / 1000, 0.25);
    last = now;

    const f = client.reader.read(raw);
    if (f) interp.push(raw, f.bodyCount, f.stepCount);
    const advance = paused ? 0 : dt * speed * client.config.physicsHz;
    const count = interp.sample(advance, smooth);
    view.render(smooth, count, dt);

    if (dt > 0) {
      fpsEma += (1 / dt - fpsEma) * 0.05;
      msEma += (dt * 1000 - msEma) * 0.05;
    }
    quality.onFrame(dt);

    if (now - statsAt > 250) {
      statsAt = now;
      const info = view.info;
      const q = quality.current;
      const qLabel = `${quality.isAuto ? 'auto ' : ''}L${q} (${QUALITY_LEVELS[q]?.maxPixelRatio}x${QUALITY_LEVELS[q]?.shadows ? ' +shadows' : ''})`;
      $('stats').textContent =
        `fps: ${fpsEma.toFixed(0)} | frame: ${msEma.toFixed(1)} ms | quality: ${qLabel}\n` +
        `bodies: ${bodyTotal + (robot?.bodies.length ?? 0)} | draw calls: ${info.drawCalls} | triangles: ${info.triangles}\n` +
        simText;
      $('telemetry').textContent = telemetryText;
    }
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);

  // للتصحيح من وحدة التحكم
  (window as unknown as { __robosim: unknown }).__robosim = { client, view, quality, quatFromYaw };
}

void main();
