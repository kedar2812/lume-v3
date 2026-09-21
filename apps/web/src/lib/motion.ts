/**
 * LUME motion tokens (spec §5). Apple's two designer-friendly spring parameters:
 * bounce (1 − damping ratio) and response (seconds to reach the target). Everything that moves uses these.
 */
export type SpringSpec = { bounce: number; response: number };

export const SPRINGS = {
  default: { bounce: 0, response: 0.38 },
  soft: { bounce: 0, response: 0.7 },
  bounce: { bounce: 0.3, response: 0.42 },
  drawer: { bounce: 0.2, response: 0.3 },
} as const satisfies Record<string, SpringSpec>;

/** Normalised spring position (0 → 1) at time t seconds, starting at rest. */
export function springAt({ bounce, response }: SpringSpec, t: number): number {
  const zeta = 1 - bounce;
  const w = (2 * Math.PI) / response;
  if (zeta >= 1) return 1 - Math.exp(-w * t) * (1 + w * t);
  const wd = w * Math.sqrt(1 - zeta * zeta);
  return 1 - Math.exp(-zeta * w * t) * (Math.cos(wd * t) + ((zeta * w) / wd) * Math.sin(wd * t));
}

/** Time (s) after which the spring is visually settled; used as the CSS/WAAPI duration. */
export const settleTime = (s: SpringSpec): number => s.response * 2.2;

export function toLinearEasing(spec: SpringSpec, samples = 60): string {
  const T = settleTime(spec);
  const pts = Array.from({ length: samples + 1 }, (_, i) =>
    i === samples ? 1 : +springAt(spec, (T * i) / samples).toFixed(4),
  );
  return `linear(${pts.join(", ")})`;
}

export const toMotion = (s: SpringSpec) => ({
  type: "spring" as const,
  bounce: s.bounce,
  visualDuration: s.response,
});

export function springCssVars() {
  return {
    "--spring": toLinearEasing(SPRINGS.default),
    "--spring-soft": toLinearEasing(SPRINGS.soft),
    "--spring-bounce": toLinearEasing(SPRINGS.bounce),
    "--spring-drawer": toLinearEasing(SPRINGS.drawer),
  };
}

/** Where a flick ends up (Apple's Designing Fluid Interfaces). Velocity in px/s → distance in px. */
export function project(velocity: number, decelerationRate = 0.998): number {
  return ((velocity / 1000) * decelerationRate) / (1 - decelerationRate);
}

/** Progressive resistance past a boundary; approaches but never reaches `dimension`. */
export function rubberband(overshoot: number, dimension: number, constant = 0.55): number {
  const x = Math.abs(overshoot);
  return (Math.sign(overshoot) * (x * dimension * constant)) / (dimension + constant * x);
}
