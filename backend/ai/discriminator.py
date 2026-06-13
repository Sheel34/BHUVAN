"""PatchGAN Discriminator for Pix2Pix terrain reconstruction.

The discriminator receives a pair of images: the satellite image (condition)
and either the real DEM or the generated DEM. It produces a grid of
real/fake predictions — each cell in the output receptive field covers a
70×70 patch of the input, hence "PatchGAN".

This is more effective than a standard binary discriminator because it:
1. Forces the generator to produce locally consistent texture/detail
2. Has fewer parameters → faster training, less overfitting
3. Works as a learned texture/structure loss function

References:
    - Pix2Pix: https://arxiv.org/abs/1611.07004
    - PatchGAN analysis: "Image-to-Image Translation with Conditional GANs"
"""

from __future__ import annotations

import torch
import torch.nn as nn


class PatchGANDiscriminator(nn.Module):
    """PatchGAN discriminator for conditional image-to-image translation.

    Takes a concatenation of condition image (satellite) and target/generated
    DEM and outputs a grid of real/fake scores.

    Args:
        in_channels: Combined channels of condition + target (default: 3+1=4).
        base_features: Feature multiplier for first layer (default: 64).
        n_layers: Number of intermediate conv layers (default: 3).

    Shape:
        Input:  (B, 4, 256, 256) — concatenated [satellite_img | DEM]
        Output: (B, 1, 30, 30) — patch-wise real/fake scores
    """

    def __init__(
        self,
        in_channels: int = 4,  # 3 (satellite RGB) + 1 (DEM)
        base_features: int = 64,
        n_layers: int = 3,
    ):
        super().__init__()

        layers: list[nn.Module] = []

        # First layer: no BatchNorm (as per Pix2Pix paper)
        layers.append(
            nn.Sequential(
                nn.Conv2d(in_channels, base_features, 4, stride=2, padding=1),
                nn.LeakyReLU(0.2, inplace=True),
            )
        )

        # Intermediate layers: Conv → BatchNorm → LeakyReLU
        features = base_features
        for i in range(1, n_layers):
            prev_features = features
            features = min(base_features * (2 ** i), 512)
            layers.append(
                nn.Sequential(
                    nn.Conv2d(prev_features, features, 4, stride=2, padding=1, bias=False),
                    nn.BatchNorm2d(features),
                    nn.LeakyReLU(0.2, inplace=True),
                )
            )

        # Penultimate layer: stride 1
        prev_features = features
        features = min(base_features * (2 ** n_layers), 512)
        layers.append(
            nn.Sequential(
                nn.Conv2d(prev_features, features, 4, stride=1, padding=1, bias=False),
                nn.BatchNorm2d(features),
                nn.LeakyReLU(0.2, inplace=True),
            )
        )

        # Output layer: single-channel prediction map
        layers.append(
            nn.Conv2d(features, 1, 4, stride=1, padding=1)
        )

        self.model = nn.Sequential(*layers)

        # Initialize weights
        self.apply(self._init_weights)

    @staticmethod
    def _init_weights(m: nn.Module) -> None:
        if isinstance(m, (nn.Conv2d, nn.ConvTranspose2d)):
            nn.init.normal_(m.weight, 0.0, 0.02)
            if m.bias is not None:
                nn.init.constant_(m.bias, 0.0)
        elif isinstance(m, nn.BatchNorm2d):
            nn.init.normal_(m.weight, 1.0, 0.02)
            nn.init.constant_(m.bias, 0.0)

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        """Forward pass.

        Args:
            x: Concatenated condition + target/generated (B, 4, 256, 256).

        Returns:
            Patch-wise real/fake scores (B, 1, H_out, W_out).
        """
        return self.model(x)


# ---------------------------------------------------------------------------
# Self-test
# ---------------------------------------------------------------------------
if __name__ == "__main__":
    device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
    print(f"Testing PatchGANDiscriminator on device: {device}")

    disc = PatchGANDiscriminator(in_channels=4, base_features=64).to(device)

    total_params = sum(p.numel() for p in disc.parameters())
    print(f"  Total parameters: {total_params:,}")

    # Simulate condition (satellite image) + target (DEM)
    satellite = torch.randn(2, 3, 256, 256, device=device)
    dem = torch.randn(2, 1, 256, 256, device=device)
    combined = torch.cat([satellite, dem], dim=1)  # (2, 4, 256, 256)

    output = disc(combined)
    print(f"  Input shape:  {combined.shape}")
    print(f"  Output shape: {output.shape}")
    assert output.shape[0] == 2
    assert output.shape[1] == 1
    print(f"  Output grid:  {output.shape[2]}×{output.shape[3]} patches")

    print("  ✓ PatchGANDiscriminator: all shape tests passed")
