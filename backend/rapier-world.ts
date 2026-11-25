import RAPIER from '@dimforge/rapier3d-deterministic-compat';
import { rotateVec3, type Transform, type Vec3 } from './math';
import type { SharedStateWriter } from './shared-state';
import type {
  Body,
  BodyDescriptor,
  BodyId,
  JointId,
  Ray,
  RayHit,
  RevoluteJointDescriptor,
  SphericalJointDescriptor,
  World,
  WorldConfig,
} from './world';

/** المستوى اللانهائي يُمثَّل بصندوق ضخم وسطحه العلوي عند موضع الجسم. */
const PLANE_HALF_EXTENT = 1000;
const PLANE_HALF_THICKNESS = 1;

interface Entry {
  id: BodyId;
  descriptor: BodyDescriptor;
  rb: RAPIER.RigidBody;
  slot: number;
  /** هل يجب كتابة موضعه في الذاكرة المشتركة في الكتابة القادمة؟ */
  needsWrite: boolean;
}

interface JointEntry {
  id: JointId;
  kind: 'revolute' | 'spherical';
  joint: RAPIER.ImpulseJoint;
  bodyA: BodyId;
  bodyB: BodyId;
  /** محور المفصل بإطار الجسم A (للمفصل الدوّار فقط). */
  axis: Vec3 | null;
}

interface SnapshotMeta {
  version: 1;
  nextId: number;
  /** حقول اختيارية: اللقطات القديمة (قبل المفاصل) لا تحتويها. */
  nextJointId?: number;
  joints?: Array<{ id: number; handle: number; kind: 'revolute' | 'spherical'; bodyA: number; bodyB: number; axis: Vec3 | null }>;
  stepCount: number;
  highWater: number;
  freeSlots: number[];
  bodies: Array<{ id: number; handle: number; slot: number; descriptor: BodyDescriptor }>;
}

/** تنفيذ World فوق Rapier (نسخة deterministic). يجب إنشاؤه عبر RapierWorld.create. */
export class RapierWorld implements World {
  readonly config: Readonly<WorldConfig>;

  private world: RAPIER.World;
  private readonly entries = new Map<number, Entry>();
  private readonly handleToId = new Map<number, number>();
  private joints = new Map<number, JointEntry>();
  private nextJointId = 1;
  private freeSlots: number[] = [];
  private highWater = 0;
  private nextId = 1;
  private stepCount = 0;

  private constructor(config: WorldConfig, world: RAPIER.World) {
    this.config = config;
    this.world = world;
    this.world.timestep = 1 / config.physicsHz;
  }

  static async create(config: WorldConfig): Promise<RapierWorld> {
    await RAPIER.init();
    return new RapierWorld(config, new RAPIER.World(config.gravity));
  }

  get time(): number {
    return this.stepCount / this.config.physicsHz;
  }

  get steps(): number {
    return this.stepCount;
  }

  get bodyCount(): number {
    return this.entries.size;
  }

  addBody(descriptor: BodyDescriptor): Body {
    if (this.entries.size >= this.config.maxBodies) {
      throw new RangeError(`maxBodies (${this.config.maxBodies}) reached`);
    }
    const { type, shape, transform } = descriptor;

    const rbDesc =
      type === 'dynamic'
        ? RAPIER.RigidBodyDesc.dynamic()
        : type === 'kinematic'
          ? RAPIER.RigidBodyDesc.kinematicPositionBased()
          : RAPIER.RigidBodyDesc.fixed();
    rbDesc
      .setTranslation(transform.position.x, transform.position.y, transform.position.z)
      .setRotation(transform.rotation);

    let colDesc: RAPIER.ColliderDesc;
    switch (shape.kind) {
      case 'box':
        colDesc = RAPIER.ColliderDesc.cuboid(shape.halfExtents.x, shape.halfExtents.y, shape.halfExtents.z);
        break;
      case 'sphere':
        colDesc = RAPIER.ColliderDesc.ball(shape.radius);
        break;
      case 'cylinder': {
        colDesc = RAPIER.ColliderDesc.cylinder(shape.halfHeight, shape.radius);
        // محور Rapier الأصلي للأسطوانة هو Y؛ ندوّر المجسّم محلياً للمحاور الأخرى
        if (shape.axis === 'z') colDesc.setRotation({ x: Math.SQRT1_2, y: 0, z: 0, w: Math.SQRT1_2 });
        else if (shape.axis === 'x') colDesc.setRotation({ x: 0, y: 0, z: -Math.SQRT1_2, w: Math.SQRT1_2 });
        break;
      }
      case 'plane':
        if (type !== 'static') throw new Error('plane must be static');
        colDesc = RAPIER.ColliderDesc.cuboid(PLANE_HALF_EXTENT, PLANE_HALF_THICKNESS, PLANE_HALF_EXTENT)
          .setTranslation(0, -PLANE_HALF_THICKNESS, 0);
        break;
    }
    if (descriptor.friction !== undefined) colDesc.setFriction(descriptor.friction);
    if (descriptor.restitution !== undefined) colDesc.setRestitution(descriptor.restitution);
    if (descriptor.mass !== undefined && type === 'dynamic') colDesc.setMass(descriptor.mass);

    const rb = this.world.createRigidBody(rbDesc);
    this.world.createCollider(colDesc, rb);

    const id = this.nextId++ as BodyId;
    const slot = this.allocateSlot();
    this.entries.set(id, { id, descriptor, rb, slot, needsWrite: true });
    this.handleToId.set(rb.handle, id);
    return { id, descriptor };
  }

  removeBody(id: BodyId): void {
    const entry = this.entries.get(id);
    if (!entry) return;
    // Rapier يحذف المفاصل المتصلة بالجسم تلقائياً؛ ننظف سجلاتنا
    for (const [jid, j] of this.joints) {
      if (j.bodyA === id || j.bodyB === id) this.joints.delete(jid);
    }
    this.world.removeRigidBody(entry.rb);
    this.handleToId.delete(entry.rb.handle);
    this.entries.delete(id);
    this.releaseSlot(entry.slot);
  }

  /** رقم الخانة في الذاكرة المشتركة (يستخدمه الرسم لربط الجسم بمكانه). */
  slotOf(id: BodyId): number | undefined {
    return this.entries.get(id)?.slot;
  }

  getBodyTransform(id: BodyId): Transform | undefined {
    const e = this.entries.get(id);
    if (!e) return undefined;
    const t = e.rb.translation();
    const r = e.rb.rotation();
    return { position: { x: t.x, y: t.y, z: t.z }, rotation: { x: r.x, y: r.y, z: r.z, w: r.w } };
  }

  addRevoluteJoint(d: RevoluteJointDescriptor): JointId {
    const len = Math.hypot(d.axis.x, d.axis.y, d.axis.z);
    if (!(len > 0)) throw new Error('joint axis must be non-zero');
    const axis = { x: d.axis.x / len, y: d.axis.y / len, z: d.axis.z / len };
    const a = this.requireEntry(d.bodyA);
    const b = this.requireEntry(d.bodyB);
    const params = RAPIER.JointData.revolute(d.anchorA, d.anchorB, axis);
    return this.registerJoint('revolute', params, a, b, axis);
  }

  addSphericalJoint(d: SphericalJointDescriptor): JointId {
    const a = this.requireEntry(d.bodyA);
    const b = this.requireEntry(d.bodyB);
    const params = RAPIER.JointData.spherical(d.anchorA, d.anchorB);
    return this.registerJoint('spherical', params, a, b, null);
  }

  jointVelocity(id: JointId): number {
    const j = this.requireJoint(id);
    if (!j.axis) throw new Error('joint has no axis');
    const a = this.requireEntry(j.bodyA).rb;
    const b = this.requireEntry(j.bodyB).rb;
    const axisW = rotateVec3(a.rotation(), j.axis);
    const wa = a.angvel();
    const wb = b.angvel();
    return (wb.x - wa.x) * axisW.x + (wb.y - wa.y) * axisW.y + (wb.z - wa.z) * axisW.z;
  }

  applyJointTorque(id: JointId, torque: number): void {
    if (torque === 0) return;
    const j = this.requireJoint(id);
    if (!j.axis) throw new Error('joint has no axis');
    const a = this.requireEntry(j.bodyA).rb;
    const b = this.requireEntry(j.bodyB).rb;
    const axisW = rotateVec3(a.rotation(), j.axis);
    // العزم يُطبَّق كدفعة زاوية = عزم × dt، فلا نعتمد على سلوك تراكم القوى في Rapier
    const k = torque / this.config.physicsHz;
    b.applyTorqueImpulse({ x: axisW.x * k, y: axisW.y * k, z: axisW.z * k }, true);
    a.applyTorqueImpulse({ x: -axisW.x * k, y: -axisW.y * k, z: -axisW.z * k }, true);
  }

  step(): void {
    this.world.step();
    this.stepCount++;
  }

  /** يكتب مواضع الأجسام المتغيرة فقط في الذاكرة المشتركة. */
  writeState(writer: SharedStateWriter): void {
    writer.begin();
    for (const e of this.entries.values()) {
      const isStatic = e.descriptor.type === 'static';
      const sleeping = !isStatic && e.rb.isSleeping();
      // الثابت يُكتب مرة واحدة؛ النائم يُكتب مرة أخيرة بعد نومه ثم يتوقف
      if (!e.needsWrite && (isStatic || sleeping)) continue;
      const t = e.rb.translation();
      const r = e.rb.rotation();
      writer.writeBody(e.slot, t.x, t.y, t.z, r.x, r.y, r.z, r.w);
      e.needsWrite = !isStatic && !sleeping;
    }
    for (const slot of this.freeSlots) writer.clearBody(slot);
    writer.end(this.highWater, this.stepCount);
  }

  raycast(ray: Ray): RayHit | null {
    const { x, y, z } = ray.direction;
    const len = Math.hypot(x, y, z);
    if (len === 0) return null;
    const dir = { x: x / len, y: y / len, z: z / len };
    const hit = this.world.castRayAndGetNormal(new RAPIER.Ray(ray.origin, dir), ray.maxDistance, true);
    if (!hit) return null;
    const handle = hit.collider.parent()?.handle;
    const id = handle === undefined ? undefined : this.handleToId.get(handle);
    if (id === undefined) return null;
    const d = hit.timeOfImpact;
    return {
      distance: d,
      bodyId: id as BodyId,
      point: { x: ray.origin.x + dir.x * d, y: ray.origin.y + dir.y * d, z: ray.origin.z + dir.z * d },
      normal: { x: hit.normal.x, y: hit.normal.y, z: hit.normal.z },
    };
  }

  /** الصيغة: [uint32 طول JSON][JSON meta][لقطة Rapier]. */
  snapshot(): Uint8Array {
    const meta: SnapshotMeta = {
      version: 1,
      nextId: this.nextId,
      nextJointId: this.nextJointId,
      joints: [...this.joints.values()].map((j) => ({
        id: j.id,
        handle: j.joint.handle,
        kind: j.kind,
        bodyA: j.bodyA,
        bodyB: j.bodyB,
        axis: j.axis,
      })),
      stepCount: this.stepCount,
      highWater: this.highWater,
      freeSlots: [...this.freeSlots],
      bodies: [...this.entries.values()].map((e) => ({
        id: e.id,
        handle: e.rb.handle,
        slot: e.slot,
        descriptor: e.descriptor,
      })),
    };
    const metaBytes = new TextEncoder().encode(JSON.stringify(meta));
    const rapierBytes = this.world.takeSnapshot();
    const out = new Uint8Array(4 + metaBytes.length + rapierBytes.length);
    new DataView(out.buffer).setUint32(0, metaBytes.length, true);
    out.set(metaBytes, 4);
    out.set(rapierBytes, 4 + metaBytes.length);
    return out;
  }

  restore(snapshot: Uint8Array): void {
    const metaLen = new DataView(snapshot.buffer, snapshot.byteOffset, snapshot.byteLength).getUint32(0, true);
    const meta = JSON.parse(new TextDecoder().decode(snapshot.subarray(4, 4 + metaLen))) as SnapshotMeta;
    if (meta.version !== 1) throw new Error(`unsupported snapshot version ${meta.version}`);

    const restored = RAPIER.World.restoreSnapshot(snapshot.slice(4 + metaLen));
    restored.timestep = 1 / this.config.physicsHz;
    this.world.free();
    this.world = restored;

    this.entries.clear();
    this.handleToId.clear();
    for (const b of meta.bodies) {
      const rb = restored.getRigidBody(b.handle);
      this.entries.set(b.id, { id: b.id as BodyId, descriptor: b.descriptor, rb, slot: b.slot, needsWrite: true });
      this.handleToId.set(b.handle, b.id);
    }
    this.joints = new Map();
    for (const j of meta.joints ?? []) {
      const joint = restored.getImpulseJoint(j.handle);
      this.joints.set(j.id, {
        id: j.id as JointId,
        kind: j.kind,
        joint,
        bodyA: j.bodyA as BodyId,
        bodyB: j.bodyB as BodyId,
        axis: j.axis,
      });
    }
    this.nextJointId = meta.nextJointId ?? 1;
    this.nextId = meta.nextId;
    this.stepCount = meta.stepCount;
    this.highWater = meta.highWater;
    this.freeSlots = [...meta.freeSlots];
  }

  dispose(): void {
    this.world.free();
    this.joints.clear();
    this.entries.clear();
    this.handleToId.clear();
  }

  private requireEntry(id: BodyId): Entry {
    const e = this.entries.get(id);
    if (!e) throw new Error(`unknown body ${id}`);
    return e;
  }

  private requireJoint(id: JointId): JointEntry {
    const j = this.joints.get(id);
    if (!j) throw new Error(`unknown joint ${id}`);
    return j;
  }

  private registerJoint(
    kind: 'revolute' | 'spherical',
    params: RAPIER.JointData,
    a: Entry,
    b: Entry,
    axis: Vec3 | null,
  ): JointId {
    const joint = this.world.createImpulseJoint(params, a.rb, b.rb, true);
    // الأجسام المتصلة لا تتصادم مع بعضها (العجلة مع الهيكل)
    joint.setContactsEnabled(false);
    const id = this.nextJointId++ as JointId;
    this.joints.set(id, { id, kind, joint, bodyA: a.id, bodyB: b.id, axis });
    return id;
  }

  /** أصغر خانة فارغة أولاً (ترتيب حتمي). */
  private allocateSlot(): number {
    const reused = this.freeSlots.shift();
    if (reused !== undefined) return reused;
    return this.highWater++;
  }

  private releaseSlot(slot: number): void {
    this.freeSlots.push(slot);
    this.freeSlots.sort((a, b) => a - b);
  }
}
