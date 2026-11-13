"""Policy/value networks for the E2 architecture bake-off.

Every arm maps the same inputs — 13 board planes in the mover's frame and the four relative hands —
to a per-cell embedding `(B, 400, d)` plus a global vector `(B, d)`. The heads are shared:

- **policy**: for each candidate placement, mean and max of the cell embeddings under its footprint
  (v4.5's pooled-policy idea), plus a piece embedding, through a small MLP to one logit. The
  softmax runs over the search's candidate set.
- **value**: four `score − mean(others)` margins in relative seat order, in units of 20 squares.
- **ownership**: final owner of every cell (empty or one of four relative seats). Listed in the v4
  programme as an untried auxiliary; it gives the trunk a dense, low-noise signal per position.

Arms differ only in the trunk, so a difference between them is a difference in what the trunk can
see: a 3×3 conv stack's 7×7 receptive field, a deep residual stack with global pooling, or global
self-attention over patches or cells.

The `resnet2-*` arms (E5, "model v2") reuse the ResNet trunk with the mover's absolute seat added to
the global input and a larger head set (`Heads2`). Their `forward` takes the seat as a sixth argument
and returns a dict; `model_version` tells callers which interface an arm has, and `predict` hides the
difference for analysis code. The v1 classes and arms are unchanged, so old checkpoints load as before.
"""

from __future__ import annotations

import math

import numpy as np
import torch
import torch.nn as nn
import torch.nn.functional as F

from features import PAD_CELL

PLANES = 13
PIECES = 21


class Heads(nn.Module):
    def __init__(self, d: int, hidden: int = 128) -> None:
        super().__init__()
        self.piece = nn.Embedding(PIECES, 16)
        self.policy = nn.Sequential(nn.Linear(2 * d + 16, hidden), nn.GELU(), nn.Linear(hidden, 1))
        self.value = nn.Sequential(nn.Linear(d, hidden), nn.GELU(), nn.Linear(hidden, 4))
        self.ownership = nn.Linear(d, 5)

    def forward(self, cells: torch.Tensor, glob: torch.Tensor, footprint: torch.Tensor, pieces: torch.Tensor, mask: torch.Tensor):
        b, _, d = cells.shape
        padded = torch.cat([cells, cells.new_zeros(b, 1, d)], dim=1)  # index 400 is the pad cell
        gathered = padded.gather(1, footprint.view(b, -1, 1).expand(-1, -1, d)).view(b, footprint.shape[1], 5, d)
        real = (footprint != PAD_CELL).unsqueeze(-1).float()
        mean = (gathered * real).sum(2) / real.sum(2).clamp(min=1)
        maxed = torch.where(real.bool(), gathered, torch.full_like(gathered, -1e4)).amax(2)
        maxed = torch.where(mask.unsqueeze(-1), maxed, torch.zeros_like(maxed))
        logits = self.policy(torch.cat([mean, maxed, self.piece(pieces)], dim=-1)).squeeze(-1)
        logits = logits.masked_fill(~mask, -1e9)
        return logits, self.value(glob), self.ownership(cells)


def hand_vector(hands: torch.Tensor) -> torch.Tensor:
    return hands.flatten(1)  # (B, 84)


class ConvSmall(nn.Module):
    """v4.5-class trunk: three 3×3 convolutions at width 16 over the raw planes."""

    def __init__(self, width: int = 16) -> None:
        super().__init__()
        self.convs = nn.Sequential(
            nn.Conv2d(PLANES, width, 3, padding=1), nn.ReLU(),
            nn.Conv2d(width, width, 3, padding=1), nn.ReLU(),
            nn.Conv2d(width, width, 3, padding=1), nn.ReLU(),
        )
        self.glob = nn.Linear(2 * width + 84, width)
        self.heads = Heads(width, hidden=64)

    def forward(self, planes, hands, footprint, pieces, mask):
        x = self.convs(planes)
        cells = x.flatten(2).transpose(1, 2)
        glob = F.gelu(self.glob(torch.cat([x.mean((2, 3)), x.amax((2, 3)), hand_vector(hands)], 1)))
        return self.heads(cells, glob, footprint, pieces, mask)


class GlobalPoolBlock(nn.Module):
    """Residual block with KataGo-style global pooling bias, so every cell sees board-wide state."""

    def __init__(self, width: int) -> None:
        super().__init__()
        self.conv1 = nn.Conv2d(width, width, 3, padding=1, bias=False)
        self.norm1 = nn.BatchNorm2d(width)
        self.pool = nn.Linear(2 * width, width)
        self.conv2 = nn.Conv2d(width, width, 3, padding=1, bias=False)
        self.norm2 = nn.BatchNorm2d(width)

    def forward(self, x):
        y = F.relu(self.norm1(self.conv1(x)))
        bias = self.pool(torch.cat([y.mean((2, 3)), y.amax((2, 3))], 1))
        y = y + bias.view(*bias.shape, 1, 1)
        y = self.norm2(self.conv2(y))
        return F.relu(x + y)


class ResNet(nn.Module):
    def __init__(self, width: int = 96, blocks: int = 8) -> None:
        super().__init__()
        self.stem = nn.Sequential(nn.Conv2d(PLANES, width, 3, padding=1, bias=False), nn.BatchNorm2d(width), nn.ReLU())
        self.hands = nn.Linear(84, width)
        self.blocks = nn.Sequential(*[GlobalPoolBlock(width) for _ in range(blocks)])
        self.glob = nn.Linear(2 * width, width)
        self.heads = Heads(width)

    def forward(self, planes, hands, footprint, pieces, mask):
        x = self.stem(planes) + self.hands(hand_vector(hands)).view(planes.shape[0], -1, 1, 1)
        x = self.blocks(x)
        cells = x.flatten(2).transpose(1, 2)
        glob = F.gelu(self.glob(torch.cat([x.mean((2, 3)), x.amax((2, 3))], 1)))
        return self.heads(cells, glob, footprint, pieces, mask)


class Transformer(nn.Module):
    """Pre-LN encoder over board tokens (cells or 2×2 patches), 84 piece tokens and a global token.

    Piece tokens carry (relative seat, piece id, in-hand) so attention can relate a seat's remaining
    shapes to the space it controls — the interaction a per-cell conv can only approximate.
    """

    def __init__(self, d: int = 192, layers: int = 6, heads: int = 6, patch: int = 1) -> None:
        super().__init__()
        self.patch = patch
        side = 20 // patch
        self.tokens = side * side
        self.embed = nn.Linear(PLANES * patch * patch, d)
        self.position = nn.Parameter(torch.randn(1, self.tokens, d) * 0.02)
        self.piece_embed = nn.Embedding(4 * PIECES, d)
        self.in_hand = nn.Embedding(2, d)
        self.global_token = nn.Parameter(torch.zeros(1, 1, d))
        layer = nn.TransformerEncoderLayer(d, heads, 4 * d, dropout=0.0, activation="gelu", batch_first=True, norm_first=True)
        self.encoder = nn.TransformerEncoder(layer, layers, enable_nested_tensor=False)
        self.norm = nn.LayerNorm(d)
        # Patches are unfolded back to cells: patch token + a learned offset for the cell's place in
        # the patch + a direct projection of that cell's own planes.
        if patch > 1:
            self.offset = nn.Parameter(torch.zeros(1, patch * patch, d))
            self.cell_proj = nn.Linear(PLANES, d)
        self.heads = Heads(d)

    def forward(self, planes, hands, footprint, pieces, mask):
        b = planes.shape[0]
        p = self.patch
        if p == 1:
            board = planes.flatten(2).transpose(1, 2)
        else:
            board = F.unfold(planes, kernel_size=p, stride=p).transpose(1, 2)  # (B, tokens, 13·p·p)
        x = self.embed(board) + self.position
        ids = torch.arange(4 * PIECES, device=planes.device).view(1, -1).expand(b, -1)
        piece_tokens = self.piece_embed(ids) + self.in_hand(hands.flatten(1).long())
        x = torch.cat([self.global_token.expand(b, -1, -1), x, piece_tokens], dim=1)
        x = self.norm(self.encoder(x))
        glob, board_out = x[:, 0], x[:, 1 : 1 + self.tokens]
        if p == 1:
            cells = board_out
        else:
            side = 20 // p
            grid = board_out.view(b, side, side, 1, -1).expand(-1, -1, -1, p * p, -1)
            grid = grid + self.offset.view(1, 1, 1, p * p, -1)
            # (B, side, side, p·p, d) → cells in row-major board order.
            grid = grid.view(b, side, side, p, p, -1).permute(0, 1, 3, 2, 4, 5).reshape(b, 400, -1)
            cells = grid + self.cell_proj(planes.flatten(2).transpose(1, 2))
        return self.heads(cells, glob, footprint, pieces, mask)


UTILITY_KINDS = ("margin", "rank", "first")


class Heads2(nn.Module):
    """Model-v2 heads (E5). Same footprint pooling as `Heads`, with more outputs:

    - **policy / soft policy**: two logits per candidate from one MLP. The first is trained on the
      search's visit distribution, the second on that distribution raised to the 1/4 power and
      renormalised (KataGo's soft policy target), which keeps the ranking of low-mass moves.
    - **margins**: the four `score − mean(others)` margins in relative seat order, units of 20
      squares (as `Heads`).
    - **utility**: `(B, 4, 3)` logits per relative seat for [margin, rank, first]. `margin` and `rank`
      are probabilities through a sigmoid; `first` is a softmax across the four seats.
    - **search**: the mover's search `root_value` (logit(Q) · 12 squares), in units of 20 squares.
    - **ownership**: as `Heads`.
    """

    def __init__(self, d: int, hidden: int = 128, value_hidden: int = 256) -> None:
        super().__init__()
        self.piece = nn.Embedding(PIECES, 16)
        self.policy = nn.Sequential(nn.Linear(2 * d + 16, hidden), nn.GELU(), nn.Linear(hidden, 2))
        self.value = nn.Sequential(nn.Linear(d, value_hidden), nn.GELU(), nn.Linear(value_hidden, 4 + 12 + 1))
        self.ownership = nn.Linear(d, 5)

    def forward(self, cells, glob, footprint, pieces, mask) -> dict[str, torch.Tensor]:
        b, _, d = cells.shape
        padded = torch.cat([cells, cells.new_zeros(b, 1, d)], dim=1)
        gathered = padded.gather(1, footprint.view(b, -1, 1).expand(-1, -1, d)).view(b, footprint.shape[1], 5, d)
        real = (footprint != PAD_CELL).unsqueeze(-1).to(gathered.dtype)
        mean = (gathered * real).sum(2) / real.sum(2).clamp(min=1)
        maxed = torch.where(real.bool(), gathered, torch.full_like(gathered, -1e4)).amax(2)
        maxed = torch.where(mask.unsqueeze(-1), maxed, torch.zeros_like(maxed))
        both = self.policy(torch.cat([mean, maxed, self.piece(pieces)], dim=-1)).float()
        logits = both[..., 0].masked_fill(~mask, -1e9)
        soft = both[..., 1].masked_fill(~mask, -1e9)
        value = self.value(glob).float()
        return {
            "policy": logits,
            "soft": soft,
            "margins": value[:, :4],
            "utility": value[:, 4:16].view(b, 4, 3),
            "search": value[:, 16],
            "ownership": self.ownership(cells).float(),
        }


class ResNet2(nn.Module):
    """E5 model v2: the `ResNet` trunk with the mover's absolute seat in the global input and `Heads2`.

    `forward` takes one more argument than the v1 arms (`seat`, the mover's absolute seat 0..3) and
    returns a dict; callers tell the two apart by `version`.
    """

    version = 2

    def __init__(self, width: int = 96, blocks: int = 8) -> None:
        super().__init__()
        self.stem = nn.Sequential(nn.Conv2d(PLANES, width, 3, padding=1, bias=False), nn.BatchNorm2d(width), nn.ReLU())
        self.hands = nn.Linear(84 + 4, width)
        self.blocks = nn.Sequential(*[GlobalPoolBlock(width) for _ in range(blocks)])
        self.glob = nn.Linear(2 * width, width)
        self.heads = Heads2(width)

    def forward(self, planes, hands, footprint, pieces, mask, seat):
        seat_onehot = F.one_hot(seat.long(), 4).to(planes.dtype)
        x = self.stem(planes) + self.hands(torch.cat([hand_vector(hands), seat_onehot], 1)).view(planes.shape[0], -1, 1, 1)
        x = self.blocks(x)
        cells = x.flatten(2).transpose(1, 2)
        glob = F.gelu(self.glob(torch.cat([x.mean((2, 3)), x.amax((2, 3))], 1)))
        return self.heads(cells, glob, footprint, pieces, mask)


def utility_probabilities(utility_logits: torch.Tensor) -> torch.Tensor:
    """(B, 4, 3) logits → probabilities: sigmoid for margin and rank, softmax over seats for first."""
    out = torch.sigmoid(utility_logits)
    return torch.cat([out[..., :2], torch.softmax(utility_logits[..., 2], dim=1).unsqueeze(-1)], dim=-1)


ARMS = {
    "conv-small": lambda: ConvSmall(),
    "resnet": lambda: ResNet(),
    "vit-patch": lambda: Transformer(d=192, layers=6, heads=6, patch=2),
    "vit-patch-large": lambda: Transformer(d=256, layers=8, heads=8, patch=2),
    "vit-cell": lambda: Transformer(d=128, layers=6, heads=4, patch=1),
    "resnet2-b8w96": lambda: ResNet2(width=96, blocks=8),
    "resnet2-b12w128": lambda: ResNet2(width=128, blocks=12),
    "resnet2-b16w160": lambda: ResNet2(width=160, blocks=16),
}

V2_ARMS = frozenset(name for name in ARMS if name.startswith("resnet2-"))


def model_version(model: nn.Module) -> int:
    return getattr(model, "version", 1)


def load_checkpoint(path: str, dev: torch.device) -> tuple[nn.Module, str]:
    """The checkpoint's network in eval mode on `dev`, and its arm name."""
    checkpoint = torch.load(path, map_location=dev)
    model = ARMS[checkpoint["arm"]]().to(dev)
    model.load_state_dict(checkpoint["state"])
    model.eval()
    return model, checkpoint["arm"]


@torch.no_grad()
def predict(model: nn.Module, encoder, records, batch_size: int = 1024) -> dict:
    """Run any arm over records. Returns numpy arrays: `policy` (N,64) logits (0 on padding),
    `margins` (N,4) in squares, and for v2 arms `utility` (N,4,3) probabilities and `search` (N,)
    in squares."""
    out: dict[str, list] = {}
    for start in range(0, len(records), batch_size):
        chunk = records[start : start + batch_size]
        planes, hands = encoder.board(chunk)
        footprint, pieces, mask, _ = encoder.candidates(chunk)
        if model_version(model) == 2:
            seat = torch.tensor(chunk["seat"].astype("int64"), device=planes.device)
            o = model(planes, hands, footprint, pieces, mask, seat)
            parts = {
                "policy": o["policy"].masked_fill(~mask, 0),
                "margins": o["margins"] * 20.0,
                "utility": utility_probabilities(o["utility"]),
                "search": o["search"] * 20.0,
            }
        else:
            logits, value, _ = model(planes, hands, footprint, pieces, mask)
            parts = {"policy": logits.masked_fill(~mask, 0), "margins": value * 20.0}
        for key, value in parts.items():
            out.setdefault(key, []).append(value.float().cpu().numpy())
    return {key: np.concatenate(v) for key, v in out.items()}


def parameter_count(model: nn.Module) -> int:
    return sum(p.numel() for p in model.parameters())


def cosine(step: int, total: int, warmup: int) -> float:
    if step < warmup:
        return (step + 1) / warmup
    return 0.5 * (1 + math.cos(math.pi * min(1.0, (step - warmup) / max(1, total - warmup))))
