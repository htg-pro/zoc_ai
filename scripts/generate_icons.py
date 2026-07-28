#!/usr/bin/env python3
"""Application icon regeneration — zoc-agent-chat-rebuild R18.4, R18.5.

One script, one vector source, the whole icon set. `apps/desktop/icons` and
`apps/frontend/public/favicon.ico` are *outputs*: regeneration is reproducible
and reviewable in a diff, which is the only way R18.4's "regenerate the complete
set" stays true after the first hand-edit.

Source of truth
---------------
`apps/frontend/public/brand/zoc-mark-mono.svg` — the monochrome variant, chosen
because the geometry carries the identity and the gradient is decoration. The
script does not read the gradient mark, and it never writes any `.svg`: the four
brand variants are authored artwork, not generated artefacts.

The mark's construction parameters are *parsed back out* of that file rather than
restated here, so an adjustment to the authored geometry (the design permits the
kink offset to move within `[2.0, 3.0] u`) propagates through the whole set
instead of silently disagreeing with a copy in this script.

Per-size rendering, not downsampling
------------------------------------
Every raster is rasterised from vector at its own pixel size. Nothing is
`Image.resize`d from a larger render, so no icon is a resample of another. That
matters most at the small end, where the design calls for a *different geometry*
rather than a smaller one:

  At and below 24 px the script substitutes a **hinted variant** — the kink at
  its 3.0 u upper bound, and every edge coordinate snapped to a whole pixel at
  that target size. Scaling the authored 2.5 u kink to 16 px lands it on a
  half-pixel and the break blurs into the band, which is exactly the detail
  R18.3's 16 px legibility gate is about. Snapping is done on the construction
  primitives (box, bar, band, kink, leg run) and the points are then derived, so
  the shape stays self-consistent instead of drifting one edge at a time.

Colour
------
Rasters are filled with `#9b6af1`, the literal value of `--zoc-agent-strong`, on
a transparent ground. The mono source inherits `currentColor`, which is exactly
what a rasteriser has no document to resolve from — the same reason `favicon.svg`
carries the literal. This violet holds against a light and a dark shelf alike.

Inventory
---------
`apps/desktop/icons/`
  * flat PNGs at **19 distinct pixel sizes** — the ten icon sizes (16, 24, 32,
    48, 64, 96, 128, 256, 512, 1024, including `128x128@2x.png` at 256 and
    `icon.png` at 512) plus the nine Windows tile sizes — and `StoreLogo.png`
    at 50, which the design lists on its own line.
  * `icon.ico` — 16, 24, 32, 48, 64, 256 layered, each layer its own render.
  * `icon.icns` — PNG-payload chunks from 16 through 1024.
  * `android/mipmap-{l,m,h,xh,xxh,xxxh}dpi/` — six densities: launcher, round
    launcher, and the 108 dp adaptive foreground. The mark's 4 u clear space
    puts it at 66.7% of the canvas, which lands inside the 72 dp safe zone with
    no extra inset.
  * `ios/AppIcon-*.png` — the Xcode AppIcon set.
`apps/frontend/public/`
  * `favicon.ico` — 16, 32, 48, all from the 3.0 u kink geometry per the design's
    favicon note, so the browser tab and the packaged app show the same mark.

`tauri.conf.json`'s `bundle.icon` array is deliberately **not** touched: it
already lists `32x32.png`, `128x128.png`, `128x128@2x.png`, `icon.icns`, and
`icon.ico`, so regeneration is a content change and the release pipeline is
untouched. `--check` asserts every one of those declared paths resolves.

Usage
-----
    python3 scripts/generate_icons.py              # regenerate in place
    python3 scripts/generate_icons.py --check      # verify only, write nothing
    python3 scripts/generate_icons.py --out-root T # generate into a scratch tree
"""

from __future__ import annotations

import argparse
import io
import json
import re
import shutil
import struct
import subprocess
import sys
from dataclasses import dataclass
from decimal import ROUND_HALF_UP, Decimal
from pathlib import Path

try:
    from PIL import Image, ImageChops, ImageDraw
except ModuleNotFoundError:  # pragma: no cover - environment guard
    print(
        "❌ Pillow is required: pip install --user Pillow",
        file=sys.stderr,
    )
    raise

REPO_ROOT = Path(__file__).resolve().parents[1]

MARK_SOURCE = Path("apps/frontend/public/brand/zoc-mark-mono.svg")
DESKTOP_ICONS = Path("apps/desktop/icons")
FRONTEND_PUBLIC = Path("apps/frontend/public")
TAURI_CONF = Path("apps/desktop/tauri.conf.json")

#: `--zoc-agent-strong`. The same literal `favicon.svg` carries, and for the same
#: reason: a rasteriser has no document for `currentColor` to inherit from.
BRAND_FILL = "#9b6af1"

#: At or below this size the hinted variant is substituted (design: "at and below
#: 24 px").
HINT_MAX_PX = 24

#: The kink offset's permitted upper bound, used by the hinted variant and by the
#: whole favicon family.
HINTED_KINK_U = 3.0

#: Flat PNGs in `apps/desktop/icons`. Every entry is rendered at its own size.
FLAT_PNGS: dict[str, int] = {
    "16x16.png": 16,
    "24x24.png": 24,
    "32x32.png": 32,
    "48x48.png": 48,
    "64x64.png": 64,
    "96x96.png": 96,
    "128x128.png": 128,
    "128x128@2x.png": 256,
    "256x256.png": 256,
    "512x512.png": 512,
    "1024x1024.png": 1024,
    "icon.png": 512,
    "Square30x30Logo.png": 30,
    "Square44x44Logo.png": 44,
    "Square71x71Logo.png": 71,
    "Square89x89Logo.png": 89,
    "Square107x107Logo.png": 107,
    "Square142x142Logo.png": 142,
    "Square150x150Logo.png": 150,
    "Square284x284Logo.png": 284,
    "Square310x310Logo.png": 310,
    "StoreLogo.png": 50,
}

#: `StoreLogo.png` sits on its own line in the design's tree; the remaining flat
#: PNGs cover exactly 19 distinct pixel sizes, which is the "19 PNG sizes" the
#: requirement names. Asserted in `verify()` so the claim stays a claim.
STORE_LOGO = "StoreLogo.png"
EXPECTED_DISTINCT_SIZES = 19

#: Six Android densities: (launcher px, adaptive foreground px). The foreground
#: is 2.25x the launcher on every density — 108 dp against 48 dp at mdpi.
ANDROID_DENSITIES: dict[str, tuple[int, int]] = {
    "ldpi": (36, 81),
    "mdpi": (48, 108),
    "hdpi": (72, 162),
    "xhdpi": (96, 216),
    "xxhdpi": (144, 324),
    "xxxhdpi": (192, 432),
}

ANDROID_ADAPTIVE_XML = """<?xml version="1.0" encoding="utf-8"?>
<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">
  <foreground android:drawable="@mipmap/ic_launcher_foreground"/>
  <background android:drawable="@color/ic_launcher_background"/>
</adaptive-icon>"""

ANDROID_BACKGROUND_XML = """<?xml version="1.0" encoding="utf-8"?>
<resources>
  <color name="ic_launcher_background">#fff</color>
</resources>"""

#: The Xcode AppIcon set, filename to rendered pixel size.
IOS_ICONS: dict[str, int] = {
    "AppIcon-20x20@1x.png": 20,
    "AppIcon-20x20@2x.png": 40,
    "AppIcon-20x20@2x-1.png": 40,
    "AppIcon-20x20@3x.png": 60,
    "AppIcon-29x29@1x.png": 29,
    "AppIcon-29x29@2x.png": 58,
    "AppIcon-29x29@2x-1.png": 58,
    "AppIcon-29x29@3x.png": 87,
    "AppIcon-40x40@1x.png": 40,
    "AppIcon-40x40@2x.png": 80,
    "AppIcon-40x40@2x-1.png": 80,
    "AppIcon-40x40@3x.png": 120,
    "AppIcon-60x60@2x.png": 120,
    "AppIcon-60x60@3x.png": 180,
    "AppIcon-76x76@1x.png": 76,
    "AppIcon-76x76@2x.png": 152,
    "AppIcon-83.5x83.5@2x.png": 167,
    "AppIcon-512@2x.png": 1024,
}

#: Windows executable and installer icon. Matches the layer set already shipped.
ICO_LAYERS: tuple[int, ...] = (16, 24, 32, 48, 64, 256)

#: `favicon.ico`, per R18.5.
FAVICON_LAYERS: tuple[int, ...] = (16, 32, 48)

#: macOS icon family. PNG payloads only: the target is macOS 11+, which reads
#: them, and the classic `is32`/`il32` mask pairs are Mac OS 9-era formats whose
#: only effect here would be to triple the file for no renderer that exists.
ICNS_CHUNKS: tuple[tuple[str, int], ...] = (
    ("icp4", 16),
    ("icp5", 32),
    ("icp6", 64),
    ("ic07", 128),
    ("ic08", 256),
    ("ic09", 512),
    ("ic10", 1024),
    ("ic11", 32),
    ("ic12", 64),
    ("ic13", 256),
    ("ic14", 512),
)

DESKTOP = "desktop"
FAVICON = "favicon"


# ---------------------------------------------------------------------------
# Geometry
# ---------------------------------------------------------------------------


def _fmt(value: float) -> str:
    """Format a coordinate the way the authored SVGs do: no trailing zeros."""
    text = f"{value:.4f}".rstrip("0").rstrip(".")
    return "0" if text in ("", "-0") else text


def _snap(value: float, scale: float) -> int:
    """Round a design-unit coordinate to a whole pixel, half away from zero."""
    return int(Decimal(str(value * scale)).quantize(Decimal(1), rounding=ROUND_HALF_UP))


_PATH_TOKEN = re.compile(r"([MHVLZmhvlz])|(-?\d*\.?\d+)")


@dataclass(frozen=True)
class MarkGeometry:
    """The mark's construction primitives, parsed out of the mono SVG.

    `view` is the viewBox extent (24). Everything else is in design units, where
    1 u = 1 viewBox px.
    """

    view: float
    box_x0: float
    box_x1: float
    box_y0: float
    box_y1: float
    bar: float
    band: float
    leg_run: float
    kink: float

    # -- parsing ----------------------------------------------------------

    @classmethod
    def parse(cls, svg_text: str) -> MarkGeometry:
        view = _parse_viewbox(svg_text)
        points = _parse_polygon(_parse_path_d(svg_text))
        if len(points) != 15:
            raise ValueError(f"expected the 15-point Z-spark outline, read {len(points)} points")

        (
            p0,
            p1,
            p2,
            b,
            c,
            d,
            p6,
            p7,
            p8,
            p9,
            e,
            f,
            g,
            hp,
            p14,
        ) = points

        box_x0, box_y0 = p0
        box_x1 = p1[0]
        y_top = p2[1]
        y_mid = b[1]
        y_bot = d[1]
        box_y1 = p7[1]

        bar = y_top - box_y0
        band = box_x1 - hp[0]
        leg_run = box_x1 - b[0]
        kink = c[0] - b[0]

        problems: list[str] = []
        if not (p1[1] == box_y0 and p2[0] == box_x1):
            problems.append("top bar is not the optical box's full width")
        if not (p6 == (box_x1, y_bot) and p7[0] == box_x1):
            problems.append("bottom bar does not close against the box's right edge")
        if not (p8 == (box_x0, box_y1) and p9 == (box_x0, y_bot)):
            problems.append("bottom bar does not close against the box's left edge")
        if p14 != (box_x0, y_top):
            problems.append("return edge does not close against the top bar")
        if abs((box_y1 - y_bot) - bar) > 1e-9:
            problems.append("terminal bars differ in height")
        if abs((y_top + y_bot) / 2 - y_mid) > 1e-9:
            problems.append("the kink is not on the optical centre line")
        for label, measured in (
            ("y_mid upper", b[0] - g[0]),
            ("y_mid lower", c[0] - f[0]),
            ("y_bot", d[0] - e[0]),
        ):
            if abs(measured - band) > 1e-9:
                problems.append(f"band width at {label} is {measured}, not {band}")
        if abs((c[0] - d[0]) - leg_run) > 1e-9:
            problems.append("the two diagonal legs have different runs")
        if abs((f[0] - g[0]) - kink) > 1e-9:
            problems.append("the kink step differs on the two edges")
        if problems:
            raise ValueError(
                "mark geometry is not the documented construction: " + "; ".join(problems)
            )

        return cls(
            view=view,
            box_x0=box_x0,
            box_x1=box_x1,
            box_y0=box_y0,
            box_y1=box_y1,
            bar=bar,
            band=band,
            leg_run=leg_run,
            kink=kink,
        )

    # -- emission ---------------------------------------------------------

    def path_data(self, kink: float | None = None) -> str:
        """The authored-scale outline, optionally with a different kink offset."""
        k = self.kink if kink is None else kink
        x0, x1 = self.box_x0, self.box_x1
        y0, y1 = self.box_y0, self.box_y1
        y_top = y0 + self.bar
        y_bot = y1 - self.bar
        y_mid = (y_top + y_bot) / 2
        b_x = x1 - self.leg_run
        c_x = b_x + k
        d_x = c_x - self.leg_run
        return _outline(
            x0=x0,
            x1=x1,
            y0=y0,
            y1=y1,
            y_top=y_top,
            y_mid=y_mid,
            y_bot=y_bot,
            b_x=b_x,
            c_x=c_x,
            d_x=d_x,
            e_x=d_x - self.band,
            f_x=c_x - self.band,
            g_x=b_x - self.band,
            hp_x=x1 - self.band,
            fmt=_fmt,
        )

    def hinted_frame(self, size: int) -> dict[str, int]:
        """The hinted construction at `size`, in whole pixels.

        Snapping is applied to the *primitives* and the points are derived from
        them. Rounding each of the fifteen points independently is the obvious
        alternative and it is wrong: at 20 px it yields a band 3 px wide on one
        leg and 4 px on the other, which reads as a drawing error rather than as
        a smaller mark.

        The leg run is the one primitive not snapped from its own design value.
        It is scaled against the *snapped* vertical half-run instead, because the
        bar height rounds before it does: at 16 px the direct scaling gives a 4 px
        run against a 3 px drop, which flattens a 43° diagonal to 53° — visible
        at a glance next to the 24 px original.
        """
        scale = size / self.view
        x0 = _snap(self.box_x0, scale)
        x1 = _snap(self.box_x1, scale)
        y0 = _snap(self.box_y0, scale)
        y1 = _snap(self.box_y1, scale)
        bar = max(2, _snap(self.bar, scale))
        band = max(2, _snap(self.band, scale))
        kink = max(2, _snap(HINTED_KINK_U, scale))

        y_top = y0 + bar
        y_bot = y1 - bar
        y_mid = _snap((self.box_y0 + self.box_y1) / 2, scale)

        leg_drop_u = (self.box_y1 - self.box_y0) / 2 - self.bar
        leg_drop_px = y_mid - y_top
        run = max(2, _snap(self.leg_run, leg_drop_px / leg_drop_u))

        b_x = x1 - run
        c_x = b_x + kink
        d_x = c_x - run
        frame = {
            "size": size,
            "x0": x0,
            "x1": x1,
            "y0": y0,
            "y1": y1,
            "bar": bar,
            "band": band,
            "kink": kink,
            "run": run,
            "y_top": y_top,
            "y_mid": y_mid,
            "y_bot": y_bot,
            "b_x": b_x,
            "c_x": c_x,
            "d_x": d_x,
            "e_x": d_x - band,
            "f_x": c_x - band,
            "g_x": b_x - band,
            "hp_x": x1 - band,
        }

        problems: list[str] = []
        if not 0 < x0 < x1 < size:
            problems.append("the optical box lost its clear space")
        if not y0 < y_top < y_mid < y_bot < y1:
            problems.append("the bars and the centre line collapsed")
        if band < 2 or kink < 2 or bar < 2:
            problems.append("band, kink, or bar fell below 2 px")
        if not (x0 < frame["e_x"] and c_x <= x1 and frame["g_x"] > x0):
            problems.append("the diagonal ran outside the optical box")
        if problems:
            raise ValueError(f"hinted geometry at {size}px is not legible: " + "; ".join(problems))
        return frame

    def hinted(self, size: int) -> str:
        """The hinted outline for `size`, in a `0 0 size size` pixel space."""
        frame = self.hinted_frame(size)
        return _outline(
            x0=frame["x0"],
            x1=frame["x1"],
            y0=frame["y0"],
            y1=frame["y1"],
            y_top=frame["y_top"],
            y_mid=frame["y_mid"],
            y_bot=frame["y_bot"],
            b_x=frame["b_x"],
            c_x=frame["c_x"],
            d_x=frame["d_x"],
            e_x=frame["e_x"],
            f_x=frame["f_x"],
            g_x=frame["g_x"],
            hp_x=frame["hp_x"],
            fmt=lambda v: str(int(v)),
        )


def _outline(
    *,
    x0: float,
    x1: float,
    y0: float,
    y1: float,
    y_top: float,
    y_mid: float,
    y_bot: float,
    b_x: float,
    c_x: float,
    d_x: float,
    e_x: float,
    f_x: float,
    g_x: float,
    hp_x: float,
    fmt,
) -> str:
    """One closed subpath, non-zero winding, no curves — as authored."""
    return (
        f"M{fmt(x0)} {fmt(y0)}"
        f"H{fmt(x1)}"
        f"V{fmt(y_top)}"
        f"L{fmt(b_x)} {fmt(y_mid)}"
        f"H{fmt(c_x)}"
        f"L{fmt(d_x)} {fmt(y_bot)}"
        f"H{fmt(x1)}"
        f"V{fmt(y1)}"
        f"H{fmt(x0)}"
        f"V{fmt(y_bot)}"
        f"H{fmt(e_x)}"
        f"L{fmt(f_x)} {fmt(y_mid)}"
        f"H{fmt(g_x)}"
        f"L{fmt(hp_x)} {fmt(y_top)}"
        f"H{fmt(x0)}"
        "Z"
    )


def _parse_viewbox(svg_text: str) -> float:
    match = re.search(r'viewBox\s*=\s*"([^"]+)"', svg_text)
    if not match:
        raise ValueError("the mark source carries no viewBox")
    parts = [float(p) for p in match.group(1).replace(",", " ").split()]
    if len(parts) != 4 or parts[0] != 0 or parts[1] != 0 or parts[2] != parts[3]:
        raise ValueError(f"expected a square viewBox at the origin, read {match.group(1)!r}")
    return parts[2]


def _parse_path_d(svg_text: str) -> str:
    matches = re.findall(r'\bd\s*=\s*"([^"]+)"', svg_text)
    if len(matches) != 1:
        raise ValueError(f"expected exactly one path in the mark source, found {len(matches)}")
    return matches[0]


def _parse_polygon(d: str) -> list[tuple[float, float]]:
    """Walk an absolute M/H/V/L/Z chain into its point list.

    Deliberately strict: a relative command or a curve raises rather than being
    approximated, because the pipeline's hinting is only meaningful against the
    documented construction, and a silent misparse would ship a blurred icon.
    """
    tokens = _PATH_TOKEN.findall(d)
    points: list[tuple[float, float]] = []
    x = y = 0.0
    command = ""
    numbers: list[float] = []

    def flush() -> None:
        nonlocal x, y, numbers
        if not numbers:
            return
        if command == "M" or command == "L":
            if len(numbers) % 2:
                raise ValueError(f"{command} takes coordinate pairs, got {numbers}")
            for i in range(0, len(numbers), 2):
                x, y = numbers[i], numbers[i + 1]
                points.append((x, y))
        elif command == "H":
            for value in numbers:
                x = value
                points.append((x, y))
        elif command == "V":
            for value in numbers:
                y = value
                points.append((x, y))
        numbers = []

    for letter, number in tokens:
        if letter:
            flush()
            if letter.islower():
                raise ValueError(f"relative command {letter!r} is not supported")
            command = letter
            if command == "Z":
                continue
        else:
            numbers.append(float(number))
    flush()
    return points


# ---------------------------------------------------------------------------
# Rasterisation
# ---------------------------------------------------------------------------


def _svg_document(path_data: str, view: float, size: int) -> str:
    view_text = _fmt(view)
    return (
        '<svg xmlns="http://www.w3.org/2000/svg" '
        f'viewBox="0 0 {view_text} {view_text}" width="{size}" height="{size}">'
        f'<path fill="{BRAND_FILL}" fill-rule="nonzero" d="{path_data}"/>'
        "</svg>"
    )


class Rasteriser:
    """Renders one SVG document per pixel size, and caches by (variant, size).

    The cache is what makes "the same size is rendered once" true without ever
    resizing: two consumers of 256 px — `128x128@2x.png` and the `ic08` icns
    chunk — share one *vector* render rather than one of them resampling the
    other.
    """

    def __init__(self, geometry: MarkGeometry) -> None:
        self.geometry = geometry
        self._tool = _resolve_rasteriser()
        self._cache: dict[tuple[str, int], bytes] = {}
        self.sources: dict[tuple[str, int], str] = {}

    def png(self, variant: str, size: int) -> bytes:
        key = (variant, size)
        cached = self._cache.get(key)
        if cached is not None:
            return cached

        if size <= HINT_MAX_PX:
            document = _svg_document(self.geometry.hinted(size), float(size), size)
            source = f"hinted {size}u"
        elif variant == FAVICON:
            document = _svg_document(
                self.geometry.path_data(HINTED_KINK_U), self.geometry.view, size
            )
            source = f"kink {_fmt(HINTED_KINK_U)}u"
        else:
            document = _svg_document(self.geometry.path_data(), self.geometry.view, size)
            source = f"kink {_fmt(self.geometry.kink)}u"

        data = self._run(document, size)
        with Image.open(io.BytesIO(data)) as image:
            if image.size != (size, size):
                raise RuntimeError(f"rasteriser produced {image.size} for a {size}px request")
        self._cache[key] = data
        self.sources[key] = source
        return data

    def image(self, variant: str, size: int) -> Image.Image:
        with Image.open(io.BytesIO(self.png(variant, size))) as image:
            return image.convert("RGBA")

    def _run(self, document: str, size: int) -> bytes:
        name, argv = self._tool
        command = [part.format(size=size) for part in argv]
        result = subprocess.run(
            command,
            input=document.encode("utf-8"),
            capture_output=True,
            check=False,
        )
        if result.returncode != 0 or not result.stdout:
            raise RuntimeError(
                f"{name} failed at {size}px (exit {result.returncode}): "
                f"{result.stderr.decode('utf-8', 'replace').strip()}"
            )
        return result.stdout


def _resolve_rasteriser() -> tuple[str, list[str]]:
    """Pick an SVG rasteriser. No rasteriser-specific hinting flags are used —
    the hinting lives in the geometry, so the emitted set does not depend on
    which of these is installed."""
    if shutil.which("rsvg-convert"):
        return "rsvg-convert", [
            "rsvg-convert",
            "--width={size}",
            "--height={size}",
            "--format=png",
            "--background-color=none",
        ]
    if shutil.which("resvg"):
        return "resvg", [
            "resvg",
            "--width={size}",
            "--height={size}",
            "-",
            "-c",
        ]
    if shutil.which("magick"):
        return "magick", [
            "magick",
            "-background",
            "none",
            "-density",
            "1200",
            "svg:-",
            "-resize",
            "{size}x{size}",
            "png32:-",
        ]
    raise RuntimeError(
        "no SVG rasteriser found: install rsvg-convert (librsvg), resvg, or ImageMagick"
    )


# ---------------------------------------------------------------------------
# Containers
# ---------------------------------------------------------------------------

_PNG_MAGIC = b"\x89PNG\r\n\x1a\n"


def build_icns(rasteriser: Rasteriser) -> bytes:
    body = bytearray()
    for ostype, size in ICNS_CHUNKS:
        payload = rasteriser.png(DESKTOP, size)
        body += struct.pack(">4sI", ostype.encode("ascii"), len(payload) + 8)
        body += payload
    return struct.pack(">4sI", b"icns", len(body) + 8) + bytes(body)


def read_icns(data: bytes) -> list[tuple[str, int, bytes]]:
    magic, declared = struct.unpack(">4sI", data[:8])
    if magic != b"icns":
        raise ValueError("not an icns container")
    if declared != len(data):
        raise ValueError(f"icns declares {declared} bytes, file is {len(data)}")
    chunks: list[tuple[str, int, bytes]] = []
    offset = 8
    while offset + 8 <= len(data):
        ostype, length = struct.unpack(">4sI", data[offset : offset + 8])
        if length < 8 or offset + length > len(data):
            raise ValueError(f"icns chunk {ostype!r} has an impossible length {length}")
        payload = data[offset + 8 : offset + length]
        if payload[:8] != _PNG_MAGIC:
            raise ValueError(f"icns chunk {ostype!r} is not a PNG payload")
        with Image.open(io.BytesIO(payload)) as image:
            width, height = image.size
        if width != height:
            raise ValueError(f"icns chunk {ostype!r} is not square")
        chunks.append((ostype.decode("ascii"), width, payload))
        offset += length
    return chunks


def write_ico(path: Path, images: list[Image.Image]) -> None:
    """Write a multi-layer ICO whose every layer is its own render.

    Pillow picks a provided frame whose size matches exactly and only resizes
    when none does, so passing every layer is what keeps the 16 px hinted variant
    out of the resampler.

    The **largest** layer has to be the one `save` is called on: Pillow silently
    drops any requested size larger than the base image, so calling it on the
    16 px frame writes a single-layer ICO and reports success.
    """
    ordered = sorted(images, key=lambda image: image.size[0], reverse=True)
    path.parent.mkdir(parents=True, exist_ok=True)
    ordered[0].save(
        path,
        format="ICO",
        sizes=[image.size for image in ordered],
        append_images=ordered[1:],
    )


def read_ico_layers(path: Path) -> dict[int, Image.Image]:
    layers: dict[int, Image.Image] = {}
    with Image.open(path) as container:
        for width, height in sorted(container.ico.sizes()):
            if width != height:
                raise ValueError(f"{path.name} carries a non-square {width}x{height} layer")
            layers[width] = container.ico.getimage((width, height)).convert("RGBA")
    return layers


def circle_masked(png: bytes) -> bytes:
    """Android's `_round` variant: the same render, clipped to the circle.

    With a transparent ground the mask currently clips nothing — the optical box's
    corners sit at 11.3 u from centre and the inscribed circle is at 12 u — so the
    round and square launcher icons are byte-identical today. The mask is applied
    anyway because it is what the filename means, and because it is what would
    have to be right the day the artwork gains a background.
    """
    with Image.open(io.BytesIO(png)) as opened:
        image = opened.convert("RGBA")
    mask = Image.new("L", image.size, 0)
    ImageDraw.Draw(mask).ellipse((0, 0, image.width - 1, image.height - 1), fill=255)
    out = Image.new("RGBA", image.size, (0, 0, 0, 0))
    out.paste(image, (0, 0), mask)
    buffer = io.BytesIO()
    out.save(buffer, format="PNG", optimize=True)
    return buffer.getvalue()


# ---------------------------------------------------------------------------
# Emission
# ---------------------------------------------------------------------------


@dataclass
class Emitted:
    path: Path
    kind: str
    variant: str
    size: int | None = None
    layers: tuple[int, ...] | None = None
    source: str = ""
    bytes_written: int = 0


def plan_and_write(root: Path, rasteriser: Rasteriser, *, write: bool) -> list[Emitted]:
    icons = root / DESKTOP_ICONS
    public = root / FRONTEND_PUBLIC
    records: list[Emitted] = []

    def put_png(path: Path, variant: str, size: int, data: bytes | None = None) -> None:
        payload = rasteriser.png(variant, size) if data is None else data
        if write:
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(payload)
        records.append(
            Emitted(
                path=path,
                kind="png",
                variant=variant,
                size=size,
                source=rasteriser.sources[(variant, size)],
                bytes_written=len(payload),
            )
        )

    for name, size in FLAT_PNGS.items():
        put_png(icons / name, DESKTOP, size)

    for density, (launcher, foreground) in ANDROID_DENSITIES.items():
        folder = icons / "android" / f"mipmap-{density}"
        put_png(folder / "ic_launcher.png", DESKTOP, launcher)
        put_png(
            folder / "ic_launcher_round.png",
            DESKTOP,
            launcher,
            circle_masked(rasteriser.png(DESKTOP, launcher)),
        )
        put_png(folder / "ic_launcher_foreground.png", DESKTOP, foreground)

    for name, size in IOS_ICONS.items():
        put_png(icons / "ios" / name, DESKTOP, size)

    ico_images = [rasteriser.image(DESKTOP, size) for size in ICO_LAYERS]
    if write:
        write_ico(icons / "icon.ico", ico_images)
    records.append(
        Emitted(
            path=icons / "icon.ico",
            kind="ico",
            variant=DESKTOP,
            layers=ICO_LAYERS,
            source="one render per layer",
            bytes_written=(icons / "icon.ico").stat().st_size if write else 0,
        )
    )

    icns = build_icns(rasteriser)
    if write:
        (icons / "icon.icns").write_bytes(icns)
    records.append(
        Emitted(
            path=icons / "icon.icns",
            kind="icns",
            variant=DESKTOP,
            layers=tuple(size for _, size in ICNS_CHUNKS),
            source="one render per chunk",
            bytes_written=len(icns),
        )
    )

    favicon_images = [rasteriser.image(FAVICON, size) for size in FAVICON_LAYERS]
    if write:
        write_ico(public / "favicon.ico", favicon_images)
    records.append(
        Emitted(
            path=public / "favicon.ico",
            kind="ico",
            variant=FAVICON,
            layers=FAVICON_LAYERS,
            source="one render per layer",
            bytes_written=(public / "favicon.ico").stat().st_size if write else 0,
        )
    )

    if write:
        _write_if_absent(
            icons / "android" / "mipmap-anydpi-v26" / "ic_launcher.xml",
            ANDROID_ADAPTIVE_XML,
        )
        _write_if_absent(
            icons / "android" / "values" / "ic_launcher_background.xml",
            ANDROID_BACKGROUND_XML,
        )

    return records


def _write_if_absent(path: Path, text: str) -> None:
    if path.exists():
        return
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")


# ---------------------------------------------------------------------------
# Verification
# ---------------------------------------------------------------------------

#: The mark occupies the 16 u optical box of a 24 u canvas, so coverage sits
#: around a quarter of the frame. The band is generous rather than tight: what it
#: catches is an empty render or a solid square, not a 2% change in weight.
INK_RATIO_RANGE = (0.08, 0.50)

#: Mean per-channel distance, over 0–255, below which a hinted render would be
#: indistinguishable from a resample of the 1024 px master. A hinted icon differs
#: in geometry, not just in filtering, so the real gap is an order of magnitude
#: above this; the floor is set low so the check fails only when the hinting has
#: actually stopped happening.
DOWNSAMPLE_DRIFT_FLOOR = 2.0

#: Coverage jump, over 0–255, that the kink must produce in the probe column
#: across the centre line. A correct hinted render measures around 128 there; a
#: blurred one measures single digits.
KINK_STEP_FLOOR = 48

#: Clear pixels the counters must keep between the ink and the optical box's edge
#: on the rows either side of the centre line.
COUNTER_FLOOR_PX = 2


def ink_ratio(image: Image.Image) -> float:
    alpha = image.convert("RGBA").getchannel("A")
    return sum(alpha.histogram()[1:]) / (image.width * image.height)


def row_is_clear(image: Image.Image, y: int) -> bool:
    alpha = image.convert("RGBA").getchannel("A")
    return all(alpha.getpixel((x, y)) == 0 for x in range(image.width))


def column_is_clear(image: Image.Image, x: int) -> bool:
    alpha = image.convert("RGBA").getchannel("A")
    return all(alpha.getpixel((x, y)) == 0 for y in range(image.height))


def naive_downsample(
    rasteriser: Rasteriser, variant: str, size: int, *, master: int = 1024
) -> Image.Image:
    return rasteriser.image(variant, master).resize((size, size), Image.LANCZOS)


def mean_abs_difference(left: Image.Image, right: Image.Image) -> float:
    difference = ImageChops.difference(left.convert("RGBA"), right.convert("RGBA"))
    histogram = difference.histogram()
    total = 0.0
    pixels = left.width * left.height
    for channel in range(4):
        band = histogram[channel * 256 : (channel + 1) * 256]
        total += sum(value * count for value, count in enumerate(band))
    return total / (pixels * 4)


def verify(root: Path, rasteriser: Rasteriser, records: list[Emitted]) -> list[str]:
    problems: list[str] = []
    geometry = rasteriser.geometry

    distinct = {size for name, size in FLAT_PNGS.items() if name != STORE_LOGO}
    if len(distinct) != EXPECTED_DISTINCT_SIZES:
        problems.append(
            f"the flat PNG set covers {len(distinct)} distinct sizes, not "
            f"{EXPECTED_DISTINCT_SIZES} (R18.4)"
        )

    for record in records:
        if not record.path.exists():
            problems.append(f"missing output: {record.path}")
            continue
        if record.path.stat().st_size == 0:
            problems.append(f"empty output: {record.path}")
            continue

        if record.kind == "png":
            problems.extend(_verify_png(record, rasteriser, geometry))
        elif record.kind == "ico":
            problems.extend(_verify_ico(record, rasteriser))
        elif record.kind == "icns":
            problems.extend(_verify_icns(record, rasteriser))

    problems.extend(_verify_tauri_conf(root))
    return problems


def _verify_png(record: Emitted, rasteriser: Rasteriser, geometry: MarkGeometry) -> list[str]:
    problems: list[str] = []
    size = record.size or 0
    with Image.open(record.path) as opened:
        image = opened.convert("RGBA")
        if opened.size != (size, size):
            problems.append(f"{record.path.name}: declared {size}px, file is {opened.size[0]}px")
            return problems

    ratio = ink_ratio(image)
    low, high = INK_RATIO_RANGE
    if not low <= ratio <= high:
        problems.append(
            f"{record.path}: ink coverage {ratio:.1%} is outside the {low:.0%} to {high:.0%} band"
        )

    if not (row_is_clear(image, 0) and row_is_clear(image, size - 1)):
        problems.append(f"{record.path}: the mark touches the top or bottom edge")
    if not (column_is_clear(image, 0) and column_is_clear(image, size - 1)):
        problems.append(f"{record.path}: the mark touches the left or right edge")

    if size <= HINT_MAX_PX:
        problems.extend(_verify_hinted(record.path, image, geometry, size))
        drift = mean_abs_difference(image, naive_downsample(rasteriser, record.variant, size))
        if drift < DOWNSAMPLE_DRIFT_FLOOR:
            problems.append(
                f"{record.path}: indistinguishable from a downsample of the 1024px render "
                f"(mean |Δ| {drift:.2f}); the hinted variant is not being used"
            )
    return problems


def _verify_hinted(path: Path, image: Image.Image, geometry: MarkGeometry, size: int) -> list[str]:
    """Read the hinted variant's three promises straight off the raster: crisp
    whole-pixel terminals, a kink that survives as a step, and two open counters."""
    problems: list[str] = []
    frame = geometry.hinted_frame(size)
    alpha = image.getchannel("A")
    x0, x1, y0, bar = frame["x0"], frame["x1"], frame["y0"], frame["bar"]
    y_mid = frame["y_mid"]

    blurred = [
        (x, y) for y in range(y0, y0 + bar) for x in range(x0, x1) if alpha.getpixel((x, y)) != 255
    ]
    if blurred:
        x, y = blurred[0]
        problems.append(
            f"{path.name}: top bar pixel ({x},{y}) is antialiased — the terminals are not "
            f"snapped to whole pixels ({len(blurred)} such pixels)"
        )
    if y0 > 0 and any(alpha.getpixel((x, y0 - 1)) != 0 for x in range(size)):
        problems.append(f"{path.name}: ink bleeds above the snapped top bar")

    # The break is a *step* in the band's right edge across the centre line, so it
    # is measured as a coverage jump in one column rather than as a difference of
    # rightmost-ink positions: at 16 px the leg's own slope moves the rightmost
    # pixel by as much as the kink does, and that metric reads zero on a correct
    # icon.
    probe = frame["c_x"] - 1
    above = alpha.getpixel((probe, y_mid - 1))
    below = alpha.getpixel((probe, y_mid))
    if below - above < KINK_STEP_FLOOR:
        problems.append(
            f"{path.name}: the kink step at column {probe} is {below - above}/255 across the "
            f"centre line, under {KINK_STEP_FLOOR} — the break has blurred into the band"
        )

    # Both counters open: ink must not reach the optical box's edges on the rows
    # either side of the centre line, or the mark has filled in.
    right_gap = x1 - _last_ink(alpha, y_mid - 1, x0, x1)
    left_gap = _first_ink(alpha, y_mid, x0, x1) - x0
    if right_gap < COUNTER_FLOOR_PX:
        problems.append(
            f"{path.name}: the lower-right counter is {right_gap}px above the centre line, "
            f"under {COUNTER_FLOOR_PX}"
        )
    if left_gap < COUNTER_FLOOR_PX:
        problems.append(
            f"{path.name}: the upper-left counter is {left_gap}px below the centre line, "
            f"under {COUNTER_FLOOR_PX}"
        )
    return problems


def _last_ink(alpha: Image.Image, y: int, x0: int, x1: int) -> int:
    for x in range(x1 - 1, x0 - 1, -1):
        if alpha.getpixel((x, y)) > 0:
            return x + 1
    return x0


def _first_ink(alpha: Image.Image, y: int, x0: int, x1: int) -> int:
    for x in range(x0, x1):
        if alpha.getpixel((x, y)) > 0:
            return x
    return x1


def _verify_ico(record: Emitted, rasteriser: Rasteriser) -> list[str]:
    problems: list[str] = []
    expected = tuple(sorted(record.layers or ()))
    try:
        layers = read_ico_layers(record.path)
    except Exception as exc:  # pragma: no cover - corrupt container
        return [f"{record.path}: unreadable ICO ({exc})"]

    if tuple(sorted(layers)) != expected:
        problems.append(f"{record.path}: layers {tuple(sorted(layers))}, expected {expected}")
        return problems

    for size, layer in layers.items():
        rendered = rasteriser.image(record.variant, size)
        if layer.tobytes() != rendered.tobytes():
            problems.append(
                f"{record.path}: the {size}px layer differs from the {size}px render — "
                "a layer was resampled instead of rendered"
            )
    return problems


def _verify_icns(record: Emitted, rasteriser: Rasteriser) -> list[str]:
    problems: list[str] = []
    try:
        chunks = read_icns(record.path.read_bytes())
    except Exception as exc:  # pragma: no cover - corrupt container
        return [f"{record.path}: unreadable icns ({exc})"]

    if [(ostype, size) for ostype, size, _ in chunks] != list(ICNS_CHUNKS):
        problems.append(
            f"{record.path}: chunk map {[(o, s) for o, s, _ in chunks]} does not match "
            f"{list(ICNS_CHUNKS)}"
        )
        return problems

    for ostype, size, payload in chunks:
        if payload != rasteriser.png(record.variant, size):
            problems.append(f"{record.path}: chunk {ostype} is not the {size}px render")
    return problems


def _verify_tauri_conf(root: Path) -> list[str]:
    """R18.4 leaves `bundle.icon` structurally unchanged, which is only safe if
    every path it already declares still resolves after regeneration."""
    conf_path = root / TAURI_CONF
    if not conf_path.exists():
        return [f"missing {TAURI_CONF}"]
    try:
        conf = json.loads(conf_path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        return [f"{TAURI_CONF} is not valid JSON: {exc}"]

    declared = conf.get("bundle", {}).get("icon", [])
    if not declared:
        return [f"{TAURI_CONF}: bundle.icon is empty"]

    problems: list[str] = []
    for entry in declared:
        target = (root / "apps" / "desktop" / entry).resolve()
        if not target.exists():
            problems.append(f"{TAURI_CONF} declares {entry}, which does not exist")
        elif target.stat().st_size == 0:
            problems.append(f"{TAURI_CONF} declares {entry}, which is empty")
    return problems


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------


def load_geometry(root: Path) -> MarkGeometry:
    source = root / MARK_SOURCE
    if not source.exists():
        raise FileNotFoundError(f"the mark source is missing: {MARK_SOURCE}")
    return MarkGeometry.parse(source.read_text(encoding="utf-8"))


def print_manifest(records: list[Emitted], root: Path) -> None:
    print(f"  {'file':52} {'px':>6}  source")
    for record in records:
        rel = record.path.relative_to(root).as_posix()
        extent = str(record.size) if record.size else ",".join(str(s) for s in record.layers or ())
        print(f"  {rel:52} {extent:>6}  {record.source}")


def run(root: Path, *, check: bool, quiet: bool) -> int:
    geometry = load_geometry(root)
    rasteriser = Rasteriser(geometry)

    if geometry.path_data() != _parse_path_d((root / MARK_SOURCE).read_text(encoding="utf-8")):
        print(
            "❌ the parsed geometry does not round-trip to the authored path; refusing to "
            "regenerate from a construction this script does not understand",
            file=sys.stderr,
        )
        return 1

    records = plan_and_write(root, rasteriser, write=not check)
    problems = verify(root, rasteriser, records)

    if not quiet and not check:
        print_manifest(records, root)

    if problems:
        print(
            f"❌ icon regeneration failed verification ({len(problems)} problem"
            f"{'s' if len(problems) != 1 else ''})",
            file=sys.stderr,
        )
        for problem in problems:
            print(f"  {problem}", file=sys.stderr)
        return 1

    pngs = sum(1 for record in records if record.kind == "png")
    distinct = len({record.size for record in records if record.kind == "png"})
    verb = "verified" if check else "regenerated"
    print(
        f"✅ icons {verb}: {pngs} PNGs at {distinct} distinct sizes, "
        f"icon.ico ({len(ICO_LAYERS)} layers), icon.icns ({len(ICNS_CHUNKS)} chunks), "
        f"favicon.ico ({len(FAVICON_LAYERS)} layers)"
    )
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description="Regenerate the Zoc AI application icon set.")
    parser.add_argument(
        "--check",
        action="store_true",
        help="verify the committed set against a fresh render and write nothing",
    )
    parser.add_argument(
        "--out-root",
        type=Path,
        default=REPO_ROOT,
        help="write into this tree instead of the repository root",
    )
    parser.add_argument("--quiet", action="store_true", help="suppress the manifest")
    args = parser.parse_args()
    try:
        return run(args.out_root.resolve(), check=args.check, quiet=args.quiet)
    except Exception as exc:  # pragma: no cover - top-level guard
        print(f"❌ {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
