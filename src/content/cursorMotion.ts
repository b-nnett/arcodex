export interface Point {
  x: number;
  y: number;
}

export interface ViewportSize {
  width: number;
  height: number;
}

export interface CursorMotionInput {
  cursor: {
    visible: boolean;
    x: number;
    y: number;
    animateMovement?: boolean;
    moveSequence?: number;
  } | null;
  isVisible: boolean;
  turnKey: string | null;
  viewportSize: ViewportSize;
}

export interface CursorVisualState {
  filter: string;
  opacity: number;
  transform: string;
}

export type ArrivalCallback = (moveSequence: number) => void;

const CURSOR_SIZE = 24;
const CURSOR_ORIGIN = CURSOR_SIZE / 2;
const FALLBACK_X_RATIO = 0.58;
const FALLBACK_Y_RATIO = 0.55;
const BASE_ROTATION = normalizeDegrees(-44);
const BLUR_HIDDEN = 5;
const SCALE_HIDDEN = 0.4;
const THINK_DELAY_SECONDS = 0;
const THINK_DURATION_SECONDS = 1.41;
const THINK_WOBBLE_PERIOD_SECONDS = 0.66;
const THINK_WOBBLE_DEGREES = 12.5;
const FRAME_SECONDS = 1 / 60;
const SPRING_STEP_SECONDS = 1 / 240;
const MAX_SIMULATION_LAG_SECONDS = 1;
const SPRING_SETTLE_EPSILON = 0.001 * 60;
const ARRIVAL_DISTANCE = 0.85;
const ARRIVAL_SPEED = 12;
const SHORT_MOVE_DISTANCE = 196;
const SCOOT_ROTATION_DEGREES = 70;
const SCOOT_STRETCH_BLEND = 0.15;
const MIN_SCOOT_STRETCH = 0;

const STRETCH_SPRING = { dampingFraction: 0.85, response: 0.2 };
const VISIBILITY_SPRING = { dampingFraction: 0.86, response: 0.42 };
const SCOOT_PROGRESS_SPRING = { dampingFraction: 0.94, response: 0.19 };
const POSITION_SPRING = { dampingFraction: 0.9, response: 0.19 };
const ROTATION_SPRING = { dampingFraction: 0.9, response: 0.12 };
const SCOOT_ROTATION_SPRING = { dampingFraction: 0.82, response: 0.055 };
const SCOOT_STRETCH_SPRING = { dampingFraction: 0.86, response: 0.12 };

type SpringOptions = {
  dampingFraction: number;
  response: number;
};

type Spring = SpringOptions & {
  force: number;
  simulationTime: number;
  scriptTime: number;
  target: number;
  value: number;
  velocity: number;
};

type BezierSegment = {
  control1: Point;
  control2: Point;
  end: Point;
};

type BezierPath = {
  arc: Point | null;
  arcIn: Point | null;
  arcOut: Point | null;
  end: Point;
  endControl: Point;
  segments: BezierSegment[];
  start: Point;
  startControl: Point;
};

type Motion =
  | {
      mode: "bezier";
      path: BezierPath;
      progressSpring: Spring;
    }
  | {
      axisRotation: number;
      end: Point;
      mode: "scoot";
      progressSpring: Spring;
      rotationTarget: number;
      start: Point;
    };

type MotionState = {
  motion: Motion | null;
  point: Point;
  positionXSpring: Spring;
  positionYSpring: Spring;
  rotation: number;
  rotationSpring: Spring;
  scootAxisRotation: number;
  scootAxisSpring: Spring;
  scootRotationSpring: Spring;
  scootStretchSpring: Spring;
  stretchSpring: Spring;
  thinkStartedAt: number | null;
  visibilitySpring: Spring;
};

const PATH_CONFIG = {
  arcFlow: 0.5783555327868779,
  arcSize: 0.2765523188064277,
  boundsMargin: 20,
  candidateCount: 20,
  clickAngleDegrees: -44,
  endpointHandle: 0.15,
  startHandle: 0.41960295031576633,
};

export class CursorMotionController {
  private animationFrame: number | null = null;
  private lastAnimationTime = now();
  private state: MotionState | null = null;
  private currentMoveSequence: number | null = null;
  private currentMoveKey: string | null = null;
  private arrivedMoveKey: string | null = null;
  private visibleFallbackTurnKey: string | null = null;
  private initialArrivedTurnKey: string | null = null;
  private forceNextFrameDelta = false;
  private destroyed = false;

  constructor(
    private readonly render: (state: CursorVisualState) => void,
    private readonly onArrived?: ArrivalCallback,
  ) {}

  destroy(): void {
    this.destroyed = true;
    if (this.animationFrame != null) {
      cancelFrame(this.animationFrame);
      this.animationFrame = null;
    }
  }

  setState(input: CursorMotionInput): void {
    const turnKey = input.turnKey ?? "";
    const hasCursor = input.cursor != null;
    const targetPoint = constrainPoint({
      cursorX: input.cursor?.x,
      cursorY: input.cursor?.y,
      viewportHeight: input.viewportSize.height,
      viewportWidth: input.viewportSize.width,
    });
    const visible =
      input.isVisible !== false && input.cursor?.visible !== false;
    const animateMovement = input.cursor?.animateMovement !== false;
    const visibleWithoutCursor = visible && !hasCursor;

    this.currentMoveSequence = input.cursor?.moveSequence ?? null;
    this.currentMoveKey =
      this.currentMoveSequence == null
        ? null
        : `${turnKey}:${this.currentMoveSequence}`;

    this.state ??= createMotionState(targetPoint, visible);
    this.state.visibilitySpring.target = visible ? 1 : 0;

    if (visibleWithoutCursor && this.visibleFallbackTurnKey !== turnKey) {
      this.visibleFallbackTurnKey = turnKey;
      resetSpring(this.state.visibilitySpring, 1);
      this.state.thinkStartedAt = now();
    }

    if (!hasCursor) {
      snapTo(this.state, targetPoint);
      this.renderState();
      this.scheduleFrame();
      return;
    }

    const firstVisibleMove =
      input.cursor?.moveSequence != null &&
      visible &&
      this.state.visibilitySpring.value <= 0.001 &&
      this.initialArrivedTurnKey !== turnKey;
    this.state.thinkStartedAt = null;

    const distance = pointDistance(this.state.point, targetPoint);
    if (!animateMovement || firstVisibleMove || distance < 0.5) {
      if (firstVisibleMove) {
        this.initialArrivedTurnKey = turnKey;
        resetSpring(this.state.visibilitySpring, 1);
      }
      snapTo(this.state, targetPoint);
      if (!animateMovement) {
        resetActiveStretch(this.state);
      }
      this.renderState();
      this.publishArrival();
      this.scheduleFrame();
      return;
    }

    startMove(this.state, targetPoint, input.viewportSize);
    this.forceNextFrameDelta = true;
    this.renderState();
    this.scheduleFrame();
  }

  private scheduleFrame(): void {
    if (this.animationFrame != null || this.state == null || this.destroyed) {
      return;
    }
    this.animationFrame = requestFrame((time) => {
      this.animationFrame = null;
      const state = this.state;
      if (state == null) {
        return;
      }
      const deltaSeconds = this.forceNextFrameDelta
        ? FRAME_SECONDS
        : Math.max(FRAME_SECONDS, (time - this.lastAnimationTime) / 1000);
      this.forceNextFrameDelta = false;
      this.lastAnimationTime = time;
      const arrived = stepMotion(state, deltaSeconds, time);
      this.renderState();
      if (arrived) {
        this.publishArrival();
      }
      if (hasAnimationWork(state)) {
        this.scheduleFrame();
      }
    });
  }

  private renderState(): void {
    const state = this.state;
    if (state != null) {
      this.render(toVisualState(state, now()));
    }
  }

  private publishArrival(): void {
    if (
      this.currentMoveSequence == null ||
      this.currentMoveKey == null ||
      this.arrivedMoveKey === this.currentMoveKey
    ) {
      return;
    }
    this.arrivedMoveKey = this.currentMoveKey;
    this.onArrived?.(this.currentMoveSequence);
  }
}

function createMotionState(point: Point, visible: boolean): MotionState {
  const visibility = visible ? 1 : 0;
  return {
    motion: null,
    point,
    positionXSpring: createSpring(point.x, point.x, POSITION_SPRING),
    positionYSpring: createSpring(point.y, point.y, POSITION_SPRING),
    rotation: BASE_ROTATION,
    rotationSpring: createSpring(BASE_ROTATION, BASE_ROTATION, ROTATION_SPRING),
    scootAxisRotation: 0,
    scootAxisSpring: createSpring(0, 0, ROTATION_SPRING),
    scootRotationSpring: createSpring(0, 0, SCOOT_ROTATION_SPRING),
    scootStretchSpring: createSpring(1, 1, SCOOT_STRETCH_SPRING),
    stretchSpring: createSpring(1, 1, STRETCH_SPRING),
    thinkStartedAt: null,
    visibilitySpring: createSpring(visibility, visibility, VISIBILITY_SPRING),
  };
}

function startMove(
  state: MotionState,
  target: Point,
  bounds: ViewportSize,
): void {
  state.thinkStartedAt = null;
  const start = { x: state.point.x, y: state.point.y };
  if (pointDistance(start, target) <= SHORT_MOVE_DISTANCE) {
    startScoot(state, start, target);
    return;
  }

  const path = createBezierPath({ bounds, end: target, start });
  const springOptions = pathSpringOptions(path);
  setPositionSpringOptions(
    state,
    scalePositionResponse(springOptions.response),
    springOptions.dampingFraction,
  );
  state.motion = {
    mode: "bezier",
    path,
    progressSpring: createSpring(0, 1, springOptions),
  };
}

function startScoot(state: MotionState, start: Point, end: Point): void {
  const direction = normalizePoint({ x: end.x - start.x, y: end.y - start.y });
  const axisRotation = vectorAngle(direction);
  const rotationTarget =
    clamp(direction.x * 0.75 + -direction.y * 0.62, -1, 1) *
    SCOOT_ROTATION_DEGREES;

  setPositionSpringOptions(
    state,
    POSITION_SPRING.response,
    POSITION_SPRING.dampingFraction,
  );
  state.positionXSpring.target = end.x;
  state.positionYSpring.target = end.y;
  setAngleTarget(state.rotationSpring, BASE_ROTATION);
  setAngleTarget(state.scootAxisSpring, axisRotation);
  state.motion = {
    axisRotation,
    end,
    mode: "scoot",
    progressSpring: createSpring(0, 1, SCOOT_PROGRESS_SPRING),
    rotationTarget,
    start,
  };
}

function stepMotion(
  state: MotionState,
  deltaSeconds: number,
  time: number,
): boolean {
  const arrived = stepActiveMotion(state, deltaSeconds, time);
  stepSpring(state.visibilitySpring, deltaSeconds);
  stepSpring(state.stretchSpring, deltaSeconds);
  stepSpring(state.scootStretchSpring, deltaSeconds);
  stepSpring(state.scootRotationSpring, deltaSeconds);
  return arrived;
}

function stepActiveMotion(
  state: MotionState,
  deltaSeconds: number,
  time: number,
): boolean {
  if (state.motion == null) {
    state.stretchSpring.target = 1;
    state.scootStretchSpring.target = 1;
    state.scootRotationSpring.target = 0;
    return false;
  }

  state.thinkStartedAt = null;
  return state.motion.mode === "scoot"
    ? stepScoot(state, Math.max(0, deltaSeconds), time)
    : stepBezier(state, Math.max(0, deltaSeconds), time);
}

function stepBezier(
  state: MotionState,
  deltaSeconds: number,
  time: number,
): boolean {
  const motion = state.motion;
  if (motion?.mode !== "bezier") {
    return false;
  }

  state.scootStretchSpring.target = 1;
  state.scootRotationSpring.target = 0;
  stepSpring(motion.progressSpring, deltaSeconds);

  const progress = clamp(motion.progressSpring.value, 0, 1);
  const sample = sampleBezierPath(motion.path, progress);
  const rotation = cursorAngleFromTangent(sample.tangent);

  state.positionXSpring.target = sample.point.x;
  state.positionYSpring.target = sample.point.y;
  setAngleTarget(state.rotationSpring, rotation);
  setAngleTarget(state.scootAxisSpring, 0);

  const advanced = advancePosition(state, deltaSeconds);
  state.stretchSpring.target = stretchFromSpeed(advanced.speed);

  if (
    progress >= 0.999 &&
    Math.abs(motion.progressSpring.velocity) < 0.01 &&
    hasArrivedAt(state, sample.point)
  ) {
    const endSample = sampleBezierPath(motion.path, 1);
    const endRotation = cursorAngleFromTangent(endSample.tangent);
    snapPosition(state, endSample.point);
    resetSpring(state.rotationSpring, endRotation);
    state.rotation = endRotation;
    resetSpring(state.scootAxisSpring, 0);
    state.scootAxisRotation = 0;
    resetSpring(state.stretchSpring, 1);
    state.motion = null;
    state.thinkStartedAt = time;
    return true;
  }

  return false;
}

function stepScoot(
  state: MotionState,
  deltaSeconds: number,
  time: number,
): boolean {
  const motion = state.motion;
  if (motion?.mode !== "scoot") {
    return false;
  }

  stepSpring(motion.progressSpring, deltaSeconds);
  state.positionXSpring.target = motion.end.x;
  state.positionYSpring.target = motion.end.y;
  setAngleTarget(state.scootAxisSpring, motion.axisRotation);
  setAngleTarget(state.rotationSpring, BASE_ROTATION);

  const advanced = advancePosition(state, deltaSeconds);
  const progress = lineProgress(advanced.point, motion.start, motion.end);
  const sinusoidalProgress = Math.sin(Math.min(1, progress) * Math.PI);

  state.stretchSpring.target = 1;
  state.scootStretchSpring.target = scootStretch(progress);
  state.scootRotationSpring.target = motion.rotationTarget * sinusoidalProgress;

  if (
    progress >= 0.999 &&
    Math.abs(motion.progressSpring.velocity) < 0.01 &&
    hasArrivedAt(state, motion.end)
  ) {
    snapPosition(state, motion.end);
    resetSpring(state.rotationSpring, BASE_ROTATION);
    state.rotation = state.rotationSpring.value;
    resetScoot(state);
    resetSpring(state.stretchSpring, 1);
    state.motion = null;
    state.thinkStartedAt = time;
    return true;
  }

  return false;
}

function hasAnimationWork(state: MotionState): boolean {
  return (
    state.motion != null ||
    state.thinkStartedAt != null ||
    !isSpringResting(state.positionXSpring) ||
    !isSpringResting(state.positionYSpring) ||
    !isSpringResting(state.rotationSpring) ||
    !isSpringResting(state.scootAxisSpring) ||
    !isSpringResting(state.scootRotationSpring) ||
    !isSpringResting(state.scootStretchSpring) ||
    !isSpringResting(state.stretchSpring) ||
    !isSpringResting(state.visibilitySpring)
  );
}

function toVisualState(state: MotionState, time: number): CursorVisualState {
  const visibility = clamp(state.visibilitySpring.value, 0, 1);
  const scale = lerp(SCALE_HIDDEN, 1, visibility);
  const blur = lerp(BLUR_HIDDEN, 0, visibility);
  const scootStretch = clamp(
    state.scootStretchSpring.value,
    MIN_SCOOT_STRETCH,
    1,
  );
  const rotation = thinkingRotation(state, time);

  const transforms = [
    `translate3d(${roundCss(state.point.x - CURSOR_ORIGIN)}px, ${roundCss(
      state.point.y - CURSOR_ORIGIN,
    )}px, 0)`,
  ];

  if (
    Math.abs(shortAngleDelta(0, state.scootAxisRotation)) > 0.001 ||
    Math.abs(scootStretch - 1) > 0.001
  ) {
    transforms.push(
      `rotate(${roundCss(state.scootAxisRotation)}deg)`,
      `scale(1, ${roundCss(scootStretch)})`,
      `rotate(${roundCss(-state.scootAxisRotation)}deg)`,
    );
  }

  transforms.push(
    `rotate(${roundCss(normalizeDegrees(rotation + state.scootRotationSpring.value))}deg)`,
    `scale(${roundCss(state.stretchSpring.value * scale)}, ${roundCss(scale)})`,
  );

  return {
    filter: `blur(${roundCss(blur)}px)`,
    opacity: roundCss(visibility),
    transform: transforms.join(" "),
  };
}

function thinkingRotation(state: MotionState, time: number): number {
  if (state.thinkStartedAt == null) {
    return state.rotation;
  }

  const elapsedSeconds =
    (time - state.thinkStartedAt) / 1000 - THINK_DELAY_SECONDS;
  if (elapsedSeconds < 0) {
    return state.rotation;
  }

  const progress = Math.min(1, elapsedSeconds / THINK_DURATION_SECONDS);
  const envelope = Math.sin(progress * Math.PI);
  const wobble =
    Math.sin((elapsedSeconds / THINK_WOBBLE_PERIOD_SECONDS) * Math.PI * 2) *
    envelope;

  if (progress >= 1) {
    state.thinkStartedAt = null;
    return state.rotation;
  }
  return state.rotation + wobble * THINK_WOBBLE_DEGREES;
}

function createBezierPath({
  bounds,
  end,
  start,
}: {
  bounds: ViewportSize;
  end: Point;
  start: Point;
}): BezierPath {
  return chooseBestPath(
    createPathCandidates({ bounds, config: PATH_CONFIG, end, start }),
    bounds,
    PATH_CONFIG,
  );
}

function createPathCandidates({
  bounds,
  config,
  end,
  start,
}: {
  bounds: ViewportSize;
  config: typeof PATH_CONFIG;
  end: Point;
  start: Point;
}): BezierPath[] {
  const clickTangent = vectorFromDegrees(config.clickAngleDegrees);
  const distance = pointDistance(start, end);
  const delta = { x: end.x - start.x, y: end.y - start.y };
  const lineTangent = normalizePoint(delta);
  const startHandleDistance = Math.max(
    48,
    Math.min(640, distance * config.startHandle, distance * 0.9),
  );
  const endHandleDistance = Math.max(
    48,
    Math.min(640, distance * config.endpointHandle, distance * 0.9),
  );
  const endTangent = { x: -clickTangent.x, y: -clickTangent.y };
  const startControl = projectWithinBounds(
    bounds,
    start,
    clickTangent,
    startHandleDistance,
  );
  const endControl = projectWithinBounds(
    bounds,
    end,
    endTangent,
    endHandleDistance,
  );
  const lineNormal = { x: -lineTangent.y, y: lineTangent.x };
  const normalDirection =
    lineNormal.x * clickTangent.x + lineNormal.y * clickTangent.y >= 0 ? 1 : -1;
  const naturalArcNormal = {
    x: lineNormal.x * normalDirection,
    y: lineNormal.y * normalDirection,
  };
  const midpoint = midpointBetween(start, end);
  const compactStartControl = projectWithinBounds(
    bounds,
    start,
    clickTangent,
    startHandleDistance * 0.65,
  );
  const compactEndControl = projectWithinBounds(
    bounds,
    end,
    endTangent,
    endHandleDistance * 0.65,
  );
  const arcDistanceBase = Math.max(
    50,
    Math.min(520, distance * config.arcSize),
  );
  const arcHandleDistanceBase = Math.max(
    38,
    Math.min(440, distance * config.arcFlow),
  );
  const arcDistanceScales = [0.55, 0.8, 1.05];
  const arcHandleScales = [0.65, 1, 1.35];
  const candidates = [
    directPath(start, end, startControl, endControl),
    directPath(start, end, compactStartControl, compactEndControl),
  ];

  for (const arcDistanceScale of arcDistanceScales) {
    for (const arcHandleScale of arcHandleScales) {
      pushArcPathPair({
        arcDistanceBase,
        arcDistanceScale,
        arcHandleDistanceBase,
        arcHandleScale,
        arcNormal: naturalArcNormal,
        arcTangent: lineTangent,
        candidates,
        clickTangent,
        end,
        endControl,
        midpoint,
        start,
        startControl,
        startControlDistance: startHandleDistance,
      });
    }
  }

  return candidates.slice(0, config.candidateCount);
}

function pushArcPathPair(options: {
  arcDistanceBase: number;
  arcDistanceScale: number;
  arcHandleDistanceBase: number;
  arcHandleScale: number;
  arcNormal: Point;
  arcTangent: Point;
  candidates: BezierPath[];
  clickTangent: Point;
  end: Point;
  endControl: Point;
  midpoint: Point;
  start: Point;
  startControl: Point;
  startControlDistance: number;
}): void {
  pushArcPath(options);
  pushArcPath({
    ...options,
    arcNormal: {
      x: -options.arcNormal.x,
      y: -options.arcNormal.y,
    },
  });
}

function pushArcPath({
  arcDistanceBase,
  arcDistanceScale,
  arcHandleDistanceBase,
  arcHandleScale,
  arcNormal,
  arcTangent,
  candidates,
  clickTangent,
  end,
  endControl,
  midpoint,
  start,
  startControl,
  startControlDistance,
}: {
  arcDistanceBase: number;
  arcDistanceScale: number;
  arcHandleDistanceBase: number;
  arcHandleScale: number;
  arcNormal: Point;
  arcTangent: Point;
  candidates: BezierPath[];
  clickTangent: Point;
  end: Point;
  endControl: Point;
  midpoint: Point;
  start: Point;
  startControl: Point;
  startControlDistance: number;
}): void {
  const arcDistance = arcDistanceBase * arcDistanceScale;
  const arcHandleDistance = arcHandleDistanceBase * arcHandleScale;
  const arc = {
    x:
      midpoint.x +
      arcNormal.x * arcDistance +
      clickTangent.x * startControlDistance * 0.16,
    y:
      midpoint.y +
      arcNormal.y * arcDistance +
      clickTangent.y * startControlDistance * 0.16,
  };
  const arcIn = {
    x: arc.x - arcTangent.x * arcHandleDistance,
    y: arc.y - arcTangent.y * arcHandleDistance,
  };
  const arcOut = {
    x: arc.x + arcTangent.x * arcHandleDistance,
    y: arc.y + arcTangent.y * arcHandleDistance,
  };

  candidates.push(
    arcPath({
      arc,
      arcIn,
      arcOut,
      end,
      endControl,
      start,
      startControl,
    }),
  );
}

function directPath(
  start: Point,
  end: Point,
  startControl: Point,
  endControl: Point,
): BezierPath {
  return {
    arc: null,
    arcIn: null,
    arcOut: null,
    end,
    endControl,
    segments: [{ control1: startControl, control2: endControl, end }],
    start,
    startControl,
  };
}

function arcPath({
  arc,
  arcIn,
  arcOut,
  end,
  endControl,
  start,
  startControl,
}: {
  arc: Point;
  arcIn: Point;
  arcOut: Point;
  end: Point;
  endControl: Point;
  start: Point;
  startControl: Point;
}): BezierPath {
  return {
    arc,
    arcIn,
    arcOut,
    end,
    endControl,
    segments: [
      { control1: startControl, control2: arcIn, end: arc },
      { control1: arcOut, control2: endControl, end },
    ],
    start,
    startControl,
  };
}

function chooseBestPath(
  candidates: BezierPath[],
  bounds: ViewportSize,
  config: typeof PATH_CONFIG,
): BezierPath {
  const first = candidates[0];
  if (first == null) {
    throw new Error("Cursor motion requires at least one candidate");
  }

  let bestInBounds = first;
  let bestInBoundsScore = Number.POSITIVE_INFINITY;
  let bestOverall = first;
  let bestOverallScore = Number.POSITIVE_INFINITY;

  for (const candidate of candidates) {
    const metrics = pathMetrics(candidate, bounds, config.boundsMargin);
    const score = pathScore(candidate, metrics);
    if (score < bestOverallScore) {
      bestOverall = candidate;
      bestOverallScore = score;
    }
    if (metrics.staysInBounds && score < bestInBoundsScore) {
      bestInBounds = candidate;
      bestInBoundsScore = score;
    }
  }

  return bestInBoundsScore === Number.POSITIVE_INFINITY
    ? bestOverall
    : bestInBounds;
}

function pathMetrics(
  path: BezierPath,
  bounds?: ViewportSize,
  boundsMargin?: number,
): {
  angleChangeEnergy: number;
  length: number;
  maxAngleChange: number;
  staysInBounds: boolean;
  totalTurn: number;
} {
  let length = 0;
  let angleChangeEnergy = 0;
  let maxAngleChange = 0;
  let totalTurn = 0;
  let previousAngle: number | null = null;
  let staysInBounds =
    bounds == null || boundsMargin == null
      ? true
      : pointInBounds(path.start, bounds, boundsMargin);
  let segmentStart = path.start;
  let previousPoint = path.start;

  for (const segment of path.segments) {
    for (let step = 1; step <= 24; step += 1) {
      const t = step / 24;
      const point = cubicPoint(
        segmentStart,
        segment.control1,
        segment.control2,
        segment.end,
        t,
      );
      length += pointDistance(previousPoint, point);
      if (bounds != null && boundsMargin != null) {
        staysInBounds =
          staysInBounds && pointInBounds(point, bounds, boundsMargin);
      }

      const delta = {
        x: point.x - previousPoint.x,
        y: point.y - previousPoint.y,
      };
      if (pointDistance({ x: 0, y: 0 }, delta) > 0.01) {
        const angle = Math.atan2(delta.y, delta.x);
        if (previousAngle != null) {
          const angleChange = radiansDelta(previousAngle, angle);
          angleChangeEnergy += angleChange * angleChange;
          maxAngleChange = Math.max(maxAngleChange, Math.abs(angleChange));
          totalTurn += Math.abs(angleChange);
        }
        previousAngle = angle;
      }
      previousPoint = point;
    }
    segmentStart = segment.end;
  }

  return {
    angleChangeEnergy,
    length,
    maxAngleChange,
    staysInBounds,
    totalTurn,
  };
}

function pathScore(
  path: BezierPath,
  metrics: ReturnType<typeof pathMetrics>,
): number {
  const directDistance = Math.max(1, pointDistance(path.start, path.end));
  const extraLengthRatio = Math.max(0, metrics.length / directDistance - 1);
  const arcPenalty = path.arc == null ? 0 : 45;
  const backwardPenalty = pathBackwardPenalty(path);
  return (
    metrics.length +
    extraLengthRatio * 320 +
    metrics.angleChangeEnergy * 140 +
    metrics.maxAngleChange * 180 +
    metrics.totalTurn * 18 +
    backwardPenalty * 90 +
    arcPenalty
  );
}

function pathSpringOptions(path: BezierPath): SpringOptions {
  const metrics = pathMetrics(path);
  const directDistance = Math.max(1, pointDistance(path.start, path.end));
  const extraLengthRatio = Math.max(0, metrics.length / directDistance - 1);
  const lengthFactor = clamp((metrics.length - 180) / 760, 0, 1);
  const extraLengthFactor = clamp(extraLengthRatio / 0.55, 0, 1);
  const turnFactor = clamp(metrics.totalTurn / (Math.PI * 1.4), 0, 1);
  const turnEnergyFactor = clamp(metrics.angleChangeEnergy / 1.25, 0, 1);
  const complexity = clamp(
    extraLengthFactor * 0.42 + turnFactor * 0.38 + turnEnergyFactor * 0.2,
    0,
    1,
  );
  const backwardPenalty = pathBackwardPenalty(path);
  const arcBonus = path.arc == null ? 0 : 0.04;
  const backwardResponse = backwardPenalty * 0.28;
  const arcScale = path.arc == null ? 1 : 0.9;
  const response = clamp(
    (0.42 +
      lengthFactor * 0.22 +
      complexity * 0.12 +
      backwardResponse +
      arcBonus) *
      0.7 *
      arcScale,
    0.12,
    2.2,
  );
  return { dampingFraction: 0.9, response };
}

function pathBackwardPenalty(path: BezierPath): number {
  const clickTangent = vectorFromDegrees(-44);
  const direction = normalizePoint({
    x: path.end.x - path.start.x,
    y: path.end.y - path.start.y,
  });
  return clamp(
    (-(direction.x * clickTangent.x + direction.y * clickTangent.y) - 0.08) /
      0.92,
    0,
    1,
  );
}

function projectWithinBounds(
  bounds: ViewportSize,
  point: Point,
  direction: Point,
  distance: number,
): Point {
  let projectedDistance = distance;
  if (direction.x < 0) {
    projectedDistance = Math.min(projectedDistance, point.x / -direction.x);
  }
  if (direction.x > 0) {
    projectedDistance = Math.min(
      projectedDistance,
      (bounds.width - point.x) / direction.x,
    );
  }
  if (direction.y < 0) {
    projectedDistance = Math.min(projectedDistance, point.y / -direction.y);
  }
  if (direction.y > 0) {
    projectedDistance = Math.min(
      projectedDistance,
      (bounds.height - point.y) / direction.y,
    );
  }
  return {
    x: point.x + direction.x * Math.max(0, projectedDistance),
    y: point.y + direction.y * Math.max(0, projectedDistance),
  };
}

function sampleBezierPath(
  path: BezierPath,
  progress: number,
): {
  point: Point;
  tangent: Point;
} {
  const clamped = clamp(progress, 0, 1);
  const scaled =
    clamped === 1 ? path.segments.length - 1 : clamped * path.segments.length;
  const segmentIndex = Math.floor(scaled);
  const segment = path.segments[segmentIndex];
  if (segment == null) {
    throw new Error("Cursor motion path has no segment for progress");
  }

  const previousSegment = path.segments[segmentIndex - 1];
  const start = segmentIndex === 0 ? path.start : previousSegment?.end;
  if (start == null) {
    throw new Error("Cursor motion path segment is missing its start point");
  }

  const localProgress = clamped === 1 ? 1 : scaled - segmentIndex;
  return {
    point: cubicPoint(
      start,
      segment.control1,
      segment.control2,
      segment.end,
      localProgress,
    ),
    tangent: cubicTangent(start, segment, localProgress),
  };
}

function cubicPoint(
  start: Point,
  control1: Point,
  control2: Point,
  end: Point,
  progress: number,
): Point {
  const inverse = 1 - progress;
  const startFactor = inverse * inverse * inverse;
  const control1Factor = 3 * inverse * inverse * progress;
  const control2Factor = 3 * inverse * progress * progress;
  const endFactor = progress * progress * progress;
  return {
    x:
      start.x * startFactor +
      control1.x * control1Factor +
      control2.x * control2Factor +
      end.x * endFactor,
    y:
      start.y * startFactor +
      control1.y * control1Factor +
      control2.y * control2Factor +
      end.y * endFactor,
  };
}

function cubicTangent(
  start: Point,
  segment: BezierSegment,
  progress: number,
): Point {
  const inverse = 1 - progress;
  return {
    x:
      3 * inverse * inverse * (segment.control1.x - start.x) +
      6 * inverse * progress * (segment.control2.x - segment.control1.x) +
      3 * progress * progress * (segment.end.x - segment.control2.x),
    y:
      3 * inverse * inverse * (segment.control1.y - start.y) +
      6 * inverse * progress * (segment.control2.y - segment.control1.y) +
      3 * progress * progress * (segment.end.y - segment.control2.y),
  };
}

function midpointBetween(start: Point, end: Point): Point {
  return { x: (start.x + end.x) / 2, y: (start.y + end.y) / 2 };
}

function pointInBounds(
  point: Point,
  bounds: ViewportSize,
  margin: number,
): boolean {
  return (
    point.x >= margin &&
    point.x <= bounds.width - margin &&
    point.y >= margin &&
    point.y <= bounds.height - margin
  );
}

function cursorAngleFromTangent(tangent: Point): number {
  if (pointDistance({ x: 0, y: 0 }, tangent) < 0.001) {
    return BASE_ROTATION;
  }
  const normalized = normalizePoint(tangent);
  return normalizeDegrees(
    Math.atan2(normalized.y, normalized.x) * (180 / Math.PI) + 90,
  );
}

function constrainPoint({
  cursorX,
  cursorY,
  viewportHeight,
  viewportWidth,
}: {
  cursorX?: number;
  cursorY?: number;
  viewportHeight: number;
  viewportWidth: number;
}): Point {
  return {
    x: clamp(
      cursorX ?? Math.round(viewportWidth * FALLBACK_X_RATIO),
      0,
      viewportWidth,
    ),
    y: clamp(
      cursorY ?? Math.round(viewportHeight * FALLBACK_Y_RATIO),
      0,
      viewportHeight,
    ),
  };
}

function stretchFromSpeed(speed: number): number {
  return clamp(1 - speed / 5500, 0.65, 1);
}

function scootStretch(progress: number): number {
  return lerp(
    1,
    lerp(1, MIN_SCOOT_STRETCH, Math.sin(clamp(progress, 0, 1) * Math.PI)),
    SCOOT_STRETCH_BLEND,
  );
}

function scalePositionResponse(response: number): number {
  return clamp(response * 0.18, 0.035, 0.12);
}

function setPositionSpringOptions(
  state: MotionState,
  response: number,
  dampingFraction: number,
): void {
  state.positionXSpring.response = response;
  state.positionYSpring.response = response;
  state.positionXSpring.dampingFraction = dampingFraction;
  state.positionYSpring.dampingFraction = dampingFraction;
}

function advancePosition(
  state: MotionState,
  deltaSeconds: number,
): {
  point: Point;
  speed: number;
} {
  const previousPoint = state.point;
  stepSpring(state.positionXSpring, deltaSeconds);
  stepSpring(state.positionYSpring, deltaSeconds);
  stepSpring(state.rotationSpring, deltaSeconds);
  stepSpring(state.scootAxisSpring, deltaSeconds);
  const point = {
    x: state.positionXSpring.value,
    y: state.positionYSpring.value,
  };
  const speed =
    pointDistance(previousPoint, point) /
    Math.max(deltaSeconds, SPRING_STEP_SECONDS);
  state.point = point;
  state.rotation = state.rotationSpring.value;
  state.scootAxisRotation = state.scootAxisSpring.value;
  return { point, speed };
}

function hasArrivedAt(state: MotionState, point: Point): boolean {
  return (
    pointDistance(state.point, point) <= ARRIVAL_DISTANCE &&
    Math.abs(state.positionXSpring.velocity) <= ARRIVAL_SPEED &&
    Math.abs(state.positionYSpring.velocity) <= ARRIVAL_SPEED
  );
}

function snapTo(state: MotionState, point: Point): void {
  state.motion = null;
  snapPosition(state, point);
  resetSpring(state.rotationSpring, BASE_ROTATION);
  state.rotation = state.rotationSpring.value;
  resetScoot(state);
  resetSpring(state.stretchSpring, 1);
}

function resetActiveStretch(state: MotionState): void {
  state.stretchSpring.force = 0;
  state.stretchSpring.value = 1;
  state.stretchSpring.velocity = 0;
}

function snapPosition(state: MotionState, point: Point): void {
  state.point = point;
  resetSpring(state.positionXSpring, point.x);
  resetSpring(state.positionYSpring, point.y);
}

function resetScoot(state: MotionState): void {
  resetSpring(state.scootAxisSpring, 0);
  resetSpring(state.scootRotationSpring, 0);
  resetSpring(state.scootStretchSpring, 1);
  state.scootAxisRotation = 0;
}

function setAngleTarget(spring: Spring, target: number): void {
  spring.target = spring.value + shortAngleDelta(spring.value, target);
}

function shortAngleDelta(from: number, to: number): number {
  let delta = to - from;
  while (delta > 180) {
    delta -= 360;
  }
  while (delta < -180) {
    delta += 360;
  }
  return delta;
}

function createSpring(
  value: number,
  target: number,
  options: SpringOptions,
): Spring {
  return {
    dampingFraction: options.dampingFraction,
    force: 0,
    response: options.response,
    simulationTime: 0,
    scriptTime: 0,
    target,
    value,
    velocity: 0,
  };
}

function resetSpring(spring: Spring, value: number): void {
  spring.force = 0;
  spring.simulationTime = 0;
  spring.scriptTime = 0;
  spring.target = value;
  spring.value = value;
  spring.velocity = 0;
}

function stepSpring(spring: Spring, deltaSeconds: number): void {
  const response = Math.max(0.001, spring.response);
  const maxStiffness = 1 / (2 * SPRING_STEP_SECONDS ** 2);
  const stiffness = Math.min((Math.PI * 2) ** 2 / response ** 2, maxStiffness);
  const damping = Math.sqrt(stiffness) * 2 * spring.dampingFraction;
  spring.scriptTime += Math.max(0, deltaSeconds);
  if (spring.scriptTime - spring.simulationTime > MAX_SIMULATION_LAG_SECONDS) {
    spring.simulationTime = spring.scriptTime - FRAME_SECONDS;
  }

  while (spring.simulationTime < spring.scriptTime) {
    integrateSpring(spring, stiffness, damping);
    spring.simulationTime += SPRING_STEP_SECONDS;
  }

  if (isSpringSettled(spring)) {
    spring.value = spring.target;
  }
}

function integrateSpring(
  spring: Spring,
  stiffness: number,
  damping: number,
): void {
  const halfStep = SPRING_STEP_SECONDS / 2;
  const velocityAtHalfStep = spring.velocity + spring.force * halfStep;
  spring.value += velocityAtHalfStep * SPRING_STEP_SECONDS;
  spring.force =
    velocityAtHalfStep * -damping + (spring.target - spring.value) * stiffness;
  spring.velocity = velocityAtHalfStep + spring.force * halfStep;
}

function isSpringResting(spring: Spring): boolean {
  return spring.value === spring.target && isSpringSettled(spring);
}

function isSpringSettled(spring: Spring): boolean {
  if (
    Math.max(spring.velocity * spring.velocity, spring.force * spring.force) >
    SPRING_SETTLE_EPSILON * SPRING_SETTLE_EPSILON
  ) {
    return false;
  }
  const tolerance = spring.target * 0.01;
  const delta = spring.target - spring.value;
  return tolerance === 0 || delta * delta <= tolerance * tolerance;
}

function lineProgress(point: Point, start: Point, end: Point): number {
  const line = { x: end.x - start.x, y: end.y - start.y };
  const lengthSquared = line.x * line.x + line.y * line.y;
  if (lengthSquared < 0.001) {
    return 1;
  }
  return clamp(
    ((point.x - start.x) * line.x + (point.y - start.y) * line.y) /
      lengthSquared,
    0,
    1,
  );
}

function vectorFromDegrees(degrees: number): Point {
  const radians = degrees * (Math.PI / 180);
  return { x: Math.sin(radians), y: -Math.cos(radians) };
}

function vectorAngle(vector: Point): number {
  return pointDistance({ x: 0, y: 0 }, vector) < 0.001
    ? 0
    : Math.atan2(vector.y, vector.x) * (180 / Math.PI);
}

function normalizePoint(point: Point): Point {
  const length = Math.sqrt(point.x * point.x + point.y * point.y);
  return length < 0.001
    ? { x: 1, y: 0 }
    : { x: point.x / length, y: point.y / length };
}

function pointDistance(start: Point, end: Point): number {
  const x = end.x - start.x;
  const y = end.y - start.y;
  return Math.sqrt(x * x + y * y);
}

function radiansDelta(from: number, to: number): number {
  let delta = to - from;
  while (delta > Math.PI) {
    delta -= Math.PI * 2;
  }
  while (delta < -Math.PI) {
    delta += Math.PI * 2;
  }
  return delta;
}

function normalizeDegrees(degrees: number): number {
  const normalized = degrees % 360;
  return normalized < 0 ? normalized + 360 : normalized;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function lerp(start: number, end: number, progress: number): number {
  return start + (end - start) * progress;
}

function roundCss(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function now(): number {
  return typeof performance === "undefined" ? Date.now() : performance.now();
}

function requestFrame(callback: FrameRequestCallback): number {
  if (typeof window !== "undefined" && window.requestAnimationFrame != null) {
    return window.requestAnimationFrame(callback);
  }
  if (typeof window !== "undefined") {
    return window.setTimeout(() => callback(now()), FRAME_SECONDS * 1000);
  }
  callback(now());
  return 0;
}

function cancelFrame(frameId: number): void {
  if (typeof window !== "undefined" && window.cancelAnimationFrame != null) {
    window.cancelAnimationFrame(frameId);
    return;
  }
  if (typeof window !== "undefined") {
    window.clearTimeout(frameId);
  }
}
