/**
 * Flying gripper pad geometry.
 *
 * Every length is a ratio of the 9:16 scene width (W) so the pad scales with
 * the video. Ratios are lifted from the Figma mockup (node 2801:4803, scene
 * width 377px). `FlyingGripperPad.tsx` injects them as `--r-*` custom
 * properties so `FlyingGripperPad.css` and the SVG outlines built here share
 * one source of truth.
 */

export const FGPAD_RATIOS = {
    /** outer ring diameter */
    ring: 0.72,
    /** ring bottom edge above the scene bottom */
    ringLift: 0.17,
    /** bottom row (panels, Close) above the scene bottom */
    rowBottom: 0.032,
    panelW: 0.345,
    panelH: 0.371,
    /** panel inset from the scene's side edge */
    panelInset: 0.029,
    /** outer corner radius of a panel (Figma: 8px @ 377) */
    panelCorner: 8 / 377,
    /** fillet radius where the bite arc meets a straight panel edge */
    panelFillet: 0.03,
    closeW: 0.215,
    closeH: 0.127,
    /** clearance between the ring's outer edge and the carved row */
    biteGap: 0.022,
} as const;

/** CSS custom properties (`--r-*`) mirroring {@link FGPAD_RATIOS}. */
export const fgpadRatioVars = (): Record<string, number> =>
    Object.fromEntries(
        Object.entries(FGPAD_RATIOS).map(([key, value]) => [
            `--r-${key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`,
            value,
        ]),
    );

type Point = readonly [number, number];

/**
 * SVG user units per W. Paths are emitted at this scale (rather than raw W
 * ratios) so a user unit is roughly a CSS pixel at phone widths; CSS `filter`
 * lengths on SVG elements resolve in user units, and a 0-1 viewBox would blow a
 * 6px blur up by ~500x.
 */
export const PATH_SCALE = 1000;

const fmt = (n: number) => (n * PATH_SCALE).toFixed(3);
const pt = ([x, y]: Point) => `${fmt(x)},${fmt(y)}`;

/** `viewBox` matching {@link leftPanelOutlinePath} for the panel box. */
export const panelViewBox = (r = FGPAD_RATIOS): string =>
    `0 0 ${fmt(r.panelW)} ${fmt(r.panelH)}`;

/**
 * Center of the fillet circle (radius rf) tangent to a straight edge and
 * externally tangent to the bite circle (center b, radius R).
 *
 * `axis` is the coordinate fixed by the edge tangency: for a horizontal edge at
 * y = 0 the center is at y = rf; for a vertical edge at x = pw it is x = pw - rf.
 * The other coordinate follows from |F - B| = R + rf. `dir` picks which of the
 * two solutions lies on the panel's material side.
 */
const filletCenter = (
    b: Point,
    R: number,
    rf: number,
    fixed: { axis: "x" | "y"; value: number },
    dir: 1 | -1,
): Point => {
    const [bx, by] = b;
    const reach = R + rf;
    if (fixed.axis === "y") {
        const dy = fixed.value - by;
        return [bx + dir * Math.sqrt(reach ** 2 - dy ** 2), fixed.value];
    }
    const dx = fixed.value - bx;
    return [fixed.value, by + dir * Math.sqrt(reach ** 2 - dx ** 2)];
};

/** Point on the bite circle where the fillet circle touches it. */
const biteTangent = (b: Point, f: Point, R: number, rf: number): Point => {
    const k = R / (R + rf);
    return [b[0] + (f[0] - b[0]) * k, b[1] + (f[1] - b[1]) * k];
};

/**
 * SVG path (W units, panel-local, origin at the panel's top-left) for the LEFT
 * side panel: a rounded rect with the ring+gap circle bitten out of its
 * top-right corner, with fillets where the bite meets the top and right edges.
 * The right panel is this shape mirrored (`scaleX(-1)`).
 */
export const leftPanelOutlinePath = (r = FGPAD_RATIOS): string => {
    const pw = r.panelW;
    const ph = r.panelH;
    const rc = r.panelCorner;
    const rf = r.panelFillet;
    const R = r.ring / 2 + r.biteGap;

    // Bite (ring) center in panel-local coordinates
    const ringCyUp = r.ringLift + r.ring / 2;
    const b: Point = [0.5 - r.panelInset, r.rowBottom + ph - ringCyUp];

    // Top-edge fillet (edge y = 0) sits left of the bite center
    const f1 = filletCenter(b, R, rf, { axis: "y", value: rf }, -1);
    const t1: Point = [f1[0], 0];
    const p1 = biteTangent(b, f1, R, rf);

    // Right-edge fillet (edge x = pw) sits below the bite center
    const f2 = filletCenter(b, R, rf, { axis: "x", value: pw - rf }, 1);
    const t2: Point = [pw, f2[1]];
    const p2 = biteTangent(b, f2, R, rf);

    const arc = (radius: number, sweep: 0 | 1, to: Point) =>
        `A${fmt(radius)},${fmt(radius)} 0 0 ${sweep} ${pt(to)}`;

    return [
        `M${pt([rc, 0])}`,
        `L${pt(t1)}`,
        arc(rf, 1, p1),
        // concave bite: travel the short way around the ring center
        arc(R, 0, p2),
        arc(rf, 1, t2),
        `L${pt([pw, ph - rc])}`,
        arc(rc, 1, [pw - rc, ph]),
        `L${pt([rc, ph])}`,
        arc(rc, 1, [0, ph - rc]),
        `L${pt([0, rc])}`,
        arc(rc, 1, [rc, 0]),
        "Z",
    ].join(" ");
};
