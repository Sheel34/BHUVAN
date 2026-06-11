# Terrain GAN — training and deployment playbook

Pix2pix (U-Net generator + PatchGAN discriminator) mapping satellite imagery
to DEM heightmaps. Losses: adversarial + L1 (λ=100) + Sobel edge (λ=10).

## Environment

Training needs PyTorch (not installed in the web backend venv on purpose):

```bash
pip install torch torchvision --index-url https://download.pytorch.org/whl/cu121
```

The web API and Celery worker degrade gracefully without torch: requests with
`ai_enhance: true` return `501 MODEL_UNAVAILABLE` / job state `FAILURE`.

## 1. Build the training set

### Mars (HiRISE ortho + DTM pairs)

```bash
python -m data.hirise_downloader --download          # fetch curated DTMs (AWS open data)
python -m data.tile_processor \
    --imagery data_cache/hirise/<site>_ortho.tif \
    --dtm     data_cache/hirise/<site>_dem.tif \
    --output_dir data_cache/training_tiles --tile_size 256 --overlap 64
```

### Earth pretraining (more data, transfer to planetary)

Pair Sentinel-2 RGB with ALOS World 3D 30m DEM via Google Earth Engine
(method of Panagiotou et al. 2020, https://github.com/Panagiotou/ImageToDEM).
Export co-registered 256x256 tiles into the same `images/` + `dems/` layout
expected by `TerrainPairDataset`.

Recommended schedule: pretrain on Earth pairs (~50k tiles, 100 epochs),
fine-tune on Mars/Moon pairs (20-50 epochs, lr/10, `--resume`).

## 2. Train

```bash
python -m ai.train --data_dir data_cache/training_tiles \
    --output_dir checkpoints --epochs 200 --batch_size 8
# fine-tune:
python -m ai.train --data_dir data_cache/lunar_tiles \
    --resume checkpoints/terrain_gan_final.pt --epochs 50 --lr 2e-5
```

Checkpoints land in `checkpoints/terrain_gan_*.pt`; history in
`training_history.json`. 8 GB VRAM fits batch 8 at 256px.

## 3. Deploy

The runtime looks for `checkpoints/terrain_gan_final.pt` (override with
`ARES_GAN_CHECKPOINT`). Once present:

- `POST /api/v1/analyze {"sample": ..., "ai_enhance": true}` — sync
- `POST /api/v2/jobs {"sample": ..., "ai_enhance": true}` — async (GPU work
  belongs here; the worker publishes an "AI elevation enhancement" stage)

## 4. Evaluate

```bash
python -m ai.evaluate --checkpoint checkpoints/terrain_gan_final.pt \
    --data_dir data_cache/holdout_tiles
```

Reports RMSE (m), slope MAE (deg), and high-frequency energy ratio vs ground
truth on held-out tiles (see `ai/evaluate.py`). Hold out entire HiRISE sites,
not random tiles — adjacent tiles leak.
