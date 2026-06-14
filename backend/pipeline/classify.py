from __future__ import annotations

"""Lightweight heuristic classifier for uploaded images.

Two jobs:
  1. Is this a *terrain* image at all (vs a selfie / logo / screenshot)?
  2. If terrain, which body — Moon (grey regolith), Mars (reddish), or unknown?

No ML model — just colour/texture statistics. Deliberately permissive about
*accepting* terrain (the product must not reject real DEMs/surface imagery)
and conservative about *rejecting* (only clearly non-terrain content)."""

from io import BytesIO

import cv2
import numpy as np
from PIL import Image, UnidentifiedImageError


def _stats(image: Image.Image) -> dict:
    rgb = image.convert("RGB").resize((160, 160))
    arr = np.asarray(rgb, dtype=np.float32) / 255.0
    r, g, b = arr[..., 0], arr[..., 1], arr[..., 2]
    mx = arr.max(axis=2)
    mn = arr.min(axis=2)
    sat = np.where(mx > 1e-5, (mx - mn) / (mx + 1e-5), 0.0)
    grey = arr.mean(axis=2)

    g8 = (grey * 255.0).astype(np.uint8)
    detail = float(cv2.Laplacian(g8, cv2.CV_64F).var())  # texture energy

    return {
        "mean_sat": float(sat.mean()),
        "contrast": float(grey.std()),
        "detail": detail,
        "red_tilt": float(r.mean() - (g.mean() + b.mean()) / 2.0),
        "blue_tilt": float(b.mean() - (r.mean() + g.mean()) / 2.0),
        "mean_lum": float(grey.mean()),
    }


def classify_terrain_image(content: bytes) -> dict:
    """Return {ok, is_terrain, is_moon, body, reason, scores}. Never raises on a
    decodable image; raises ValueError only when the bytes are not an image."""
    try:
        image = Image.open(BytesIO(content))
        image.load()
    except (UnidentifiedImageError, OSError) as exc:
        raise ValueError(f"Cannot decode image: {exc}") from exc

    s = _stats(image)

    # ── Is it terrain? ──
    # Terrain/DEM imagery: textured, not cartoon-vivid, not a flat block.
    reasons = []
    is_terrain = True
    # Vivid graphics/cartoons/logos — not regolith or rock.
    if s["mean_sat"] > 0.6:
        is_terrain = False
        reasons.append("too colourful for terrain/regolith")
    # Featureless block (blank/logo) — reject only when BOTH global relief AND
    # local detail are absent, so genuine low-contrast DEMs still pass.
    if s["contrast"] < 0.02 and s["detail"] < 6.0:
        is_terrain = False
        reasons.append("flat and featureless — not a surface")

    # ── Which body? ──
    body = "unknown"
    is_moon = False
    if is_terrain:
        if s["mean_sat"] < 0.14 and abs(s["red_tilt"]) < 0.06 and s["blue_tilt"] < 0.04:
            body = "moon"            # near-neutral grey regolith
            is_moon = True
        elif s["red_tilt"] > 0.07:
            body = "mars"            # reddish
        elif s["mean_sat"] < 0.3:
            body = "moon"            # greyish but not perfectly neutral → likely lunar
            is_moon = True

    return {
        "ok": True,
        "is_terrain": is_terrain,
        "is_moon": is_moon,
        "body": body,
        "reason": "; ".join(reasons) or "looks like terrain",
        "scores": s,
    }
