"""Mouse trajectory generation for the guest supervisor.

This module turns a pair of coordinates into a human-looking stream of
pointer samples that the supervisor can replay over XTest.  It is deliberately
dependency-free (stdlib only) so it can be imported anywhere in the guest.

Design goals
------------
* **Visual collaboration quality.**  Natural mode produces smooth, curved,
  minimum-jerk movements so a human watching a shared screen sees the pointer
  behave like a person moving a mouse.  That is the *only* reason this module
  exists: it is not, and must not be presented as, a detection-evasion or
  bot-masking tool.  Precise mode is provided for the common case where the
  extra motion is unnecessary overhead.
* **Reproducibility.**  Every stochastic choice flows through a caller-supplied
  ``random.Random`` instance, so a recorded trajectory can be replayed exactly.

The movement model is a cubic Bezier curve whose two control points are pushed
perpendicular to the travel direction by a random amount bounded by a
configurable curvature parameter.  Progress along that curve is then shaped by
the minimum-jerk easing polynomial ``10t^3 - 15t^4 + 6t^5``, which starts and
ends with zero velocity and zero acceleration.
"""

from __future__ import annotations

import math
import random
from typing import List, Optional, Sequence, Tuple

__all__ = [
    "Point",
    "Sample",
    "DEFAULT_CURVATURE",
    "MIN_DURATION_MS",
    "MAX_DURATION_MS",
    "SAMPLE_HZ",
    "bezier_path",
    "minimum_jerk",
    "estimate_duration_ms",
    "plan_move",
    "plan_drag",
]

# A point on screen.
Point = Tuple[float, float]

# A replayed pointer sample: (timestamp_ms, x, y).
Sample = Tuple[int, float, float]

#: Maximum perpendicular displacement of a Bezier control point, expressed as a
#: fraction of the straight-line distance between start and end.
DEFAULT_CURVATURE = 0.18

#: Hard bounds (milliseconds) for an auto-scaled natural move.
MIN_DURATION_MS = 150
MAX_DURATION_MS = 1500

#: Natural-mode sampling rate, in samples per second (~120 Hz).
SAMPLE_HZ = 120.0

# Fitts-law-style constants for automatic duration scaling: MT = A + B *
# log2(D / W + 1), where D is travel distance in pixels and W is an assumed
# target width.  Tuned so typical desktop moves land comfortably inside the
# MIN/MAX clamp above.
_FITTS_A_MS = 80.0
_FITTS_B_MS = 120.0
_TARGET_WIDTH_PX = 32.0


def _distance(a: Point, b: Point) -> float:
    """Euclidean distance between two 2-D points."""
    return math.hypot(b[0] - a[0], b[1] - a[1])


def _clamp(value: float, low: float, high: float) -> float:
    return low if value < low else high if value > high else value


def minimum_jerk(t: float) -> float:
    """Return the minimum-jerk easing value for ``t`` in ``[0, 1]``.

    The polynomial ``10t^3 - 15t^4 + 6t^5`` has zero velocity and zero
    acceleration at both endpoints, giving smooth, natural-looking motion.
    ``t`` is clamped to the unit interval so callers may pass raw progress
    without pre-validating it.
    """
    t = _clamp(t, 0.0, 1.0)
    return t * t * t * (10.0 + t * (-15.0 + 6.0 * t))


def _bezier(
    p0: Point, c1: Point, c2: Point, p1: Point, u: float
) -> Point:
    """Evaluate a cubic Bezier curve at parameter ``u`` in ``[0, 1]``."""
    u = _clamp(u, 0.0, 1.0)
    v = 1.0 - u
    v2 = v * v
    v3 = v2 * v
    u2 = u * u
    u3 = u2 * u
    x = v3 * p0[0] + 3.0 * v2 * u * c1[0] + 3.0 * v * u2 * c2[0] + u3 * p1[0]
    y = v3 * p0[1] + 3.0 * v2 * u * c1[1] + 3.0 * v * u2 * c2[1] + u3 * p1[1]
    return x, y


def bezier_path(
    start: Point,
    end: Point,
    curvature: float = DEFAULT_CURVATURE,
    screen: Sequence[float] = (1280, 800),
    rng: Optional[random.Random] = None,
) -> Tuple[Point, Point, Point, Point]:
    """Build a cubic Bezier control polygon from ``start`` to ``end``.

    The two interior control points sit one third and two thirds of the way
    along the travel direction, then are displaced perpendicular to that
    direction.  Each displacement magnitude is drawn uniformly from
    ``[-curvature, curvature]`` (as a fraction of the travel distance), which
    bounds how far the curve may bow away from the straight line.

    Args:
        start: (x, y) origin of the move.
        end: (x, y) destination of the move.
        curvature: Maximum perpendicular offset, as a fraction of the distance
            between ``start`` and ``end``.  ``0.0`` yields a straight line.
        screen: ``(width, height)`` used to keep control points on-screen.
        rng: Optional ``random.Random`` for reproducible curvature.

    Returns:
        ``(start, control1, control2, end)``.  For a zero-length move the
        control points collapse onto the start point, yielding a degenerate
        (straight) curve.
    """
    rng = rng if rng is not None else random
    x0, y0 = float(start[0]), float(start[1])
    x1, y1 = float(end[0]), float(end[1])
    dx = x1 - x0
    dy = y1 - y0
    dist = math.hypot(dx, dy)

    if dist <= 0.0:
        return (x0, y0), (x0, y0), (x0, y0), (x1, y1)

    # Unit travel direction and its perpendicular.
    ux, uy = dx / dist, dy / dist
    px, py = -uy, ux

    width = float(screen[0])
    height = float(screen[1])

    def _control(fraction: float, offset: float) -> Point:
        base_x = x0 + dx * fraction
        base_y = y0 + dy * fraction
        cx = base_x + px * offset
        cy = base_y + py * offset
        # Keep the control polygon on-screen so the curve never leaves the
        # visible area.  This does not move the start/end points themselves.
        cx = _clamp(cx, 0.0, max(0.0, width - 1.0))
        cy = _clamp(cy, 0.0, max(0.0, height - 1.0))
        return cx, cy

    bound = abs(curvature) * dist
    off1 = rng.uniform(-bound, bound) if bound > 0.0 else 0.0
    off2 = rng.uniform(-bound, bound) if bound > 0.0 else 0.0

    control1 = _control(1.0 / 3.0, off1)
    control2 = _control(2.0 / 3.0, off2)
    return (x0, y0), control1, control2, (x1, y1)


def estimate_duration_ms(start: Point, end: Point) -> int:
    """Estimate a natural move duration using a Fitts-law-style formula.

    ``MT = A + B * log2(D / W + 1)`` where ``D`` is the travel distance and
    ``W`` an assumed target width.  The result is clamped to
    ``[MIN_DURATION_MS, MAX_DURATION_MS]``.
    """
    dist = _distance(start, end)
    mt = _FITTS_A_MS + _FITTS_B_MS * math.log2(dist / _TARGET_WIDTH_PX + 1.0)
    return int(round(_clamp(mt, MIN_DURATION_MS, MAX_DURATION_MS)))


def plan_move(
    start: Point,
    end: Point,
    duration_ms: Optional[float] = None,
    mode: str = "natural",
    screen: Sequence[float] = (1280, 800),
    rng: Optional[random.Random] = None,
    curvature: float = DEFAULT_CURVATURE,
) -> List[Sample]:
    """Plan a pointer move from ``start`` to ``end``.

    Natural mode is intended to make the cursor look like it was moved by a
    person so that a human collaborator watching a shared screen finds the
    motion legible and predictable.  It is **not** a detection-evasion or
    bot-masking mechanism; it only adds visual polish and should be chosen on
    collaboration-quality grounds alone.

    Args:
        start: (x, y) origin.
        end: (x, y) destination.
        duration_ms: Move duration in milliseconds.  Ignored in ``"precise"``
            mode.  In ``"natural"`` mode, ``None`` triggers automatic
            distance-based scaling (clamped to 150-1500 ms).
        mode: ``"natural"`` for a curved, minimum-jerk path sampled at
            ~120 Hz, or ``"precise"`` for a direct start/end teleport.
        screen: ``(width, height)`` used to keep natural control points
            on-screen.
        rng: Optional ``random.Random`` for reproducible trajectories.
        curvature: Maximum Bezier bow as a fraction of travel distance.

    Returns:
        A list of ``(timestamp_ms, x, y)`` samples.  The first sample is the
        start point at ``t=0`` and the final sample is *exactly* ``end`` at
        ``t=duration_ms``; timestamps are non-decreasing.  ``"precise"`` mode
        returns only the start and end samples.
    """
    x0, y0 = float(start[0]), float(start[1])
    x1, y1 = float(end[0]), float(end[1])

    if mode == "precise":
        ts = 0 if duration_ms is None else int(round(duration_ms))
        return [(0, x0, y0), (ts, x1, y1)]

    if mode != "natural":
        raise ValueError(
            "mode must be 'natural' or 'precise', got {!r}".format(mode)
        )

    if duration_ms is None:
        duration = float(estimate_duration_ms((x0, y0), (x1, y1)))
    else:
        duration = float(duration_ms)
    duration = max(0.0, duration)

    p0, c1, c2, p1 = bezier_path(
        (x0, y0), (x1, y1), curvature=curvature, screen=screen, rng=rng
    )

    # Number of samples so the step is as close to 1/SAMPLE_HZ seconds as
    # possible, with at least a start and an end sample.
    intervals = max(1, int(round(duration * SAMPLE_HZ / 1000.0)))
    count = intervals + 1
    step = duration / intervals if intervals > 0 else 0.0

    samples: List[Sample] = []
    for i in range(count):
        if i == 0:
            x, y = x0, y0
        elif i == count - 1:
            x, y = x1, y1
        else:
            t = i * step / duration if duration > 0.0 else 0.0
            x, y = _bezier(p0, c1, c2, p1, minimum_jerk(t))
        ts = int(round(i * step))
        samples.append((ts, x, y))

    # Guarantee the terminal contract regardless of rounding: the last sample
    # lands exactly on the target at the requested timestamp.
    if duration > 0.0:
        samples[-1] = (int(round(duration)), x1, y1)
    else:
        samples[-1] = (0, x1, y1)
    return samples


def plan_drag(
    start: Point,
    end: Point,
    duration_ms: Optional[float] = None,
    mode: str = "natural",
    screen: Sequence[float] = (1280, 800),
    rng: Optional[random.Random] = None,
    curvature: float = DEFAULT_CURVATURE,
) -> List[Sample]:
    """Plan a pointer drag (move with a button held) from ``start`` to ``end``.

    The guest supervisor calls this while a mouse button is depressed.  The
    motion generator is identical to :func:`plan_move`; the only difference is
    semantic (the caller is responsible for pressing/releasing the button
    around the replayed samples), so the returned trajectory has the same
    contract.  The natural-mode rationale is the same as :func:`plan_move`:
    it improves visual collaboration quality, not detection evasion.

    See :func:`plan_move` for full argument and return documentation.
    """
    return plan_move(
        start,
        end,
        duration_ms=duration_ms,
        mode=mode,
        screen=screen,
        rng=rng,
        curvature=curvature,
    )


def _self_test() -> None:
    """Assert the trajectory contract and print ``PASS``."""
    rng = random.Random(1234)

    # precise mode: exactly two points, endpoints preserved.
    precise = plan_move((10, 20), (300, 400), mode="precise", rng=rng)
    assert len(precise) == 2, "precise mode must return start and end only"
    assert precise[0][1:] == (10, 20)
    assert precise[1][1:] == (300, 400)
    assert precise[0][0] == 0

    # natural mode: endpoints exact, timestamps monotonic, sane sample count.
    natural = plan_move(
        (100, 100), (900, 700), duration_ms=500, mode="natural", rng=rng
    )
    assert natural[0] == (0, 100.0, 100.0), natural[0]
    assert natural[-1][1:] == (900.0, 700.0), natural[-1]
    assert natural[-1][0] == 500, natural[-1]
    for a, b in zip(natural, natural[1:]):
        assert b[0] >= a[0], "timestamps must be monotonic"

    # ~120 Hz over 500 ms => ~60 intervals => ~61 samples.
    expected = int(round(500 * SAMPLE_HZ / 1000.0)) + 1
    assert len(natural) == expected, (len(natural), expected)

    # auto duration clamps into range and still ends exactly on target.
    for _ in range(50):
        sx = rng.uniform(0, 1280)
        sy = rng.uniform(0, 800)
        ex = rng.uniform(0, 1280)
        ey = rng.uniform(0, 800)
        pts = plan_move((sx, sy), (ex, ey), mode="natural", rng=rng)
        assert pts[0][1:] == (sx, sy)
        assert pts[-1][1:] == (ex, ey)
        assert MIN_DURATION_MS <= pts[-1][0] <= MAX_DURATION_MS
        assert len(pts) >= 2
        for a, b in zip(pts, pts[1:]):
            assert b[0] >= a[0]

    # reproducibility with a seeded generator.
    a = plan_move((0, 0), (640, 400), rng=random.Random(7))
    b = plan_move((0, 0), (640, 400), rng=random.Random(7))
    assert a == b, "seeded trajectories must be reproducible"

    # minimum-jerk boundary values.
    assert minimum_jerk(0.0) == 0.0
    assert minimum_jerk(1.0) == 1.0

    # plan_drag shares the generator and contract.
    drag = plan_drag((1, 2), (3, 4), duration_ms=300, mode="natural", rng=rng)
    assert drag[0][1:] == (1.0, 2.0)
    assert drag[-1][1:] == (3.0, 4.0)

    print("PASS")


if __name__ == "__main__":
    _self_test()
