import { FLOATS_PER_BODY } from '../../backend';

/**
 * يستكمل (Interpolate) بين لقطتين من الذاكرة المشتركة ليبدو الرسم سلساً
 * رغم أن الفيزياء تعمل بتردد مختلف عن تردد الشاشة.
 *
 * يعرض الرسم متأخراً بنحو إطار واحد: لا يوجد استقراء (Extrapolation)، فلا ارتجاج.
 * الزمن هنا يُقاس بعدد خطوات الفيزياء لا بالثواني، فيتبع سرعة المحاكاة تلقائياً.
 */
export class SnapshotInterpolator {
  private older: Float32Array;
  private newer: Float32Array;
  private olderStep = -1;
  private newerStep = -1;
  private olderCount = 0;
  private newerCount = 0;
  private renderStep = 0;
  private hasNewer = false;

  constructor(maxBodies: number) {
    this.older = new Float32Array(maxBodies * FLOATS_PER_BODY);
    this.newer = new Float32Array(maxBodies * FLOATS_PER_BODY);
  }

  /** آخر رقم خطوة مستلم. */
  get latestStep(): number {
    return this.newerStep;
  }

  /** يُهمل الرسائل المكررة (نفس stepCount) ويعيد الضبط إن رجع العدّاد للخلف (reset). */
  push(source: Float32Array, bodyCount: number, stepCount: number): void {
    if (this.hasNewer && stepCount === this.newerStep && bodyCount === this.newerCount) return;

    if (this.hasNewer && stepCount < this.newerStep) {
      // إعادة تعيين المحاكاة: ابدأ من جديد
      this.hasNewer = false;
    }

    if (this.hasNewer) {
      const tmp = this.older;
      this.older = this.newer;
      this.newer = tmp;
      this.olderStep = this.newerStep;
      this.olderCount = this.newerCount;
    }
    this.newer.set(source.subarray(0, bodyCount * FLOATS_PER_BODY));
    this.newerStep = stepCount;
    this.newerCount = bodyCount;

    if (!this.hasNewer) {
      this.hasNewer = true;
      this.older.set(this.newer.subarray(0, bodyCount * FLOATS_PER_BODY));
      this.olderStep = stepCount;
      this.olderCount = bodyCount;
      this.renderStep = stepCount;
    }
  }

  /**
   * يقدّم زمن العرض ثم يكتب الحالة المستكملة في out.
   * @param advanceSteps عدد خطوات الفيزياء المقابلة للزمن الحقيقي المنقضي (0 إن كانت متوقفة)
   * @returns عدد الأجسام، أو 0 إن لم تصل أي لقطة بعد
   */
  sample(advanceSteps: number, out: Float32Array): number {
    if (!this.hasNewer) return 0;

    if (advanceSteps > 0) {
      this.renderStep += advanceSteps;
    } else {
      // متوقفة، أو خطوة واحدة يدوية: اعرض آخر لقطة مباشرة
      this.renderStep = this.newerStep;
    }
    // لا استقراء، ولا تأخر أكثر من فترة لقطة كاملة
    if (this.renderStep > this.newerStep) this.renderStep = this.newerStep;
    if (this.renderStep < this.olderStep) this.renderStep = this.olderStep;

    const span = this.newerStep - this.olderStep;
    const alpha = span > 0 ? (this.renderStep - this.olderStep) / span : 1;
    const count = this.newerCount;
    const a = this.older;
    const b = this.newer;

    for (let slot = 0; slot < count; slot++) {
      const o = slot * FLOATS_PER_BODY;
      const bpx = b[o] as number;
      if (Number.isNaN(bpx)) {
        out.fill(Number.NaN, o, o + FLOATS_PER_BODY);
        continue;
      }
      const apx = slot < this.olderCount ? (a[o] as number) : Number.NaN;
      if (Number.isNaN(apx) || alpha >= 1) {
        // جسم جديد أو لا حاجة للاستكمال
        for (let k = 0; k < FLOATS_PER_BODY; k++) out[o + k] = b[o + k] as number;
        continue;
      }
      // الموضع: استكمال خطي
      for (let k = 0; k < 3; k++) {
        const va = a[o + k] as number;
        const vb = b[o + k] as number;
        out[o + k] = va + (vb - va) * alpha;
      }
      // الدوران: NLERP عبر أقصر قوس
      let ax = a[o + 3] as number, ay = a[o + 4] as number, az = a[o + 5] as number, aw = a[o + 6] as number;
      const bx = b[o + 3] as number, by = b[o + 4] as number, bz = b[o + 5] as number, bw = b[o + 6] as number;
      if (ax * bx + ay * by + az * bz + aw * bw < 0) {
        ax = -ax; ay = -ay; az = -az; aw = -aw;
      }
      let qx = ax + (bx - ax) * alpha;
      let qy = ay + (by - ay) * alpha;
      let qz = az + (bz - az) * alpha;
      let qw = aw + (bw - aw) * alpha;
      const len = Math.hypot(qx, qy, qz, qw) || 1;
      qx /= len; qy /= len; qz /= len; qw /= len;
      out[o + 3] = qx; out[o + 4] = qy; out[o + 5] = qz; out[o + 6] = qw;
    }
    return count;
  }
}
