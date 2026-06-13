"""Evaluate a trained Terrain GAN against held-out ground-truth DEM tiles.

Metrics (all computed on denormalised heightmaps):
  - rmse:        root mean squared elevation error
  - slope_mae:   mean absolute error of slope angle (degrees) — what landing
                 hazard maps actually consume, more meaningful than raw RMSE
  - hf_ratio:    high-frequency energy ratio pred/target (1.0 = matches the
                 roughness statistics; <1 over-smoothed, >1 hallucinating)

Metric functions are pure numpy so they are unit-testable without torch.

Usage:
    python -m ai.evaluate --checkpoint checkpoints/terrain_gan_final.pt \
        --data_dir data_cache/holdout_tiles [--cell_size 1.0]
"""

from __future__ import annotations

import argparse
import json
import logging
from pathlib import Path

import numpy as np

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Pure-numpy metrics
# ---------------------------------------------------------------------------

def rmse(pred: np.ndarray, target: np.ndarray) -> float:
    return float(np.sqrt(np.mean((pred.astype(np.float64) - target) ** 2)))


def slope_deg(dem: np.ndarray, cell_size: float = 1.0) -> np.ndarray:
    gy, gx = np.gradient(dem.astype(np.float64), cell_size)
    return np.degrees(np.arctan(np.sqrt(gx**2 + gy**2)))


def slope_mae_deg(pred: np.ndarray, target: np.ndarray, cell_size: float = 1.0) -> float:
    return float(np.mean(np.abs(slope_deg(pred, cell_size) - slope_deg(target, cell_size))))


def high_freq_ratio(pred: np.ndarray, target: np.ndarray, cutoff_frac: float = 0.25) -> float:
    """Energy ratio in the upper spatial-frequency band (pred / target)."""

    def hf_energy(dem: np.ndarray) -> float:
        spec = np.abs(np.fft.fftshift(np.fft.fft2(dem.astype(np.float64)))) ** 2
        h, w = spec.shape
        yy, xx = np.ogrid[:h, :w]
        r = np.sqrt((yy - h / 2) ** 2 + (xx - w / 2) ** 2)
        mask = r > (min(h, w) / 2) * (1.0 - cutoff_frac)
        return float(spec[mask].sum())

    target_e = hf_energy(target)
    if target_e <= 0.0:
        return 0.0
    return hf_energy(pred) / target_e


def evaluate_pair(
    pred: np.ndarray, target: np.ndarray, cell_size: float = 1.0
) -> dict[str, float]:
    return {
        "rmse": rmse(pred, target),
        "slope_mae_deg": slope_mae_deg(pred, target, cell_size),
        "hf_ratio": high_freq_ratio(pred, target),
    }


# ---------------------------------------------------------------------------
# Checkpoint evaluation over a holdout tile directory
# ---------------------------------------------------------------------------

def evaluate_checkpoint(
    checkpoint_path: str | Path,
    data_dir: str | Path,
    cell_size: float = 1.0,
    device: str = "auto",
) -> dict:
    """Run the model over every image/DEM pair in ``data_dir`` and aggregate."""
    from PIL import Image

    from .inference import load_model, predict_dem

    data_dir = Path(data_dir)
    image_dir = data_dir / "images"
    dem_dir = data_dir / "dems"
    stems = sorted(
        {p.stem for p in image_dir.glob("*") if p.suffix in {".png", ".jpg", ".tif"}}
        & {p.stem for p in dem_dir.glob("*.npy")}
    )
    if not stems:
        raise ValueError(f"No matched holdout pairs in {data_dir}")

    model, dev = load_model(checkpoint_path, device)
    per_tile = []
    for stem in stems:
        img = np.array(Image.open(next(image_dir.glob(f"{stem}.*"))).convert("RGB"))
        target = np.load(dem_dir / f"{stem}.npy").astype(np.float32)
        pred = predict_dem(model, img, dev)
        # Compare in the target's physical range.
        t_min, t_max = float(target.min()), float(target.max())
        pred_phys = pred * (t_max - t_min) + t_min
        per_tile.append({"tile": stem, **evaluate_pair(pred_phys, target, cell_size)})

    keys = ("rmse", "slope_mae_deg", "hf_ratio")
    summary = {k: float(np.mean([t[k] for t in per_tile])) for k in keys}
    return {"n_tiles": len(per_tile), "summary": summary, "per_tile": per_tile}


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO)
    parser = argparse.ArgumentParser(description="Evaluate Terrain GAN on holdout tiles")
    parser.add_argument("--checkpoint", required=True)
    parser.add_argument("--data_dir", required=True)
    parser.add_argument("--cell_size", type=float, default=1.0, help="metres per pixel")
    parser.add_argument("--device", default="auto")
    parser.add_argument("--out", default=None, help="write full JSON report here")
    args = parser.parse_args()

    report = evaluate_checkpoint(args.checkpoint, args.data_dir, args.cell_size, args.device)
    print(json.dumps(report["summary"], indent=2))
    print(f"tiles evaluated: {report['n_tiles']}")
    if args.out:
        Path(args.out).write_text(json.dumps(report, indent=2))
        print(f"full report: {args.out}")
