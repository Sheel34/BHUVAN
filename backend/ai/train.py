"""Training loop for the Terrain Pix2Pix GAN.

Trains the U-Net Generator and PatchGAN Discriminator on paired
satellite imagery ↔ DEM data from HiRISE.

Loss components:
    1. Adversarial loss (BCEWithLogits) — makes generated DEMs look realistic
    2. L1 loss — pixel-level accuracy (weighted λ=100)
    3. Edge-aware loss — preserves crater rims and ridgelines (Sobel-based)

Usage:
    # From project root with data prepared:
    python -m backend.ai.train --data_dir data_cache/training_tiles --epochs 200

    # Or in Google Colab:
    !python -m backend.ai.train --data_dir /content/tiles --epochs 100 --batch_size 8
"""

from __future__ import annotations

import argparse
import json
import logging
import os
import time
from pathlib import Path
from typing import Optional

import numpy as np
import torch
import torch.nn as nn
import torch.optim as optim
from torch.utils.data import DataLoader, Dataset

from .generator import UNetGenerator
from .discriminator import PatchGANDiscriminator

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Dataset
# ---------------------------------------------------------------------------

class TerrainPairDataset(Dataset):
    """Dataset of paired satellite image ↔ DEM tiles.

    Expects directory structure:
        data_dir/
            images/    ← satellite images (PNG/JPG, 256×256)
            dems/      ← matching DEMs (NPY, 256×256 float32)

    Files are matched by name (e.g., images/tile_001.png ↔ dems/tile_001.npy).
    """

    def __init__(self, data_dir: str | Path, augment: bool = True):
        self.data_dir = Path(data_dir)
        self.augment = augment

        self.image_dir = self.data_dir / "images"
        self.dem_dir = self.data_dir / "dems"

        if not self.image_dir.exists():
            raise FileNotFoundError(f"Image directory not found: {self.image_dir}")
        if not self.dem_dir.exists():
            raise FileNotFoundError(f"DEM directory not found: {self.dem_dir}")

        # Find matched pairs
        image_stems = {p.stem for p in self.image_dir.glob("*") if p.suffix in {".png", ".jpg", ".jpeg", ".tif"}}
        dem_stems = {p.stem for p in self.dem_dir.glob("*.npy")}
        self.stems = sorted(image_stems & dem_stems)

        if len(self.stems) == 0:
            raise ValueError(f"No matched pairs found in {data_dir}")

        logger.info(f"Found {len(self.stems)} matched image-DEM pairs")

    def __len__(self) -> int:
        return len(self.stems)

    def __getitem__(self, idx: int) -> tuple[torch.Tensor, torch.Tensor]:
        stem = self.stems[idx]

        # Load image
        img_path = next(self.image_dir.glob(f"{stem}.*"))
        from PIL import Image
        img = Image.open(img_path).convert("RGB").resize((256, 256))
        img_np = np.array(img, dtype=np.float32) / 255.0  # [0, 1]
        img_np = (img_np - 0.5) / 0.5  # [-1, 1]

        # Load DEM
        dem_np = np.load(self.dem_dir / f"{stem}.npy").astype(np.float32)
        if dem_np.shape != (256, 256):
            from PIL import Image as PILImage
            dem_np = np.array(PILImage.fromarray(dem_np).resize((256, 256)))
        # Normalize DEM to [-1, 1]
        dem_min, dem_max = dem_np.min(), dem_np.max()
        if dem_max - dem_min > 1e-6:
            dem_np = 2.0 * (dem_np - dem_min) / (dem_max - dem_min) - 1.0
        else:
            dem_np = np.zeros_like(dem_np)

        # Apply augmentations
        if self.augment:
            # Random horizontal flip
            if np.random.random() > 0.5:
                img_np = np.flip(img_np, axis=1).copy()
                dem_np = np.flip(dem_np, axis=1).copy()
            # Random vertical flip
            if np.random.random() > 0.5:
                img_np = np.flip(img_np, axis=0).copy()
                dem_np = np.flip(dem_np, axis=0).copy()
            # Random 90° rotation
            k = np.random.randint(0, 4)
            if k > 0:
                img_np = np.rot90(img_np, k, axes=(0, 1)).copy()
                dem_np = np.rot90(dem_np, k).copy()

        # To tensors: (C, H, W)
        img_tensor = torch.from_numpy(img_np.transpose(2, 0, 1))  # (3, 256, 256)
        dem_tensor = torch.from_numpy(dem_np).unsqueeze(0)          # (1, 256, 256)

        return img_tensor, dem_tensor


# ---------------------------------------------------------------------------
# Losses
# ---------------------------------------------------------------------------

class EdgeAwareLoss(nn.Module):
    """Sobel-based edge loss to preserve terrain discontinuities.

    Computes L1 loss between edge maps of predicted and target DEMs,
    ensuring crater rims and ridgelines are sharp.
    """

    def __init__(self):
        super().__init__()
        # Sobel kernels for edge detection
        sobel_x = torch.tensor([[-1, 0, 1], [-2, 0, 2], [-1, 0, 1]], dtype=torch.float32).reshape(1, 1, 3, 3)
        sobel_y = torch.tensor([[-1, -2, -1], [0, 0, 0], [1, 2, 1]], dtype=torch.float32).reshape(1, 1, 3, 3)
        self.register_buffer("sobel_x", sobel_x)
        self.register_buffer("sobel_y", sobel_y)

    def forward(self, pred: torch.Tensor, target: torch.Tensor) -> torch.Tensor:
        # Compute edge maps
        pred_edge_x = torch.nn.functional.conv2d(pred, self.sobel_x, padding=1)
        pred_edge_y = torch.nn.functional.conv2d(pred, self.sobel_y, padding=1)
        target_edge_x = torch.nn.functional.conv2d(target, self.sobel_x, padding=1)
        target_edge_y = torch.nn.functional.conv2d(target, self.sobel_y, padding=1)

        pred_edges = torch.sqrt(pred_edge_x ** 2 + pred_edge_y ** 2 + 1e-8)
        target_edges = torch.sqrt(target_edge_x ** 2 + target_edge_y ** 2 + 1e-8)

        return torch.nn.functional.l1_loss(pred_edges, target_edges)


# ---------------------------------------------------------------------------
# Training
# ---------------------------------------------------------------------------

class TerrainGANTrainer:
    """Manages the full GAN training loop.

    Args:
        data_dir: Path to training data directory.
        output_dir: Path to save checkpoints and logs.
        device: PyTorch device ("cuda" or "cpu").
        lr: Learning rate for both G and D (default: 2e-4).
        lambda_l1: Weight for L1 reconstruction loss (default: 100).
        lambda_edge: Weight for edge-aware loss (default: 10).
        batch_size: Training batch size.
    """

    def __init__(
        self,
        data_dir: str | Path,
        output_dir: str | Path = "checkpoints",
        device: str = "auto",
        lr: float = 2e-4,
        lambda_l1: float = 100.0,
        lambda_edge: float = 10.0,
        batch_size: int = 4,
    ):
        if device == "auto":
            self.device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
        else:
            self.device = torch.device(device)

        self.output_dir = Path(output_dir)
        self.output_dir.mkdir(parents=True, exist_ok=True)
        self.lambda_l1 = lambda_l1
        self.lambda_edge = lambda_edge
        self.batch_size = batch_size

        # Models
        self.gen = UNetGenerator(in_channels=3, out_channels=1).to(self.device)
        self.disc = PatchGANDiscriminator(in_channels=4).to(self.device)

        # Optimizers (Adam with β1=0.5 as per Pix2Pix paper)
        self.opt_gen = optim.Adam(self.gen.parameters(), lr=lr, betas=(0.5, 0.999))
        self.opt_disc = optim.Adam(self.disc.parameters(), lr=lr, betas=(0.5, 0.999))

        # Losses
        self.criterion_gan = nn.BCEWithLogitsLoss()
        self.criterion_l1 = nn.L1Loss()
        self.criterion_edge = EdgeAwareLoss().to(self.device)

        # Dataset
        self.dataset = TerrainPairDataset(data_dir, augment=True)
        self.dataloader = DataLoader(
            self.dataset,
            batch_size=batch_size,
            shuffle=True,
            num_workers=0,  # Windows-safe default
            pin_memory=self.device.type == "cuda",
            drop_last=True,
        )

        # Training history
        self.history: list[dict] = []

    def train(
        self,
        epochs: int = 200,
        save_every: int = 10,
        log_every: int = 1,
    ) -> list[dict]:
        """Run training loop.

        Args:
            epochs: Total number of training epochs.
            save_every: Save checkpoint every N epochs.
            log_every: Print metrics every N epochs.

        Returns:
            Training history as list of epoch dicts.
        """
        logger.info(
            f"Starting training: {epochs} epochs, {len(self.dataset)} samples, "
            f"batch_size={self.batch_size}, device={self.device}"
        )

        for epoch in range(1, epochs + 1):
            epoch_start = time.time()
            g_losses, d_losses = [], []

            for batch_idx, (satellite, real_dem) in enumerate(self.dataloader):
                satellite = satellite.to(self.device)
                real_dem = real_dem.to(self.device)

                # ── Train Discriminator ──────────────────────────
                self.opt_disc.zero_grad()

                # Real pair
                real_pair = torch.cat([satellite, real_dem], dim=1)
                pred_real = self.disc(real_pair)
                label_real = torch.ones_like(pred_real)
                loss_d_real = self.criterion_gan(pred_real, label_real)

                # Fake pair
                fake_dem = self.gen(satellite).detach()
                fake_pair = torch.cat([satellite, fake_dem], dim=1)
                pred_fake = self.disc(fake_pair)
                label_fake = torch.zeros_like(pred_fake)
                loss_d_fake = self.criterion_gan(pred_fake, label_fake)

                loss_d = (loss_d_real + loss_d_fake) * 0.5
                loss_d.backward()
                self.opt_disc.step()

                # ── Train Generator ──────────────────────────────
                self.opt_gen.zero_grad()

                fake_dem = self.gen(satellite)
                fake_pair = torch.cat([satellite, fake_dem], dim=1)
                pred_fake = self.disc(fake_pair)
                label_real = torch.ones_like(pred_fake)

                # Adversarial loss (fool the discriminator)
                loss_g_gan = self.criterion_gan(pred_fake, label_real)

                # L1 reconstruction loss (pixel accuracy)
                loss_g_l1 = self.criterion_l1(fake_dem, real_dem)

                # Edge-aware loss (preserve discontinuities)
                loss_g_edge = self.criterion_edge(fake_dem, real_dem)

                # Combined generator loss
                loss_g = loss_g_gan + self.lambda_l1 * loss_g_l1 + self.lambda_edge * loss_g_edge
                loss_g.backward()
                self.opt_gen.step()

                g_losses.append(loss_g.item())
                d_losses.append(loss_d.item())

            # Epoch stats
            epoch_time = time.time() - epoch_start
            stats = {
                "epoch": epoch,
                "g_loss": float(np.mean(g_losses)),
                "d_loss": float(np.mean(d_losses)),
                "time_s": round(epoch_time, 2),
            }
            self.history.append(stats)

            if epoch % log_every == 0:
                logger.info(
                    f"Epoch {epoch:4d}/{epochs} | "
                    f"G_loss: {stats['g_loss']:.4f} | "
                    f"D_loss: {stats['d_loss']:.4f} | "
                    f"Time: {stats['time_s']:.1f}s"
                )

            if epoch % save_every == 0:
                self.save_checkpoint(epoch)

        # Final save
        self.save_checkpoint(epochs, is_final=True)
        return self.history

    def save_checkpoint(self, epoch: int, is_final: bool = False) -> Path:
        """Save model checkpoint."""
        suffix = "final" if is_final else f"epoch_{epoch:04d}"
        path = self.output_dir / f"terrain_gan_{suffix}.pt"

        torch.save(
            {
                "epoch": epoch,
                "generator_state_dict": self.gen.state_dict(),
                "discriminator_state_dict": self.disc.state_dict(),
                "opt_gen_state_dict": self.opt_gen.state_dict(),
                "opt_disc_state_dict": self.opt_disc.state_dict(),
                "history": self.history,
            },
            path,
        )
        logger.info(f"Saved checkpoint: {path}")

        # Also save history as JSON for easy inspection
        history_path = self.output_dir / "training_history.json"
        history_path.write_text(json.dumps(self.history, indent=2))

        return path

    def load_checkpoint(self, path: str | Path) -> int:
        """Load a checkpoint and return the epoch number."""
        checkpoint = torch.load(path, map_location=self.device, weights_only=False)
        self.gen.load_state_dict(checkpoint["generator_state_dict"])
        self.disc.load_state_dict(checkpoint["discriminator_state_dict"])
        self.opt_gen.load_state_dict(checkpoint["opt_gen_state_dict"])
        self.opt_disc.load_state_dict(checkpoint["opt_disc_state_dict"])
        self.history = checkpoint.get("history", [])
        epoch = checkpoint["epoch"]
        logger.info(f"Loaded checkpoint from epoch {epoch}")
        return epoch


# ---------------------------------------------------------------------------
# CLI entry point
# ---------------------------------------------------------------------------
if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")

    parser = argparse.ArgumentParser(description="Train Terrain Pix2Pix GAN")
    parser.add_argument("--data_dir", type=str, required=True, help="Path to training tiles directory")
    parser.add_argument("--output_dir", type=str, default="checkpoints", help="Checkpoint output directory")
    parser.add_argument("--epochs", type=int, default=200, help="Number of training epochs")
    parser.add_argument("--batch_size", type=int, default=4, help="Batch size")
    parser.add_argument("--lr", type=float, default=2e-4, help="Learning rate")
    parser.add_argument("--lambda_l1", type=float, default=100.0, help="L1 loss weight")
    parser.add_argument("--lambda_edge", type=float, default=10.0, help="Edge loss weight")
    parser.add_argument("--device", type=str, default="auto", help="Device: auto, cuda, or cpu")
    parser.add_argument("--resume", type=str, default=None, help="Resume from checkpoint path")

    args = parser.parse_args()

    trainer = TerrainGANTrainer(
        data_dir=args.data_dir,
        output_dir=args.output_dir,
        device=args.device,
        lr=args.lr,
        lambda_l1=args.lambda_l1,
        lambda_edge=args.lambda_edge,
        batch_size=args.batch_size,
    )

    start_epoch = 0
    if args.resume:
        start_epoch = trainer.load_checkpoint(args.resume)

    history = trainer.train(epochs=args.epochs, save_every=10, log_every=1)
    print(f"\nTraining complete. {len(history)} epochs logged.")
    print(f"Final G_loss: {history[-1]['g_loss']:.4f}, D_loss: {history[-1]['d_loss']:.4f}")
