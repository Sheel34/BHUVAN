# BHUVAN evaluation protocol — image-to-DEM and landing-zone quality

Purpose: a fixed, honest protocol so results are comparable across model
versions and credible in a competition write-up (CVPR AI4Space workshop /
NASA Space Apps). Nothing here is run automatically; it is the contract the
training work must satisfy.

## 1. Ground-truth datasets (held out, never trained on)

| Holdout site | Source | Why |
|---|---|---|
| Chandrayaan-3 Vikram landing site, 0.30 m DEM | Chandrayaan-2 OHRC stereo (arXiv:2602.14993, ISRO PRADAN) | Mission-relevant lunar south-pole terrain; independent geodetic anchoring |
| 2 LROC NAC DTM sites (2 m/px) excluded from training | lroc.im-ldi.com / PDS | Lunar generalisation check |
| 1 HiRISE DTM site (1 m/px) excluded from training | USGS / AWS open data | Mars generalisation check |

Rule: hold out **entire sites**, never random tiles — adjacent tiles share
terrain statistics and leak.

## 2. DEM reconstruction metrics (per tile, then site mean)

Implemented in `backend/ai/evaluate.py` (pure numpy, unit-tested):

- **RMSE (m)** — raw elevation error after matching the target's physical range.
- **Slope MAE (deg)** — error of the derivative the hazard pipeline actually
  consumes; a model can win RMSE while destroying slopes, this catches it.
- **HF energy ratio** — predicted/target spectral energy above 0.75 Nyquist;
  ~1.0 is right, <1 means over-smoothed (the classic GAN failure for DEMs),
  >1 means hallucinated roughness.

Run: `python -m ai.evaluate --checkpoint <ckpt> --data_dir <holdout_tiles> --cell_size <m_per_px>`

## 3. Uncertainty quality (MC dropout)

`predict_dem_with_uncertainty` (backend/ai/inference.py) gives mean + std maps
from N=8 stochastic passes. Evaluate calibration with sparsification curves:
sort pixels by predicted std, drop the most-uncertain x%, plot remaining RMSE.
A useful uncertainty map gives a monotonically decreasing curve clearly below
random-drop baseline.

## 4. Downstream task metric — what actually matters

Landing-zone agreement: run the full hazard + zone-ranking pipeline on
(a) ground-truth DEM and (b) predicted DEM for the same site.

- **Top-1 zone hit rate**: predicted #1 zone centre falls inside any
  ground-truth safe zone.
- **Safe-area IoU**: intersection-over-union of hazard < 0.42 masks.
- **Critical failure rate**: fraction of predicted "safe" zones that are
  "unsafe" on ground truth — the number a mission planner cares about; report
  it with its 95% bootstrap CI (machinery already in pipeline/landing_zones.py).

## 5. Baselines to beat (else the GAN earns nothing)

1. Bicubic upsampling of input intensity as pseudo-DEM.
2. Shape-from-shading (classical photoclinometry).
3. ImageToDEM cGAN reference implementation (Panagiotou et al. 2020) retrained
   on the same data.

## 6. Write-up skeleton

1. Problem: DEM scarcity (4% lunar stereo coverage) vs imagery abundance; Vikram motivation.
2. Method: pix2pix + edge loss; MC-dropout uncertainty; bootstrap zone CIs end-to-end.
3. Data: train/holdout split by site, exact product IDs listed.
4. Results: tables for sections 2-4 vs section 5 baselines.
5. Limitations: relative (not absolute) elevation; illumination bias; 256px native resolution.
