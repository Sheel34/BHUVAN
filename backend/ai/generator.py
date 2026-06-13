"""Pix2Pix Generator — U-Net encoder-decoder for monocular image → DEM.

Architecture:
    Encoder:  Satellite image (3ch) → progressive downsampling with Conv2d stride 2
    Bottleneck: 512-channel feature compression
    Decoder:  Progressive upsampling with TransConv2d + skip connections from encoder
    Output:   Single-channel heightmap (DEM) normalized to [-1, 1]

The skip connections are crucial for terrain reconstruction because they
preserve fine-grained spatial details (crater rims, ridgelines, boulders)
that would be lost through the bottleneck.

References:
    - Pix2Pix: https://arxiv.org/abs/1611.07004
    - MADNet for Mars DEM: Copernicus ISPRS Archives
    - U-Net: https://arxiv.org/abs/1505.04597
"""

from __future__ import annotations

import torch
import torch.nn as nn


class EncoderBlock(nn.Module):
    """Downsampling block: Conv2d (stride 2) → BatchNorm → LeakyReLU."""

    def __init__(
        self,
        in_channels: int,
        out_channels: int,
        use_batch_norm: bool = True,
        kernel_size: int = 4,
        stride: int = 2,
        padding: int = 1,
    ):
        super().__init__()
        layers: list[nn.Module] = [
            nn.Conv2d(in_channels, out_channels, kernel_size, stride, padding, bias=not use_batch_norm)
        ]
        if use_batch_norm:
            layers.append(nn.BatchNorm2d(out_channels))
        layers.append(nn.LeakyReLU(0.2, inplace=True))
        self.block = nn.Sequential(*layers)

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        return self.block(x)


class DecoderBlock(nn.Module):
    """Upsampling block: TransConv2d → BatchNorm → (Dropout) → ReLU.

    Input is concatenated with skip connection from encoder (doubles channels).
    """

    def __init__(
        self,
        in_channels: int,
        out_channels: int,
        use_dropout: bool = False,
        kernel_size: int = 4,
        stride: int = 2,
        padding: int = 1,
    ):
        super().__init__()
        layers: list[nn.Module] = [
            nn.ConvTranspose2d(in_channels, out_channels, kernel_size, stride, padding, bias=False),
            nn.BatchNorm2d(out_channels),
        ]
        if use_dropout:
            layers.append(nn.Dropout(0.5))
        layers.append(nn.ReLU(inplace=True))
        self.block = nn.Sequential(*layers)

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        return self.block(x)


class UNetGenerator(nn.Module):
    """U-Net generator for Pix2Pix terrain reconstruction.

    Converts a monocular satellite image (256×256×3) into a DEM
    heightmap (256×256×1). Uses 8 encoder levels with skip connections.

    Args:
        in_channels:  Number of input image channels (default: 3 for RGB).
        out_channels: Number of output channels (default: 1 for heightmap).
        base_features: Feature multiplier for the first encoder layer (default: 64).

    Shape:
        Input:  (B, 3, 256, 256) — satellite imagery
        Output: (B, 1, 256, 256) — predicted DEM heightmap in [-1, 1]
    """

    def __init__(
        self,
        in_channels: int = 3,
        out_channels: int = 1,
        base_features: int = 64,
    ):
        super().__init__()
        f = base_features

        # ── Encoder ──────────────────────────────────────────────
        # Each level halves spatial dimensions and doubles features.
        # Level:  Input size → Output size (features)
        self.enc1 = EncoderBlock(in_channels, f, use_batch_norm=False)   # 256→128 (64)
        self.enc2 = EncoderBlock(f, f * 2)                               # 128→64  (128)
        self.enc3 = EncoderBlock(f * 2, f * 4)                           # 64→32   (256)
        self.enc4 = EncoderBlock(f * 4, f * 8)                           # 32→16   (512)
        self.enc5 = EncoderBlock(f * 8, f * 8)                           # 16→8    (512)
        self.enc6 = EncoderBlock(f * 8, f * 8)                           # 8→4     (512)
        self.enc7 = EncoderBlock(f * 8, f * 8)                           # 4→2     (512)

        # ── Bottleneck ───────────────────────────────────────────
        self.bottleneck = nn.Sequential(
            nn.Conv2d(f * 8, f * 8, 4, 2, 1),                            # 2→1     (512)
            nn.ReLU(inplace=True),
        )

        # ── Decoder (with skip connections) ──────────────────────
        # Input channels = upsampled features + skip features (concatenated).
        self.dec7 = DecoderBlock(f * 8, f * 8, use_dropout=True)          # 1→2   (512+512=1024 in)
        self.dec6 = DecoderBlock(f * 16, f * 8, use_dropout=True)         # 2→4
        self.dec5 = DecoderBlock(f * 16, f * 8, use_dropout=True)         # 4→8
        self.dec4 = DecoderBlock(f * 16, f * 8)                           # 8→16
        self.dec3 = DecoderBlock(f * 16, f * 4)                           # 16→32
        self.dec2 = DecoderBlock(f * 8, f * 2)                            # 32→64
        self.dec1 = DecoderBlock(f * 4, f)                                # 64→128

        # ── Output ───────────────────────────────────────────────
        self.output = nn.Sequential(
            nn.ConvTranspose2d(f * 2, out_channels, 4, 2, 1),             # 128→256
            nn.Tanh(),  # Output in [-1, 1] range
        )

        # Initialize weights
        self.apply(self._init_weights)

    @staticmethod
    def _init_weights(m: nn.Module) -> None:
        """Initialize Conv/TransConv weights with Normal(0, 0.02)."""
        if isinstance(m, (nn.Conv2d, nn.ConvTranspose2d)):
            nn.init.normal_(m.weight, 0.0, 0.02)
            if m.bias is not None:
                nn.init.constant_(m.bias, 0.0)
        elif isinstance(m, nn.BatchNorm2d):
            nn.init.normal_(m.weight, 1.0, 0.02)
            nn.init.constant_(m.bias, 0.0)

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        """Forward pass with skip connections.

        Args:
            x: Input satellite image tensor (B, C, 256, 256).

        Returns:
            Predicted DEM heightmap (B, 1, 256, 256) in [-1, 1].
        """
        # Encoder (save activations for skip connections)
        e1 = self.enc1(x)    # (B, 64, 128, 128)
        e2 = self.enc2(e1)   # (B, 128, 64, 64)
        e3 = self.enc3(e2)   # (B, 256, 32, 32)
        e4 = self.enc4(e3)   # (B, 512, 16, 16)
        e5 = self.enc5(e4)   # (B, 512, 8, 8)
        e6 = self.enc6(e5)   # (B, 512, 4, 4)
        e7 = self.enc7(e6)   # (B, 512, 2, 2)

        # Bottleneck
        b = self.bottleneck(e7)  # (B, 512, 1, 1)

        # Decoder with skip connections (concatenate along channel dim)
        d7 = self.dec7(b)                           # (B, 512, 2, 2)
        d6 = self.dec6(torch.cat([d7, e7], dim=1))  # (B, 512, 4, 4)
        d5 = self.dec5(torch.cat([d6, e6], dim=1))  # (B, 512, 8, 8)
        d4 = self.dec4(torch.cat([d5, e5], dim=1))  # (B, 512, 16, 16)
        d3 = self.dec3(torch.cat([d4, e4], dim=1))  # (B, 256, 32, 32)
        d2 = self.dec2(torch.cat([d3, e3], dim=1))  # (B, 128, 64, 64)
        d1 = self.dec1(torch.cat([d2, e2], dim=1))  # (B, 64, 128, 128)

        # Output with skip from first encoder
        out = self.output(torch.cat([d1, e1], dim=1))  # (B, 1, 256, 256)
        return out


# ---------------------------------------------------------------------------
# Self-test: verify architecture shapes
# ---------------------------------------------------------------------------
if __name__ == "__main__":
    device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
    print(f"Testing UNetGenerator on device: {device}")

    model = UNetGenerator(in_channels=3, out_channels=1, base_features=64).to(device)

    # Count parameters
    total_params = sum(p.numel() for p in model.parameters())
    trainable_params = sum(p.numel() for p in model.parameters() if p.requires_grad)
    print(f"  Total parameters:     {total_params:,}")
    print(f"  Trainable parameters: {trainable_params:,}")

    # Forward pass test
    dummy_input = torch.randn(2, 3, 256, 256, device=device)
    output = model(dummy_input)
    print(f"  Input shape:  {dummy_input.shape}")
    print(f"  Output shape: {output.shape}")
    assert output.shape == (2, 1, 256, 256), f"Unexpected shape: {output.shape}"
    assert output.min() >= -1.0 and output.max() <= 1.0, "Output out of [-1, 1] range"

    print("  ✓ UNetGenerator: all shape tests passed")
