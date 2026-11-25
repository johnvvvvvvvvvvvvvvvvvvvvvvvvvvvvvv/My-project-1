import {
  AmbientLight,
  BoxGeometry,
  Color,
  CylinderGeometry,
  DirectionalLight,
  Float32BufferAttribute,
  GridHelper,
  HemisphereLight,
  InstancedMesh,
  Mesh,
  MeshStandardMaterial,
  PCFSoftShadowMap,
  PerspectiveCamera,
  PlaneGeometry,
  Raycaster,
  Scene,
  SphereGeometry,
  Vector2,
  WebGLRenderer,
  type BufferGeometry,
} from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { FLOATS_PER_BODY, type Shape } from '../../backend';
import { type AdaptiveQuality } from './quality';

const KIND_NONE = 0;
const KIND_BOX = 1;
const KIND_SPHERE = 2;
const KIND_CYLINDER = 3;
const KIND_PLANE = 4;
const KIND_CYLINDER_X = 5;
const KIND_CYLINDER_Z = 6;

const SELECTED_COLOR = new Color(0xffd33d);
const DEFAULT_CAMERA_POS: readonly [number, number, number] = [10, 7, 12];
const DEFAULT_TARGET: readonly [number, number, number] = [0, 2, 0];

export interface SceneViewOptions {
  canvas: HTMLCanvasElement;
  maxBodies: number;
  quality: AdaptiveQuality;
}

export interface RenderInfo {
  drawCalls: number;
  triangles: number;
}

/**
 * مشهد Three.js: أجسام الفيزياء تُرسم بـ InstancedMesh (استدعاء رسم واحد لكل نوع شكل).
 * رقم الخانة (slot) في الذاكرة المشتركة = رقم النسخة (instanceId).
 */
export class SceneView {
  onSelect: ((slot: number | null) => void) | null = null;

  private readonly canvas: HTMLCanvasElement;
  private readonly maxBodies: number;
  private readonly quality: AdaptiveQuality;
  private readonly renderer: WebGLRenderer;
  private readonly scene = new Scene();
  private readonly camera: PerspectiveCamera;
  private readonly controls: OrbitControls;
  private readonly sun: DirectionalLight;
  private readonly ground: Mesh;
  private readonly grid: GridHelper;
  private readonly materials: MeshStandardMaterial[] = [];
  private readonly geometries: BufferGeometry[] = [];
  private readonly meshes: Record<number, InstancedMesh>;
  private readonly kinds: Uint8Array;
  private readonly scales: Float32Array;
  /** لون مخصص لكل خانة (0xRRGGBB)، و-1 = لون تلقائي. */
  private readonly colors: Int32Array;
  private readonly matrixArrays: Record<number, Float32Array> = {};
  private readonly resizeObserver: ResizeObserver;
  private readonly colorQuery: MediaQueryList;
  private readonly raycaster = new Raycaster();
  private readonly tmpColor = new Color();

  private planeSlot = -1;
  private selectedSlot: number | null = null;
  private followSlot: number | null = null;
  private appliedLevel = -1;
  private downX = 0;
  private downY = 0;
  private downTime = 0;
  private disposed = false;

  constructor(opts: SceneViewOptions) {
    this.canvas = opts.canvas;
    this.maxBodies = opts.maxBodies;
    this.quality = opts.quality;
    this.kinds = new Uint8Array(this.maxBodies);
    this.scales = new Float32Array(this.maxBodies * 3);
    this.colors = new Int32Array(this.maxBodies).fill(-1);

    this.renderer = new WebGLRenderer({
      canvas: this.canvas,
      antialias: window.devicePixelRatio < 2,
      powerPreference: 'high-performance',
    });
    this.renderer.shadowMap.type = PCFSoftShadowMap;

    this.camera = new PerspectiveCamera(55, 16 / 9, 0.1, 500);
    this.camera.position.set(...DEFAULT_CAMERA_POS);

    this.controls = new OrbitControls(this.camera, this.canvas);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.1;
    this.controls.maxPolarAngle = Math.PI / 2 - 0.02;
    this.controls.minDistance = 0.5;
    this.controls.maxDistance = 200;
    this.controls.target.set(...DEFAULT_TARGET);
    this.controls.update();

    /* الإضاءة */
    this.scene.add(new HemisphereLight(0xffffff, 0x667788, 0.9));
    this.scene.add(new AmbientLight(0xffffff, 0.15));
    this.sun = new DirectionalLight(0xffffff, 2.2);
    this.sun.position.set(8, 16, 6);
    const sc = this.sun.shadow.camera;
    sc.left = -14;
    sc.right = 14;
    sc.top = 14;
    sc.bottom = -14;
    sc.near = 0.5;
    sc.far = 60;
    this.sun.shadow.bias = -0.0005;
    this.sun.shadow.normalBias = 0.02;
    this.scene.add(this.sun);

    /* الأرض والشبكة */
    const groundMat = this.track(new MeshStandardMaterial({ color: 0xcfd6de, roughness: 0.95 }));
    const groundGeo = this.trackGeo(new PlaneGeometry(400, 400));
    groundGeo.rotateX(-Math.PI / 2);
    this.ground = new Mesh(groundGeo, groundMat);
    this.ground.receiveShadow = true;
    this.scene.add(this.ground);
    this.grid = new GridHelper(400, 400, 0x7a8696, 0xa3adba);
    this.grid.position.y = 0.002;
    this.scene.add(this.grid);

    /* الأجسام (نسخ) */
    const bodyMat = this.track(new MeshStandardMaterial({ roughness: 0.6, metalness: 0.05 }));
    const makeMesh = (geo: BufferGeometry): InstancedMesh => {
      const mesh = new InstancedMesh(this.trackGeo(geo), bodyMat, this.maxBodies);
      mesh.frustumCulled = false;
      mesh.count = 0;
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      // كل النسخ مخفية في البداية (مصفوفة بمقياس صفر)
      const arr = mesh.instanceMatrix.array as Float32Array;
      for (let i = 0; i < this.maxBodies; i++) arr[i * 16 + 15] = 1;
      mesh.setColorAt(0, this.tmpColor.setRGB(1, 1, 1));
      this.scene.add(mesh);
      return mesh;
    };
    // الأسطوانات بألوان رؤوس (شريط داكن) ليظهر دوران العجلات
    const cylMat = this.track(new MeshStandardMaterial({ roughness: 0.6, metalness: 0.05, vertexColors: true }));
    const makeCylinder = (axis: 'x' | 'y' | 'z'): InstancedMesh => {
      const geo = new CylinderGeometry(1, 1, 1, 24);
      if (axis === 'z') geo.rotateX(Math.PI / 2);
      else if (axis === 'x') geo.rotateZ(-Math.PI / 2);
      addStripeColors(geo, axis);
      const mesh = makeMesh(geo);
      mesh.material = cylMat;
      return mesh;
    };
    this.meshes = {
      [KIND_BOX]: makeMesh(new BoxGeometry(1, 1, 1)),
      [KIND_SPHERE]: makeMesh(new SphereGeometry(1, 24, 16)),
      [KIND_CYLINDER]: makeCylinder('y'),
      [KIND_CYLINDER_X]: makeCylinder('x'),
      [KIND_CYLINDER_Z]: makeCylinder('z'),
    };
    for (const [kind, mesh] of Object.entries(this.meshes)) {
      this.matrixArrays[Number(kind)] = mesh.instanceMatrix.array as Float32Array;
    }

    /* السمة (فاتح/داكن) */
    this.colorQuery = window.matchMedia('(prefers-color-scheme: dark)');
    this.colorQuery.addEventListener('change', this.applyTheme);
    this.applyTheme();

    /* الحجم */
    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(this.canvas);

    /* الاختيار بالنقر (وليس بالسحب) */
    this.canvas.addEventListener('pointerdown', this.onPointerDown);
    this.canvas.addEventListener('pointerup', this.onPointerUp);

    this.applyQuality();
    this.resize();
  }

  /* ---------------- إدارة الأجسام ---------------- */

  /**
   * يسجّل شكل الجسم في خانته (يُستدعى بعد addBody).
   * @param color لون 0xRRGGBB اختياري (وإلا لون تلقائي حسب الخانة)
   */
  setBody(slot: number, shape: Shape, color?: number): void {
    if (slot < 0 || slot >= this.maxBodies) return;
    this.hideSlot(slot);
    this.colors[slot] = color ?? -1;
    const o = slot * 3;
    switch (shape.kind) {
      case 'box':
        this.kinds[slot] = KIND_BOX;
        this.scales[o] = shape.halfExtents.x * 2;
        this.scales[o + 1] = shape.halfExtents.y * 2;
        this.scales[o + 2] = shape.halfExtents.z * 2;
        break;
      case 'sphere':
        this.kinds[slot] = KIND_SPHERE;
        this.scales[o] = this.scales[o + 1] = this.scales[o + 2] = shape.radius;
        break;
      case 'cylinder': {
        const h = shape.halfHeight * 2;
        if (shape.axis === 'z') {
          this.kinds[slot] = KIND_CYLINDER_Z;
          this.scales[o] = shape.radius;
          this.scales[o + 1] = shape.radius;
          this.scales[o + 2] = h;
        } else if (shape.axis === 'x') {
          this.kinds[slot] = KIND_CYLINDER_X;
          this.scales[o] = h;
          this.scales[o + 1] = shape.radius;
          this.scales[o + 2] = shape.radius;
        } else {
          this.kinds[slot] = KIND_CYLINDER;
          this.scales[o] = shape.radius;
          this.scales[o + 1] = h;
          this.scales[o + 2] = shape.radius;
        }
        break;
      }
      case 'plane':
        this.kinds[slot] = KIND_PLANE;
        this.planeSlot = slot;
        break;
    }
    this.paintSlot(slot);
  }

  removeBody(slot: number): void {
    if (slot < 0 || slot >= this.maxBodies) return;
    this.hideSlot(slot);
    if (this.planeSlot === slot) this.planeSlot = -1;
    this.kinds[slot] = KIND_NONE;
    if (this.selectedSlot === slot) this.select(null);
    if (this.followSlot === slot) this.followSlot = null;
  }

  clearBodies(): void {
    for (let slot = 0; slot < this.maxBodies; slot++) {
      if (this.kinds[slot] !== KIND_NONE) this.hideSlot(slot);
    }
    this.kinds.fill(KIND_NONE);
    this.colors.fill(-1);
    this.planeSlot = -1;
    this.select(null);
    this.followSlot = null;
    for (const m of Object.values(this.meshes)) m.count = 0;
  }

  /* ---------------- الاختيار والكاميرا ---------------- */

  get selected(): number | null {
    return this.selectedSlot;
  }

  get following(): number | null {
    return this.followSlot;
  }

  select(slot: number | null): void {
    if (this.selectedSlot === slot) return;
    const prev = this.selectedSlot;
    this.selectedSlot = slot;
    if (prev !== null) this.paintSlot(prev);
    if (slot !== null) this.paintSlot(slot);
    this.onSelect?.(slot);
  }

  /** يتتبع جسماً (null لإيقاف التتبع والعودة إلى الكاميرا الحرة). */
  follow(slot: number | null): void {
    this.followSlot = slot !== null && this.kinds[slot] !== KIND_NONE && slot !== this.planeSlot ? slot : null;
  }

  resetCamera(): void {
    this.followSlot = null;
    this.camera.position.set(...DEFAULT_CAMERA_POS);
    this.controls.target.set(...DEFAULT_TARGET);
    this.controls.update();
  }

  /* ---------------- الجودة والحجم ---------------- */

  applyQuality(): void {
    const level = this.quality.current;
    if (level === this.appliedLevel) return;
    this.appliedLevel = level;
    const q = this.quality.settings;

    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, q.maxPixelRatio));
    this.resize();

    const shadowsChanged = this.renderer.shadowMap.enabled !== q.shadows;
    this.renderer.shadowMap.enabled = q.shadows;
    this.sun.castShadow = q.shadows;
    if (q.shadows && this.sun.shadow.mapSize.x !== q.shadowMapSize) {
      this.sun.shadow.map?.dispose();
      this.sun.shadow.map = null;
      this.sun.shadow.mapSize.set(q.shadowMapSize, q.shadowMapSize);
    }
    if (shadowsChanged) for (const m of this.materials) m.needsUpdate = true;
  }

  resize(): void {
    if (this.disposed) return;
    const w = Math.max(1, this.canvas.clientWidth);
    const h = Math.max(1, this.canvas.clientHeight);
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  get info(): RenderInfo {
    const i = this.renderer.info.render;
    return { drawCalls: i.calls, triangles: i.triangles };
  }

  /* ---------------- الرسم ---------------- */

  /**
   * @param state حالة مستكملة (FLOATS_PER_BODY لكل خانة)
   * @param bodyCount عدد الخانات المستخدمة
   * @param dt زمن الإطار بالثواني
   */
  render(state: Float32Array, bodyCount: number, dt: number): void {
    if (this.disposed) return;
    this.applyQuality();

    const n = Math.min(bodyCount, this.maxBodies);
    const mats = this.matrixArrays;

    for (let slot = 0; slot < n; slot++) {
      const kind = this.kinds[slot] as number;
      const o = slot * FLOATS_PER_BODY;
      const px = state[o] as number;
      if (Number.isNaN(px)) continue;
      if (kind === KIND_PLANE) {
        this.ground.position.y = state[o + 1] as number;
        this.grid.position.y = (state[o + 1] as number) + 0.002;
        continue;
      }
      const arr = mats[kind];
      if (!arr) continue;
      const s = slot * 3;
      writeMatrix(
        arr,
        slot * 16,
        px,
        state[o + 1] as number,
        state[o + 2] as number,
        state[o + 3] as number,
        state[o + 4] as number,
        state[o + 5] as number,
        state[o + 6] as number,
        this.scales[s] as number,
        this.scales[s + 1] as number,
        this.scales[s + 2] as number,
      );
    }
    for (const m of Object.values(this.meshes)) {
      m.count = n;
      m.instanceMatrix.needsUpdate = true;
    }

    this.updateFollow(state, n, dt);
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.resizeObserver.disconnect();
    this.colorQuery.removeEventListener('change', this.applyTheme);
    this.canvas.removeEventListener('pointerdown', this.onPointerDown);
    this.canvas.removeEventListener('pointerup', this.onPointerUp);
    this.controls.dispose();
    for (const m of Object.values(this.meshes)) m.dispose();
    for (const g of this.geometries) g.dispose();
    for (const m of this.materials) m.dispose();
    this.sun.shadow.map?.dispose();
    this.grid.geometry.dispose();
    this.renderer.dispose();
  }

  /* ---------------- داخلي ---------------- */

  private track(m: MeshStandardMaterial): MeshStandardMaterial {
    this.materials.push(m);
    return m;
  }

  private trackGeo<T extends BufferGeometry>(g: T): T {
    this.geometries.push(g);
    return g;
  }

  private updateFollow(state: Float32Array, n: number, dt: number): void {
    const slot = this.followSlot;
    if (slot === null || slot >= n) return;
    const o = slot * FLOATS_PER_BODY;
    const px = state[o] as number;
    if (Number.isNaN(px)) {
      this.followSlot = null;
      return;
    }
    // تنعيم أسّي مستقل عن معدل الإطارات
    const k = 1 - Math.exp(-10 * Math.min(dt, 0.1));
    const dx = (px - this.controls.target.x) * k;
    const dy = ((state[o + 1] as number) - this.controls.target.y) * k;
    const dz = ((state[o + 2] as number) - this.controls.target.z) * k;
    this.controls.target.x += dx;
    this.controls.target.y += dy;
    this.controls.target.z += dz;
    this.camera.position.x += dx;
    this.camera.position.y += dy;
    this.camera.position.z += dz;
  }

  private hideSlot(slot: number): void {
    for (const m of Object.values(this.meshes)) {
      const arr = m.instanceMatrix.array as Float32Array;
      arr.fill(0, slot * 16, slot * 16 + 16);
      arr[slot * 16 + 15] = 1;
    }
  }

  private paintSlot(slot: number): void {
    const kind = this.kinds[slot] as number;
    const mesh = this.meshes[kind];
    if (!mesh) return;
    const custom = this.colors[slot] as number;
    if (slot === this.selectedSlot) {
      this.tmpColor.copy(SELECTED_COLOR);
    } else if (custom >= 0) {
      this.tmpColor.setHex(custom);
    } else {
      // لون ثابت لكل خانة (زاوية ذهبية لتباعد الألوان)
      this.tmpColor.setHSL((slot * 0.61803398875) % 1, 0.55, 0.55);
    }
    mesh.setColorAt(slot, this.tmpColor);
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  }

  private readonly applyTheme = (): void => {
    const dark = this.colorQuery.matches;
    this.scene.background = new Color(dark ? 0x14181f : 0xdfe9f5);
    (this.ground.material as MeshStandardMaterial).color.set(dark ? 0x2a313b : 0xcfd6de);
  };

  private readonly onPointerDown = (e: PointerEvent): void => {
    this.downX = e.clientX;
    this.downY = e.clientY;
    this.downTime = performance.now();
  };

  private readonly onPointerUp = (e: PointerEvent): void => {
    const moved = Math.hypot(e.clientX - this.downX, e.clientY - this.downY);
    if (moved > 5 || performance.now() - this.downTime > 400) return;
    this.select(this.pick(e.clientX, e.clientY));
  };

  private pick(clientX: number, clientY: number): number | null {
    const rect = this.canvas.getBoundingClientRect();
    const ndc = new Vector2(
      ((clientX - rect.left) / rect.width) * 2 - 1,
      -(((clientY - rect.top) / rect.height) * 2 - 1),
    );
    this.raycaster.setFromCamera(ndc, this.camera);
    const list = Object.values(this.meshes);
    // الكرة المحيطة تُحسب مرة واحدة وتُخزَّن، فنعيد حسابها لأن المصفوفات تتغير
    for (const m of list) m.computeBoundingSphere();
    const hits = this.raycaster.intersectObjects(list, false);
    const first = hits[0];
    return first && first.instanceId !== undefined ? first.instanceId : null;
  }
}

/**
 * ألوان رؤوس لأسطوانة: شريط داكن على قطاع زاوي صغير (يمر على الجدار وعلى الغطاءين)
 * فيُرى دوران العجلة. المحور y بلا شريط (أبيض).
 */
function addStripeColors(geo: BufferGeometry, axis: 'x' | 'y' | 'z'): void {
  const pos = geo.getAttribute('position');
  const colors = new Float32Array(pos.count * 3);
  const TWO_PI = Math.PI * 2;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
    let v = 1;
    if (axis !== 'y') {
      const radial = axis === 'z' ? Math.hypot(x, y) : Math.hypot(y, z);
      if (radial < 1e-6) {
        v = 0.7; // مركز الغطاء
      } else {
        const a = axis === 'z' ? Math.atan2(y, x) : Math.atan2(z, y);
        const t = ((a % TWO_PI) + TWO_PI) % TWO_PI;
        v = t < 0.8 ? 0.3 : 1;
      }
    }
    colors[i * 3] = colors[i * 3 + 1] = colors[i * 3 + 2] = v;
  }
  geo.setAttribute('color', new Float32BufferAttribute(colors, 3));
}

/** يكتب مصفوفة TRS (عمودية) مباشرة دون إنشاء كائنات. */
function writeMatrix(
  m: Float32Array,
  o: number,
  px: number,
  py: number,
  pz: number,
  x: number,
  y: number,
  z: number,
  w: number,
  sx: number,
  sy: number,
  sz: number,
): void {
  const xx = x * x, yy = y * y, zz = z * z;
  const xy = x * y, xz = x * z, yz = y * z;
  const wx = w * x, wy = w * y, wz = w * z;
  m[o] = (1 - 2 * (yy + zz)) * sx;
  m[o + 1] = 2 * (xy + wz) * sx;
  m[o + 2] = 2 * (xz - wy) * sx;
  m[o + 3] = 0;
  m[o + 4] = 2 * (xy - wz) * sy;
  m[o + 5] = (1 - 2 * (xx + zz)) * sy;
  m[o + 6] = 2 * (yz + wx) * sy;
  m[o + 7] = 0;
  m[o + 8] = 2 * (xz + wy) * sz;
  m[o + 9] = 2 * (yz - wx) * sz;
  m[o + 10] = (1 - 2 * (xx + yy)) * sz;
  m[o + 11] = 0;
  m[o + 12] = px;
  m[o + 13] = py;
  m[o + 14] = pz;
  m[o + 15] = 1;
}
