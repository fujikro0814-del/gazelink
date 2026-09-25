// Single source of numeric defaults (SI units: m, s, kg, N, rad) unless a name says otherwise.
// docs/CONTROL.md explains where each value enters the equations.

export const PHYSICS = {
  /** Fixed physics step [s] (1 kHz). */
  dt: 0.001,
  /** Upper bound of steps run per wake-up; a larger backlog is dropped (tab was throttled). */
  maxCatchUpSteps: 200,
} as const;

export const COMM = {
  /** CMD / STATE send rate [Hz]. */
  controlRateHz: 100,
  /** GAZE send rate [Hz]. */
  gazeRateHz: 30,
  /** PING interval [ms]; peer is considered lost after `pingTimeoutMs` without traffic. */
  pingIntervalMs: 1000,
  pingTimeoutMs: 5000,
  /** SYNC_REQ interval [ms] and number of samples kept by the NTP-style clock filter. */
  syncIntervalMs: 500,
  syncFilterSize: 8,
  /** Over SSE the client batches outgoing messages at this period [ms]. */
  sseBatchMs: 40,
} as const;

export const MASTER = {
  /** Virtual mass of the local (master) device [kg]. */
  mass: 0.5,
  /**
   * Spring / damper coupling the operator's hand (mouse) to the master mass.
   * handB is deliberately high (overdamped): see docs/CONTROL.md §2.1 for the delay-margin estimate.
   */
  handK: 300,
  handB: 60,
  /** Upper bound of the hand speed after filtering the raw target [m/s]. */
  handMaxSpeed: 1.5,
} as const;

export const JOG = {
  /** Keyboard hand speed [m/s] and the factor applied while Shift is held (precision mode). */
  speed: 0.2,
  slowFactor: 0.25,
  /**
   * Time constant of the first-order velocity filter [s]: speed rises / falls smoothly instead
   * of stepping (10-90 % in about 2.2 tau = 0.13 s).
   */
  tau: 0.06,
  /** Below this speed with no key held, the hand stops completely [m/s]. */
  stopSpeed: 1e-4,
} as const;

export const SLAVE = {
  /** Virtual mass of the remote (slave) tip [kg]. */
  mass: 2.0,
  /** PD coupling between the (delayed) command and the slave tip. */
  couplingK: 600,
  couplingB: 30,
  /** Always-on structural damping of the slave tip [N s/m]. */
  baseB: 2,
} as const;

export const ENV = {
  /** Penalty contact stiffness / damping for the wall and the table. */
  wallK: 5000,
  wallB: 20,
  floorK: 5000,
  floorB: 20,
  /** Tool point offset from the flange along the flange z axis [m] (Franka Hand TCP). */
  tcpOffset: 0.1034,
  /** Master hand limits (robot base frame). */
  workspaceMin: [0.15, -0.5, 0.0] as const,
  workspaceMax: [0.8, 0.5, 0.75] as const,
} as const;

export const GAZE = {
  /** Damping range of the gaze-adaptive term [N s/m]. */
  bMin: 2,
  bMax: 60,
  /** Forgetting time constant of the attention field [s]. */
  forgetTau: 2.0,
  /** Spatial spread of one gaze sample in the attention field [m]. */
  sigma: 0.08,
  /** Distance to an obstacle below which damping starts to rise [m]. */
  obstacleRange: 0.08,
  /** Weights of "lack of attention" and "obstacle proximity" in the damping law. */
  wAttention: 1.0,
  wObstacle: 0.8,
  /** Rate limit on b(t) [N s/m per s]. */
  slewRate: 150,
  /** Below this confidence the gaze is treated as unreliable and b returns to mid-range. */
  minConfidence: 0.5,
  /** Time constant of the return-to-middle when confidence is low [s]. */
  lowConfTau: 0.4,
  /** How long a gaze sample is kept at most [s] (older samples weigh < exp(-5)). */
  historyHorizon: 10,
} as const;

export const TDPA = {
  /** Drift compensation gain [1/s], only applied while the observer has surplus energy. */
  driftGain: 4,
  /** Fraction of the current energy surplus that drift compensation may spend per step. */
  driftBudget: 0.5,
} as const;

export const WAVE = {
  /** Wave impedance (characteristic impedance) [N s/m]. */
  impedance: 40,
} as const;

export const KIN = {
  /** DLS IK: base damping, manipulability threshold, max damping, null-space gain. */
  lambdaMin: 0.001,
  lambdaMax: 0.15,
  manipThreshold: 0.02,
  nullGain: 0.5,
  /** Orientation error weight relative to position error. */
  orientWeight: 0.3,
  /** Per-iteration limits: task-space position error [m] and joint increment [rad]. */
  maxStepPos: 0.01,
  maxStepJoint: 0.02,
} as const;

export const NET_DEFAULTS = {
  /** One-way artificial delay per direction [ms]. */
  delayMs: 0,
  /** Std. dev. of the Gaussian jitter [ms]. */
  jitterMs: 0,
  /** Whether jitter may reorder packets (otherwise delivery keeps FIFO order). */
  allowReorder: false,
  /** Long-run loss ratio [0..1]. */
  loss: 0,
  /** Gilbert-Elliott burst model enabled, and mean burst length in packets. */
  burst: false,
  burstLength: 4,
} as const;
