import {
  FLOATS_PER_BODY,
  QUAT_IDENTITY,
  SimClient,
  mulberry32,
  type BodyDescriptor,
  type Shape,
} from '../backend';

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
  return checks[0]?.[1] === true;
}

const box = (x: number, y: number, half: number): BodyDescriptor => ({
  type: 'dynamic',
  shape: { kind: 'box', halfExtents: { x: half, y: half, z: half } },
  transform: { position: { x, y, z: 0 }, rotation: { ...QUAT_IDENTITY } },
  mass: 1,
  friction: 0.6,
  restitution: 0.1,
});

async function main(): Promise<void> {
  if (!showEnv()) {
    $('error').textContent = 'العزل (COOP/COEP) غير مفعّل، لا يمكن تشغيل المحاكاة. انظر README.md';
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

  const shapes = new Map<number, Shape>();
  const rand = mulberry32(1234);
  let bodyTotal = 0;

  async function track(desc: BodyDescriptor): Promise<void> {
    const { slot } = await client.addBody(desc);
    shapes.set(slot, desc.shape);
    bodyTotal++;
  }

  async function addBoxes(n: number): Promise<void> {
    for (let i = 0; i < n; i++) {
      await track(box((rand() - 0.5) * 8, 2 + rand() * 12, 0.15 + rand() * 0.25));
    }
  }

  async function buildScene(): Promise<void> {
    shapes.clear();
    bodyTotal = 0;
    await track({
      type: 'static',
      shape: { kind: 'plane' },
      transform: { position: { x: 0, y: 0, z: 0 }, rotation: { ...QUAT_IDENTITY } },
      friction: 0.8,
    });
    await addBoxes(50);
  }

  await buildScene();

  /* ---------------- الأزرار ---------------- */
  let paused = false;
  $('btn-pause').onclick = () => {
    paused = !paused;
    if (paused) client.pause(); else client.resume();
    $('btn-pause').textContent = paused ? 'استئناف' : 'إيقاف مؤقت';
  };
  $('btn-step').onclick = () => client.stepOnce();
  $<HTMLSelectElement>('sel-speed').onchange = (e) =>
    client.setSpeed(Number((e.target as HTMLSelectElement).value));
  $('btn-add').onclick = () => void addBoxes(50);
  $('btn-reset').onclick = () => {
    client.reset();
    void buildScene();
  };

  /* ---------------- الإحصاءات ---------------- */
  let statsText = '';
  client.onStats = (s) => {
    statsText = `steps/s: ${s.stepsPerSecond.toFixed(0)} | ms/step: ${s.stepMs.toFixed(3)} | sim time: ${s.time.toFixed(2)}s`;
  };

  /* ---------------- رسم جانبي ثنائي الأبعاد (للتحقق فقط؛ الرسم الحقيقي في المرحلة 2) ---------------- */
  const canvas = $<HTMLCanvasElement>('view');
  const g = canvas.getContext('2d');
  if (!g) throw new Error('2D context unavailable');
  const out = client.reader.createOutput();
  const scale = canvas.width / 24; // عرض الشاشة 24 متراً
  const toX = (x: number): number => canvas.width / 2 + x * scale;
  const toY = (y: number): number => canvas.height - 20 - y * scale;

  function frame(): void {
    const f = client.reader.read(out);
    g!.clearRect(0, 0, canvas.width, canvas.height);
    g!.strokeStyle = '#888';
    g!.beginPath();
    g!.moveTo(0, toY(0));
    g!.lineTo(canvas.width, toY(0));
    g!.stroke();

    if (f) {
      g!.strokeStyle = '#3b82f6';
      for (let slot = 0; slot < f.bodyCount; slot++) {
        const shape = shapes.get(slot);
        const o = slot * FLOATS_PER_BODY;
        const px = out[o] ?? Number.NaN;
        if (!shape || shape.kind === 'plane' || Number.isNaN(px)) continue;
        const py = out[o + 1] ?? 0;
        const qx = out[o + 3] ?? 0, qy = out[o + 4] ?? 0, qz = out[o + 5] ?? 0, qw = out[o + 6] ?? 1;
        // محورا الجسم X وY مسقطان على مستوى XY
        const ax = 1 - 2 * (qy * qy + qz * qz), ay = 2 * (qx * qy + qz * qw);
        const bx = 2 * (qx * qy - qz * qw), by = 1 - 2 * (qx * qx + qz * qz);
        if (shape.kind === 'box') {
          const hx = shape.halfExtents.x, hy = shape.halfExtents.y;
          g!.beginPath();
          for (const [sx, sy] of [[-1, -1], [1, -1], [1, 1], [-1, 1]] as const) {
            const wx = px + ax * hx * sx + bx * hy * sy;
            const wy = py + ay * hx * sx + by * hy * sy;
            if (sx === -1 && sy === -1) g!.moveTo(toX(wx), toY(wy)); else g!.lineTo(toX(wx), toY(wy));
          }
          g!.closePath();
          g!.stroke();
        } else if (shape.kind === 'sphere') {
          g!.beginPath();
          g!.arc(toX(px), toY(py), shape.radius * scale, 0, Math.PI * 2);
          g!.stroke();
        }
      }
    }
    g!.fillStyle = '#888';
    g!.font = '14px monospace';
    g!.fillText(`bodies: ${bodyTotal}`, 10, 20);
    $('stats').textContent = statsText;
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
}

void main();
