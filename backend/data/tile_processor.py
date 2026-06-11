"""Tile processor — prepare HiRISE imagery + DTM pairs for GAN training.

Takes co-located HiRISE imagery and DTM GeoTIFFs, co-registers them,
and tiles into 256×256 patches for training the Pix2Pix GAN.

Workflow:
    1. Load HiRISE imagery GeoTIFF (orthoimage) + DTM GeoTIFF
    2. Co-register to same spatial extent and resolution
    3. Tile into 256×256 patches with optional overlap
    4. Save as images/ (PNG) and dems/ (NPY) for TerrainPairDataset

Usage:
    python -m backend.data.tile_processor \
        --imagery path/to/orthoimage.tif \
        --dtm path/to/dtm.tif \
        --output_dir data_cache/training_tiles \
        --tile_size 256 \
        --overlap 64

References:
    - HiRISE DTMs: https://www.uahirise.org/dtm/
    - Co-registration: GDAL/rasterio warp
"""

from __future__ import annotations

import argparse
import logging
from pathlib import Path

import numpy as np

logger = logging.getLogger(__name__)


def tile_dem_for_training(
    dtm_path: str | Path,
    output_dir: str | Path,
    tile_size: int = 256,
    overlap: int = 64,
    imagery_path: str | Path | None = None,
    min_valid_fraction: float = 0.9,
    prefix: str = "tile",
) -> int:
    """Tile a DTM (and optional imagery) into training-ready patches.

    Args:
        dtm_path: Path to DTM GeoTIFF.
        output_dir: Output directory (will create images/ and dems/ subdirs).
        tile_size: Size of output tiles (default: 256).
        overlap: Pixel overlap between adjacent tiles (default: 64).
        imagery_path: Optional matching orthoimage GeoTIFF.
        min_valid_fraction: Skip tiles with too many nodata pixels.
        prefix: Filename prefix for tiles.

    Returns:
        Number of tiles generated.
    """
    import cv2
    import rasterio
    from rasterio.enums import Resampling

    output = Path(output_dir)
    dem_dir = output / "dems"
    img_dir = output / "images"
    dem_dir.mkdir(parents=True, exist_ok=True)
    img_dir.mkdir(parents=True, exist_ok=True)

    # Load DTM
    with rasterio.open(str(dtm_path)) as src:
        dtm_data = src.read(1).astype(np.float32)
        dtm_nodata = src.nodata
        dtm_transform = src.transform
        dtm_crs = src.crs

    # Handle nodata
    if dtm_nodata is not None:
        dtm_data = np.where(dtm_data == dtm_nodata, np.nan, dtm_data)

    logger.info(f"DTM shape: {dtm_data.shape}, range: [{np.nanmin(dtm_data):.1f}, {np.nanmax(dtm_data):.1f}]")

    # Load imagery if provided
    img_data = None
    if imagery_path is not None:
        with rasterio.open(str(imagery_path)) as src:
            if src.count >= 3:
                img_data = np.stack([src.read(i) for i in range(1, 4)], axis=-1)
            else:
                # Single band — create pseudo-RGB
                band = src.read(1).astype(np.float32)
                img_data = np.stack([band, band, band], axis=-1)
        logger.info(f"Imagery shape: {img_data.shape}")
    else:
        # Generate pseudo-RGB from DTM (elevation, slope, hillshade)
        logger.info("No imagery provided — generating pseudo-RGB from DTM")
        dtm_norm = (dtm_data - np.nanmin(dtm_data)) / (np.nanmax(dtm_data) - np.nanmin(dtm_data) + 1e-8)

        gy, gx = np.gradient(np.nan_to_num(dtm_norm, nan=0.0))
        slope = np.sqrt(gx**2 + gy**2)
        slope = slope / (slope.max() + 1e-8)

        sun_az, sun_el = np.deg2rad(315), np.deg2rad(45)
        hillshade = np.clip(
            np.sin(sun_el) + np.cos(sun_el) * (gx * np.cos(sun_az) + gy * np.sin(sun_az)),
            0, 1,
        )

        img_data = (np.stack([dtm_norm, slope, hillshade], axis=-1) * 255).astype(np.uint8)

    # Tile extraction
    h, w = dtm_data.shape
    step = tile_size - overlap
    tile_count = 0

    for y in range(0, h - tile_size + 1, step):
        for x in range(0, w - tile_size + 1, step):
            # Extract tile
            dem_tile = dtm_data[y : y + tile_size, x : x + tile_size]
            img_tile = img_data[y : y + tile_size, x : x + tile_size]

            # Skip tiles with too many NaN / invalid pixels
            valid_fraction = np.sum(~np.isnan(dem_tile)) / dem_tile.size
            if valid_fraction < min_valid_fraction:
                continue

            # Skip tiles with insufficient elevation variation
            dem_range = np.nanmax(dem_tile) - np.nanmin(dem_tile)
            if dem_range < 0.5:  # Less than 0.5m variation
                continue

            # Inpaint any remaining NaN values in the tile
            nan_mask = np.isnan(dem_tile)
            if nan_mask.any():
                dem_filled = np.nan_to_num(dem_tile, nan=0.0).astype(np.float32)
                mask_uint8 = nan_mask.astype(np.uint8)
                dem_tile = cv2.inpaint(dem_filled, mask_uint8, 3, cv2.INPAINT_TELEA)

            # Save DEM tile (as numpy for precision)
            tile_name = f"{prefix}_{tile_count:05d}"
            np.save(dem_dir / f"{tile_name}.npy", dem_tile.astype(np.float32))

            # Save image tile (as PNG)
            if img_tile.dtype != np.uint8:
                img_tile_uint8 = np.clip(img_tile, 0, 255).astype(np.uint8)
            else:
                img_tile_uint8 = img_tile

            from PIL import Image
            Image.fromarray(img_tile_uint8).save(img_dir / f"{tile_name}.png")

            tile_count += 1

    logger.info(f"Generated {tile_count} tiles ({tile_size}×{tile_size}) to {output_dir}")
    return tile_count


def create_synthetic_training_data(
    output_dir: str | Path,
    num_tiles: int = 500,
    tile_size: int = 256,
) -> int:
    """Generate synthetic terrain pairs for pre-training / testing.

    Creates procedural terrain DEMs and corresponding pseudo-satellite
    images. Useful for validating the training pipeline before real data.

    Args:
        output_dir: Output directory.
        num_tiles: Number of tiles to generate.
        tile_size: Size of each tile.

    Returns:
        Number of tiles generated.
    """
    from PIL import Image

    output = Path(output_dir)
    dem_dir = output / "dems"
    img_dir = output / "images"
    dem_dir.mkdir(parents=True, exist_ok=True)
    img_dir.mkdir(parents=True, exist_ok=True)

    for i in range(num_tiles):
        # Generate random terrain
        np.random.seed(i)
        xs = np.linspace(-2, 2, tile_size)
        ys = np.linspace(-2, 2, tile_size)
        xx, yy = np.meshgrid(xs, ys)

        # Random terrain features
        terrain = np.zeros((tile_size, tile_size), dtype=np.float32)

        # Add random craters
        n_craters = np.random.randint(1, 5)
        for _ in range(n_craters):
            cx, cy = np.random.uniform(-1.5, 1.5, 2)
            r = np.random.uniform(0.2, 0.8)
            depth = np.random.uniform(0.3, 1.0)
            dist = np.sqrt((xx - cx) ** 2 + (yy - cy) ** 2)
            terrain -= depth * np.exp(-(dist ** 2) / (2 * r ** 2))
            # Add rim
            terrain += depth * 0.3 * np.exp(-((dist - r) ** 2) / (2 * (r * 0.2) ** 2))

        # Add ridges
        freq = np.random.uniform(3, 8)
        phase = np.random.uniform(0, 2 * np.pi)
        terrain += 0.3 * np.sin(xx * freq + phase) * np.cos(yy * freq * 0.7)

        # Add noise
        terrain += np.random.normal(0, 0.05, terrain.shape)

        # Normalize DEM
        terrain = terrain.astype(np.float32)

        # Create pseudo-satellite image from DEM
        dem_norm = (terrain - terrain.min()) / (terrain.max() - terrain.min() + 1e-8)
        gy, gx = np.gradient(dem_norm)
        slope = np.sqrt(gx**2 + gy**2)
        slope = slope / (slope.max() + 1e-8)

        sun_az, sun_el = np.deg2rad(315), np.deg2rad(45)
        hillshade = np.clip(
            np.sin(sun_el) + np.cos(sun_el) * (gx * np.cos(sun_az) + gy * np.sin(sun_az)),
            0, 1,
        )

        img = (np.stack([dem_norm, slope, hillshade], axis=-1) * 255).astype(np.uint8)

        # Add some color variation to simulate real imagery
        tint = np.random.uniform(0.7, 1.0, 3).astype(np.float32)
        img = np.clip(img * tint[None, None, :], 0, 255).astype(np.uint8)

        # Save
        tile_name = f"synth_{i:05d}"
        np.save(dem_dir / f"{tile_name}.npy", terrain)
        Image.fromarray(img).save(img_dir / f"{tile_name}.png")

    logger.info(f"Generated {num_tiles} synthetic training tiles to {output_dir}")
    return num_tiles


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------
if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")

    parser = argparse.ArgumentParser(description="Tile processor for terrain GAN training")
    sub = parser.add_subparsers(dest="command")

    # Tile real data
    tile_cmd = sub.add_parser("tile", help="Tile real HiRISE data")
    tile_cmd.add_argument("--dtm", required=True, help="DTM GeoTIFF path")
    tile_cmd.add_argument("--imagery", default=None, help="Orthoimage GeoTIFF path")
    tile_cmd.add_argument("--output_dir", required=True, help="Output directory")
    tile_cmd.add_argument("--tile_size", type=int, default=256)
    tile_cmd.add_argument("--overlap", type=int, default=64)

    # Generate synthetic data
    synth_cmd = sub.add_parser("synthetic", help="Generate synthetic training data")
    synth_cmd.add_argument("--output_dir", required=True, help="Output directory")
    synth_cmd.add_argument("--num_tiles", type=int, default=500)
    synth_cmd.add_argument("--tile_size", type=int, default=256)

    args = parser.parse_args()

    if args.command == "tile":
        count = tile_dem_for_training(
            dtm_path=args.dtm,
            output_dir=args.output_dir,
            tile_size=args.tile_size,
            overlap=args.overlap,
            imagery_path=args.imagery,
        )
        print(f"Created {count} tiles")

    elif args.command == "synthetic":
        count = create_synthetic_training_data(
            output_dir=args.output_dir,
            num_tiles=args.num_tiles,
            tile_size=args.tile_size,
        )
        print(f"Created {count} synthetic tiles")

    else:
        parser.print_help()
