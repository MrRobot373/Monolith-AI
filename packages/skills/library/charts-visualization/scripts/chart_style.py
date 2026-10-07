"""Consistent, clean matplotlib styling for report and slide charts.

    from chart_style import apply_style, PALETTE, finish
    apply_style()
    fig, ax = plt.subplots(figsize=(8, 4.5))
    ...
    finish(fig, ax, title="Takeaway", subtitle="What is measured", source="Source: …", path="chart.png")
"""
from __future__ import annotations

import os

os.environ.setdefault("MPLCONFIGDIR", os.path.join(os.environ.get("TMPDIR", "/tmp"), "matplotlib"))
import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt  # noqa: E402

# Colorblind-safe (Okabe–Ito based), first color is the accent.
PALETTE = ["#0072B2", "#E69F00", "#009E73", "#D55E00", "#CC79A7", "#56B4E9", "#F0E442", "#6B7280"]
GREY = "#9CA3AF"
TEXT = "#111827"
MUTED = "#6B7280"


def apply_style():
    plt.rcParams.update(
        {
            "figure.dpi": 100,
            "savefig.dpi": 200,
            "font.size": 11,
            "font.family": "DejaVu Sans",
            "axes.edgecolor": "#D1D5DB",
            "axes.labelcolor": MUTED,
            "axes.titlesize": 14,
            "axes.titleweight": "bold",
            "axes.prop_cycle": matplotlib.cycler(color=PALETTE),
            "axes.spines.top": False,
            "axes.spines.right": False,
            "axes.grid": True,
            "axes.axisbelow": True,
            "grid.color": "#E5E7EB",
            "grid.linewidth": 0.8,
            "xtick.color": MUTED,
            "ytick.color": MUTED,
            "legend.frameon": False,
        }
    )


def finish(fig, ax, title: str, subtitle: str | None = None, source: str | None = None, path: str | None = None, grid_axis: str = "auto"):
    """Title/subtitle/source, light grid on the value axis only, tight layout, save."""
    horizontal = any(getattr(c, "orientation", None) == "horizontal" for c in getattr(ax, "containers", []))
    axis = ("x" if horizontal else "y") if grid_axis == "auto" else grid_axis
    ax.grid(False)
    if axis in ("x", "y"):
        ax.grid(True, axis=axis)
    ax.set_title("")
    fig.text(0.01, 0.985, title, ha="left", va="top", fontsize=14, fontweight="bold", color=TEXT)
    top = 0.91
    if subtitle:
        fig.text(0.01, 0.915, subtitle, ha="left", va="top", fontsize=10.5, color=MUTED)
        top = 0.87
    if source:
        fig.text(0.01, 0.01, source, ha="left", va="bottom", fontsize=8.5, color=GREY)
    fig.tight_layout(rect=(0, 0.04 if source else 0, 1, top))
    fig.subplots_adjust(top=top - 0.03)
    if path:
        fig.savefig(path, bbox_inches="tight", facecolor="white")
        plt.close(fig)
    return path
