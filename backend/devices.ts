/* عقود الأجهزة: المحركات والحساسات والمتحكم. */

/* ---------------- المحركات ---------------- */
export type ActuatorMode = 'position' | 'velocity' | 'torque';

export interface ActuatorLimits {
  maxTorque: number;
  maxVelocity: number;
}

export interface Actuator {
  readonly id: string;
  readonly mode: ActuatorMode;
  readonly limits: Readonly<ActuatorLimits>;
  /** يضبط الهدف حسب الوضع (راديان، راديان/ثانية، أو نيوتن.متر). */
  setTarget(value: number): void;
  readonly target: number;
}

/* ---------------- الحساسات ---------------- */
export interface SensorSpec {
  id: string;
  kind: string;
  /** تردد القراءة بالهرتز. */
  rateHz: number;
  /** انحراف معياري للضجيج (0 = بدون ضجيج). */
  noiseStdDev: number;
}

export interface SensorReading<T = unknown> {
  sensorId: string;
  /** الزمن المحاكى للقراءة بالثواني. */
  time: number;
  value: T;
}

export interface Sensor<T = unknown> {
  readonly spec: Readonly<SensorSpec>;
  /** تُستدعى كل خطوة فيزياء؛ ترجع قراءة فقط عندما يحين موعدها. */
  update(time: number): SensorReading<T> | null;
}

/* ---------------- المتحكم ---------------- */
export interface ControllerInput {
  time: number;
  readings: Readonly<Record<string, SensorReading>>;
}

/** أهداف المحركات بحسب المعرّف. */
export type ControllerOutput = Readonly<Record<string, number>>;

/** كود المستخدم يُنفَّذ في Worker معزول ويُغلَّف بهذه الواجهة (مع مهلة تنفيذ). */
export interface Controller {
  init?(): void | Promise<void>;
  update(input: ControllerInput): ControllerOutput;
  dispose?(): void;
}
