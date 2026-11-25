/**
 * جودة الرسم التلقائية.
 * المستويات من 0 (الأدنى) إلى 3 (الأعلى). تنخفض الجودة سريعاً إن تأخر الرسم،
 * وترتفع ببطء بعد استقرار طويل، مع تهدئة (Backoff) إن فشلت الزيادة.
 */
export interface QualityLevel {
  /** سقف نسبة البكسل؛ الفعلية = min(devicePixelRatio, هذا). */
  maxPixelRatio: number;
  shadows: boolean;
  shadowMapSize: number;
}

export const QUALITY_LEVELS: readonly QualityLevel[] = [
  { maxPixelRatio: 0.75, shadows: false, shadowMapSize: 512 },
  { maxPixelRatio: 1, shadows: true, shadowMapSize: 512 },
  { maxPixelRatio: 1.5, shadows: true, shadowMapSize: 1024 },
  { maxPixelRatio: 2, shadows: true, shadowMapSize: 2048 },
];

export const MAX_QUALITY = QUALITY_LEVELS.length - 1;

export interface AdaptiveQualityOptions {
  /** متوسط زمن إطار (ms) أعلى منه يعني بطئاً. 22 ≈ أقل من 45fps. */
  slowFrameMs?: number;
  /** متوسط زمن إطار (ms) أدنى منه يعني استقراراً قرب 60fps. */
  fastFrameMs?: number;
  /** نافذة القياس بالثواني. */
  windowSeconds?: number;
  /** ثواني الاستقرار المطلوبة قبل محاولة رفع الجودة. */
  upgradeAfterSeconds?: number;
}

export class AdaptiveQuality {
  private level: number;
  private auto = true;
  private windowTime = 0;
  private windowFrames = 0;
  private stableTime = 0;
  private upgradeDelay: number;
  private lastUpgradeAt = -Infinity;
  private clock = 0;
  private readonly slowMs: number;
  private readonly fastMs: number;
  private readonly windowSeconds: number;
  private readonly baseUpgradeDelay: number;

  constructor(initialLevel = 2, opts: AdaptiveQualityOptions = {}) {
    this.level = Math.min(Math.max(Math.round(initialLevel), 0), MAX_QUALITY);
    this.slowMs = opts.slowFrameMs ?? 22;
    this.fastMs = opts.fastFrameMs ?? 18;
    this.windowSeconds = opts.windowSeconds ?? 1;
    this.baseUpgradeDelay = opts.upgradeAfterSeconds ?? 8;
    this.upgradeDelay = this.baseUpgradeDelay;
  }

  get current(): number {
    return this.level;
  }

  get isAuto(): boolean {
    return this.auto;
  }

  get settings(): QualityLevel {
    return QUALITY_LEVELS[this.level] as QualityLevel;
  }

  /** مستوى ثابت يدوياً، أو null للعودة إلى التلقائي. */
  setManual(level: number | null): void {
    if (level === null) {
      this.auto = true;
      this.resetWindow();
      return;
    }
    this.auto = false;
    this.level = Math.min(Math.max(Math.round(level), 0), MAX_QUALITY);
  }

  /**
   * يُستدعى كل إطار بزمنه (ثوانٍ).
   * @returns المستوى الجديد إن تغيّر، وإلا null
   */
  onFrame(dtSeconds: number): number | null {
    if (!this.auto || !(dtSeconds > 0)) return null;
    // تجاهل الإطارات الشاذة (تبديل تبويب، توقف المتصفح)
    if (dtSeconds > 0.5) {
      this.resetWindow();
      return null;
    }
    this.clock += dtSeconds;
    this.windowTime += dtSeconds;
    this.windowFrames++;
    if (this.windowTime < this.windowSeconds) return null;

    const avgMs = (this.windowTime / this.windowFrames) * 1000;
    this.windowTime = 0;
    this.windowFrames = 0;

    if (avgMs > this.slowMs) {
      this.stableTime = 0;
      if (this.level > 0) {
        // إن جاء البطء بعد رفع حديث: ضاعف التهدئة قبل المحاولة التالية
        if (this.clock - this.lastUpgradeAt < this.upgradeDelay) {
          this.upgradeDelay = Math.min(this.upgradeDelay * 2, 120);
        }
        this.level--;
        return this.level;
      }
      return null;
    }

    if (avgMs <= this.fastMs) {
      this.stableTime += this.windowSeconds;
      if (this.stableTime >= this.upgradeDelay && this.level < MAX_QUALITY) {
        this.stableTime = 0;
        this.level++;
        this.lastUpgradeAt = this.clock;
        return this.level;
      }
    } else {
      this.stableTime = 0;
    }
    return null;
  }

  private resetWindow(): void {
    this.windowTime = 0;
    this.windowFrames = 0;
    this.stableTime = 0;
  }
}
