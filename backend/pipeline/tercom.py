from __future__ import annotations

"""TERCOM guidance simulator — runs server-side on a real DEM.

Models a cruise weapon flying launch→target with:
  • INS drift  — the nav estimate diverges from truth over distance.
  • TERCOM fix — at fix strips, a radar-altimeter profile (truth + noise) is
    correlated against the stored DEM over a search window; the best match
    corrects the nav estimate. Over FLAT/ambiguous terrain the correlation is
    weak → bad fix → drift persists. (This is the real failure source.)
  • Terrain following — commanded altitude tracks the *believed* ground; if the
    estimate is wrong it can fly into a hill it didn't know was there → CFIT.

Outcomes: HIT · MISS (outside CEP) · CFIT (flew into terrain) · LOST (nav gone).
Failure is intrinsic to the terrain + settings, not injected noise — so tuning
(more fixes, feature-rich routes, higher DEM res) genuinely improves hit rate.
"""

import numpy as np


def _bilinear(elev, x, y):
    h, w = elev.shape
    x = min(max(x, 0.0), w - 1.001)
    y = min(max(y, 0.0), h - 1.001)
    x0, y0 = int(x), int(y)
    fx, fy = x - x0, y - y0
    a = elev[y0, x0]; b = elev[y0, x0 + 1]
    c = elev[y0 + 1, x0]; d = elev[y0 + 1, x0 + 1]
    return a * (1 - fx) * (1 - fy) + b * fx * (1 - fy) + c * (1 - fx) * fy + d * fx * fy


def simulate_tercom(elev_m, cell_m, launch, target, params=None):
    """launch/target = (gx, gy) grid coords (gx=col, gy=row). Returns a result
    dict with normalised trajectory points + fixes + verdict."""
    p = params or {}
    rng = np.random.default_rng(int(p.get("seed", 7)))
    agl = float(p.get("cruise_agl_m", 320.0))
    fix_count = int(p.get("fix_count", 5))
    drift_km = float(p.get("drift_per_km_m", 55.0))   # INS error growth, m / km
    alt_noise = float(p.get("alt_noise_m", 6.0))
    min_clear = float(p.get("min_clearance_m", 12.0))
    search = int(p.get("search_cells", 10))
    strip = int(p.get("strip_cells", 18))
    look = int(p.get("lookahead_cells", 8))

    h, w = elev_m.shape
    size = h
    cep_m = float(p.get("cep_m", cell_m * 6))

    lx, ly = float(launch[0]), float(launch[1])
    tx, ty = float(target[0]), float(target[1])
    truth = np.array([lx, ly], dtype=float)
    est = np.array([lx, ly], dtype=float)

    total = float(np.hypot(tx - lx, ty - ly))
    nsteps = max(2, int(total) + 1)
    fix_at = set()
    if fix_count > 0:
        for k in range(fix_count):
            fix_at.add(int(nsteps * (k + 1) / (fix_count + 1)))

    def nrm(pt):
        # grid (gx=col, gy=row) → render fractions: X←row, Z←col, each [-0.5,0.5]
        return {"nx": pt[1] / (size - 1) - 0.5, "nz": pt[0] / (size - 1) - 0.5}

    truth_hist, est_hist = [], []
    traj, fixes = [], []
    verdict = "HIT"
    keep = max(1, nsteps // 130)

    def record(s, cmd_alt, g_truth, clearance, err_m):
        pt = nrm(truth)
        traj.append({
            "t": s, "nx": round(pt["nx"], 5), "nz": round(pt["nz"], 5),
            "alt_m": round(float(cmd_alt), 1), "gnd_m": round(float(g_truth), 1),
            "clear_m": round(float(clearance), 1), "err_m": round(float(err_m), 1),
        })

    for s in range(nsteps):
        dirx, diry = tx - est[0], ty - est[1]
        dd = float(np.hypot(dirx, diry))
        if dd < 1.0:
            break
        ux, uy = dirx / dd, diry / dd

        truth += [ux, uy]
        dkm = cell_m / 1000.0
        drift = rng.normal(0.0, drift_km * np.sqrt(dkm), 2) / cell_m  # cells
        est += [ux + drift[0], uy + drift[1]]
        truth_hist.append(truth.copy())
        est_hist.append(est.copy())

        g_truth = _bilinear(elev_m, truth[0], truth[1])
        # Terrain-following: climb to clear the highest BELIEVED ground over a
        # short look-ahead, so it rises before hills it knows about. CFIT then
        # happens only when the nav estimate is wrong (believed-flat, truly-high).
        g_ahead = _bilinear(elev_m, est[0], est[1])
        for la in range(1, look + 1):
            g_ahead = max(g_ahead, _bilinear(elev_m, est[0] + ux * la, est[1] + uy * la))
        cmd_alt = g_ahead + agl
        clearance = cmd_alt - g_truth
        err_m = float(np.hypot(est[0] - truth[0], est[1] - truth[1]) * cell_m)

        if clearance < min_clear:
            verdict = "CFIT"
            record(s, cmd_alt, g_truth, clearance, err_m)
            break
        if err_m > 0.3 * size * cell_m:
            verdict = "LOST"
            record(s, cmd_alt, g_truth, clearance, err_m)
            break

        if s in fix_at and len(truth_hist) > strip:
            seg_t = truth_hist[-strip:]
            seg_e = est_hist[-strip:]
            measured = np.array([_bilinear(elev_m, q[0], q[1]) for q in seg_t])
            measured = measured + rng.normal(0.0, alt_noise, len(measured))
            best, best_cost = (0, 0), 1e18
            for di in range(-search, search + 1):
                for dj in range(-search, search + 1):
                    ref = np.array([_bilinear(elev_m, q[0] + di, q[1] + dj) for q in seg_e])
                    cost = float(np.sum((measured - ref) ** 2))
                    if cost < best_cost:
                        best_cost = cost; best = (di, dj)
            est += [best[0], best[1]]
            resid = float(np.hypot(est[0] - truth[0], est[1] - truth[1]) * cell_m)
            fixes.append({
                "t": s, "offset_cells": [best[0], best[1]],
                "residual_m": round(resid, 1),
                "terrain_std_m": round(float(np.std(measured)), 1),
            })

        if s % keep == 0:
            record(s, cmd_alt, g_truth, clearance, err_m)

    miss_m = float(np.hypot(truth[0] - tx, truth[1] - ty) * cell_m)
    if verdict == "HIT" and miss_m > cep_m:
        verdict = "MISS"

    return {
        "verdict": verdict,
        "miss_m": round(miss_m, 1),
        "cep_m": round(cep_m, 1),
        "steps": nsteps,
        "trajectory": traj,
        "fixes": fixes,
        "launch": nrm(np.array([lx, ly])),
        "target": nrm(np.array([tx, ty])),
        "params": {
            "cruise_agl_m": agl, "fix_count": fix_count,
            "drift_per_km_m": drift_km, "cep_m": round(cep_m, 1),
        },
    }
