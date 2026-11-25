/** أنواع رياضية أساسية. الوحدات: متر، راديان، ثانية. المحاور: Y لأعلى، نظام يميني. */
export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

/** رباعي (x, y, z, w) بصيغة وحدة. */
export interface Quat {
  x: number;
  y: number;
  z: number;
  w: number;
}

export interface Transform {
  position: Vec3;
  rotation: Quat;
}

export const vec3 = (x = 0, y = 0, z = 0): Vec3 => ({ x, y, z });
export const QUAT_IDENTITY: Readonly<Quat> = Object.freeze({ x: 0, y: 0, z: 0, w: 1 });

/** يدوّر المتجه v بالرباعي q (وحدة). */
export function rotateVec3(q: Quat, v: Vec3): Vec3 {
  // v' = v + 2w(u×v) + 2u×(u×v)  حيث u = (qx,qy,qz)
  const tx = 2 * (q.y * v.z - q.z * v.y);
  const ty = 2 * (q.z * v.x - q.x * v.z);
  const tz = 2 * (q.x * v.y - q.y * v.x);
  return {
    x: v.x + q.w * tx + (q.y * tz - q.z * ty),
    y: v.y + q.w * ty + (q.z * tx - q.x * tz),
    z: v.z + q.w * tz + (q.x * ty - q.y * tx),
  };
}

/** رباعي دوران حول محور Y بزاوية yaw (راديان). الموجب = انعطاف لليسار عند النظر للأمام (+X). */
export function quatFromYaw(yaw: number): Quat {
  return { x: 0, y: Math.sin(yaw / 2), z: 0, w: Math.cos(yaw / 2) };
}

/** زاوية الاتجاه حول Y (عكس quatFromYaw) بالنظر إلى محور الأمام +X. */
export function yawOf(q: Quat): number {
  const f = rotateVec3(q, { x: 1, y: 0, z: 0 });
  return Math.atan2(-f.z, f.x);
}
