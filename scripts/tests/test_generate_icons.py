"""Guard for the icon pipeline — zoc-agent-chat-rebuild R18.3, R18.4, R18.5.

Three things are worth asserting mechanically, and they are the three a hand
check would get wrong:

1. The script's understanding of the mark matches the authored artwork. It parses
   the construction back out of `zoc-mark-mono.svg`, so a parser that quietly
   misreads the outline would regenerate the whole set from a shape nobody drew.
2. The small sizes are *hinted*, not resampled. Every raster is rendered at its
   own size, and at or below 24 px from a different geometry — which is only
   observable by comparing against the downsample it must not be.
3. The committed set is exactly what the script produces, and every path
   `tauri.conf.json` declares still resolves. Regeneration is a content change;
   this is what keeps that claim true.
"""

from __future__ import annotations

import json
import shutil
import sys
from pathlib import Path

import pytest

#: The pipeline's own two requirements are Pillow and an SVG rasteriser. Skipping
#: rather than failing keeps a Python environment that carries neither — the
#: workspace `.venv` is one — from reporting a red suite for a tool it was never
#: meant to run. `scripts/generate_icons.py --check` is the gate that must pass.
Image = pytest.importorskip("PIL.Image", reason="Pillow is required to read the emitted rasters")

SCRIPTS = Path(__file__).resolve().parents[1]
REPO_ROOT = SCRIPTS.parent
sys.path.insert(0, str(SCRIPTS))

import generate_icons as gi  # noqa: E402

HINTED_SIZES = (16, 20, 24)


@pytest.fixture(scope="module")
def geometry() -> gi.MarkGeometry:
    return gi.load_geometry(REPO_ROOT)


@pytest.fixture(scope="module")
def rasteriser(geometry: gi.MarkGeometry) -> gi.Rasteriser:
    return gi.Rasteriser(geometry)


def _scratch_tree(tmp_path: Path) -> Path:
    """A tree carrying only the script's inputs: the mark source and the config."""
    root = tmp_path / "tree"
    (root / gi.MARK_SOURCE).parent.mkdir(parents=True)
    (root / gi.TAURI_CONF).parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(REPO_ROOT / gi.MARK_SOURCE, root / gi.MARK_SOURCE)
    shutil.copy2(REPO_ROOT / gi.TAURI_CONF, root / gi.TAURI_CONF)
    return root


def _tree_bytes(root: Path) -> dict[str, bytes]:
    return {
        path.relative_to(root).as_posix(): path.read_bytes()
        for path in sorted(root.rglob("*"))
        if path.is_file()
    }


# --- 1. the script reads the artwork it was pointed at ----------------------


def test_geometry_round_trips_the_authored_path(geometry: gi.MarkGeometry) -> None:
    """Re-emitting the parsed construction reproduces the authored `d` exactly.

    The strongest available check that the parser understood the outline: any
    misread primitive changes at least one coordinate.
    """
    authored = gi._parse_path_d((REPO_ROOT / gi.MARK_SOURCE).read_text(encoding="utf-8"))
    assert geometry.path_data() == authored


def test_parsed_construction_matches_the_documented_values(geometry: gi.MarkGeometry) -> None:
    assert (geometry.view, geometry.box_x0, geometry.box_x1) == (24.0, 4.0, 20.0)
    assert (geometry.box_y0, geometry.box_y1) == (4.0, 20.0)
    assert geometry.bar == 3.0
    assert geometry.band == 4.5
    assert geometry.leg_run == 5.25
    assert 2.0 <= geometry.kink <= 3.0, "the design fixes the kink offset to [2.0, 3.0] u"


def test_favicon_svg_is_the_same_geometry_at_the_kink_bound(geometry: gi.MarkGeometry) -> None:
    """`favicon.svg` is authored, not generated, so its consistency with the mono
    source is a fact worth pinning rather than assuming."""
    favicon = gi._parse_path_d(
        (REPO_ROOT / gi.FRONTEND_PUBLIC / "favicon.svg").read_text(encoding="utf-8")
    )
    assert geometry.path_data(gi.HINTED_KINK_U) == favicon


def test_parser_refuses_a_construction_it_cannot_hint() -> None:
    with pytest.raises(ValueError, match="relative command"):
        gi._parse_polygon("M4 4h16v3Z")
    with pytest.raises(ValueError, match="15-point"):
        gi.MarkGeometry.parse('<svg viewBox="0 0 24 24"><path d="M4 4H20V7H4Z"/></svg>')


# --- 2. the small sizes are hinted, not resampled --------------------------


@pytest.mark.parametrize("size", HINTED_SIZES)
def test_hinted_frame_is_whole_pixels_throughout(geometry: gi.MarkGeometry, size: int) -> None:
    frame = geometry.hinted_frame(size)
    assert all(isinstance(value, int) for value in frame.values())
    assert frame["bar"] >= 2 and frame["band"] >= 2 and frame["kink"] >= 2
    assert frame["kink"] == max(2, gi._snap(gi.HINTED_KINK_U, size / geometry.view))
    assert frame["x0"] > 0 and frame["x1"] < size, "clear space survives the crop"
    # The leg keeps the authored angle to within a pixel of run.
    ideal = (
        geometry.leg_run
        * (frame["y_mid"] - frame["y_top"])
        / ((geometry.box_y1 - geometry.box_y0) / 2 - geometry.bar)
    )
    assert abs(frame["run"] - ideal) <= 0.5


@pytest.mark.parametrize("size", HINTED_SIZES)
def test_hinted_path_carries_no_fractional_coordinate(geometry: gi.MarkGeometry, size: int) -> None:
    assert "." not in geometry.hinted(size)


@pytest.mark.parametrize("size", HINTED_SIZES)
def test_hinted_render_is_not_a_downsample(rasteriser: gi.Rasteriser, size: int) -> None:
    """The hinted variant differs in *geometry*, so the gap against a resample of
    the 1024 px master is an order of magnitude above the failure floor."""
    rendered = rasteriser.image(gi.DESKTOP, size)
    resampled = gi.naive_downsample(rasteriser, gi.DESKTOP, size)
    drift = gi.mean_abs_difference(rendered, resampled)
    assert drift > gi.DOWNSAMPLE_DRIFT_FLOOR * 4, f"mean |Δ| only {drift:.2f} at {size}px"


@pytest.mark.parametrize(
    "relative_path,size",
    [
        ("apps/desktop/icons/16x16.png", 16),
        ("apps/desktop/icons/24x24.png", 24),
        ("apps/desktop/icons/ios/AppIcon-20x20@1x.png", 20),
    ],
)
def test_committed_small_icons_keep_crisp_terminals_and_a_visible_kink(
    geometry: gi.MarkGeometry, relative_path: str, size: int
) -> None:
    """R18.3's legibility gate, read off the shipped raster rather than a render."""
    path = REPO_ROOT / relative_path
    with Image.open(path) as opened:
        image = opened.convert("RGBA")
    assert image.size == (size, size)
    assert gi._verify_hinted(path, image, geometry, size) == []


# --- 3. the committed set is what the script produces ----------------------


def test_committed_set_passes_a_fresh_verification() -> None:
    """`--check` re-renders every size and compares: dimensions, hinting, ICO
    layers pixel for pixel, icns chunks byte for byte, and the declared paths."""
    assert gi.run(REPO_ROOT, check=True, quiet=True) == 0


def test_generation_is_reproducible_and_matches_the_committed_bytes(tmp_path: Path) -> None:
    first = _scratch_tree(tmp_path / "a")
    second = _scratch_tree(tmp_path / "b")
    assert gi.run(first, check=False, quiet=True) == 0
    assert gi.run(second, check=False, quiet=True) == 0
    assert _tree_bytes(first) == _tree_bytes(second)

    for relative, payload in _tree_bytes(first).items():
        if relative.endswith(".svg") or relative.endswith("tauri.conf.json"):
            continue
        committed = REPO_ROOT / relative
        assert committed.exists(), f"{relative} is generated but not committed"
        assert committed.read_bytes() == payload, f"{relative} differs from a fresh render"


def test_no_artwork_is_overwritten(tmp_path: Path) -> None:
    """The four brand variants and `favicon.svg` are authored, not generated."""
    root = _scratch_tree(tmp_path)
    before = (root / gi.MARK_SOURCE).read_bytes()
    assert gi.run(root, check=False, quiet=True) == 0
    assert (root / gi.MARK_SOURCE).read_bytes() == before
    written_svgs = [p for p in root.rglob("*.svg") if p != root / gi.MARK_SOURCE]
    assert written_svgs == []


def test_tauri_declared_icons_all_resolve() -> None:
    conf = json.loads((REPO_ROOT / gi.TAURI_CONF).read_text(encoding="utf-8"))
    declared = conf["bundle"]["icon"]
    assert declared, "bundle.icon is the release pipeline's only icon input"
    for entry in declared:
        target = REPO_ROOT / "apps" / "desktop" / entry
        assert target.is_file() and target.stat().st_size > 0, f"{entry} does not resolve"
    assert gi._verify_tauri_conf(REPO_ROOT) == []


def test_flat_png_set_covers_nineteen_distinct_sizes() -> None:
    distinct = {size for name, size in gi.FLAT_PNGS.items() if name != gi.STORE_LOGO}
    assert len(distinct) == gi.EXPECTED_DISTINCT_SIZES


def test_ico_containers_carry_every_declared_layer() -> None:
    assert tuple(sorted(gi.read_ico_layers(REPO_ROOT / gi.DESKTOP_ICONS / "icon.ico"))) == tuple(
        sorted(gi.ICO_LAYERS)
    )
    assert tuple(
        sorted(gi.read_ico_layers(REPO_ROOT / gi.FRONTEND_PUBLIC / "favicon.ico"))
    ) == tuple(sorted(gi.FAVICON_LAYERS))


def test_icns_carries_a_png_chunk_per_declared_size() -> None:
    chunks = gi.read_icns((REPO_ROOT / gi.DESKTOP_ICONS / "icon.icns").read_bytes())
    assert [(ostype, size) for ostype, size, _ in chunks] == list(gi.ICNS_CHUNKS)
    assert min(size for _, size, _ in chunks) == 16
    assert max(size for _, size, _ in chunks) == 1024


def test_every_android_density_and_ios_slot_is_present() -> None:
    for density, (launcher, foreground) in gi.ANDROID_DENSITIES.items():
        folder = REPO_ROOT / gi.DESKTOP_ICONS / "android" / f"mipmap-{density}"
        for name, expected in (
            ("ic_launcher.png", launcher),
            ("ic_launcher_round.png", launcher),
            ("ic_launcher_foreground.png", foreground),
        ):
            with Image.open(folder / name) as image:
                assert image.size == (expected, expected), f"{density}/{name}"
    for name, expected in gi.IOS_ICONS.items():
        with Image.open(REPO_ROOT / gi.DESKTOP_ICONS / "ios" / name) as image:
            assert image.size == (expected, expected), name
