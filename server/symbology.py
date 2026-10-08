import json
import re
from typing import Literal

import numpy as np
from pydantic import BaseModel, Field, model_validator


CLASS_COLORS = ["#66c2a5", "#fc8d62", "#8da0cb", "#e78ac3", "#a6d854", "#ffd92f", "#e5c494", "#b3b3b3"]
ESRI_CLASSES = [
    (1, "Water", "#1a5bab"), (2, "Trees", "#358221"),
    (3, "Grass", "#a7d282"), (4, "Flooded vegetation", "#87d19e"),
    (5, "Crops", "#ffdb5c"), (6, "Scrub / shrub", "#eecfa8"),
    (7, "Built area", "#ed022a"), (8, "Bare ground", "#ede9e4"),
    (9, "Snow / ice", "#f2faff"), (10, "Clouds", "#c8c8c8"),
    (11, "Rangeland", "#c6ad8d"),
]
WORLDCOVER_CLASSES = [
    (10, "Tree cover", "#006400"), (20, "Shrubland", "#ffbb22"), (30, "Grassland", "#ffff4c"),
    (40, "Cropland", "#f096ff"), (50, "Built-up", "#fa0000"), (60, "Bare / sparse vegetation", "#b4b4b4"),
    (70, "Snow / ice", "#f0f0f0"), (80, "Permanent water", "#0064c8"), (90, "Herbaceous wetland", "#0096a0"),
    (95, "Mangroves", "#00cf75"), (100, "Moss / lichen", "#fae6a0"),
]


class ClassStyle(BaseModel):
    value: int
    label: str = Field(max_length=100)
    color: str = Field(pattern=r"^#[0-9a-fA-F]{6}$")
    visible: bool = True


class Symbology(BaseModel):
    mode: Literal["rgb", "continuous", "classes"]
    palette: Literal["gray", "viridis", "terrain", "magma", "blues"] = "gray"
    classes: list[ClassStyle] = Field(default_factory=list, max_length=256)
    source: str = Field(default="Custom", max_length=100)
    minimum: float | None = Field(default=None, allow_inf_nan=False)
    maximum: float | None = Field(default=None, allow_inf_nan=False)
    bands: list[str] | None = Field(default=None, max_length=3)

    @model_validator(mode="after")
    def unique_classes(self):
        if self.mode == "classes" and not self.classes:
            raise ValueError("Add at least one class.")
        if len({entry.value for entry in self.classes}) != len(self.classes):
            raise ValueError("Class values must be unique.")
        if (self.minimum is None) != (self.maximum is None) or (self.minimum is not None and self.minimum >= self.maximum):
            raise ValueError("Set both range endpoints, with minimum below maximum.")
        return self

    def colormap(self):
        return {entry.value: (*bytes.fromhex(entry.color[1:]), 255 if entry.visible else 0) for entry in self.classes}


def esri_style(annual=True):
    excluded = {3, 6} if annual else {11}
    return {"mode": "classes", "palette": "gray", "source": "Dataset classification",
            "classes": [{"value": value, "label": label, "color": color, "visible": True}
                        for value, label, color in ESRI_CLASSES if value not in excluded]}


def raster_style(dataset, preview, band=None, name=""):
    embedded = dataset.tags().get("OPEN_EARTH_SYMBOLOGY")
    if embedded:
        try:
            style = Symbology.model_validate(json.loads(embedded)).model_dump()
            if band is None or style.get("bands") == [str(band)]:
                return style
        except (ValueError, TypeError):
            pass
    interpretations = [entry.name for entry in dataset.colorinterp]
    descriptions = [(entry or "").strip().lower() for entry in dataset.descriptions]
    for candidates in (interpretations, descriptions):
        if band is None and all(channel in candidates for channel in ("red", "green", "blue")):
            return {"mode": "rgb", "palette": "gray", "classes": [], "source": "RGB metadata",
                    "bands": [str(candidates.index(channel) + 1) for channel in ("red", "green", "blue")]}
    if dataset.count == 1 or band is not None:
        index = band or 1
        try:
            colors = dataset.colormap(index)
        except ValueError:
            colors = {}
        entries = [{"value": value, "label": f"Class {value}", "color": "#%02x%02x%02x" % rgba[:3], "visible": True}
                   for value, rgba in colors.items() if rgba[3] and value != dataset.nodatavals[index - 1]]
        if entries and len(entries) <= 256:
            return {"mode": "classes", "palette": "gray", "classes": entries, "source": "Embedded color table"}
        values = preview[0].compressed()
        unique = np.unique(values[np.isfinite(values)])
        measured = bool(dataset.units[index - 1]) or dataset.scales[index - 1] != 1 or dataset.offsets[index - 1] != 0
        complete = preview.shape[-2:] == (dataset.height, dataset.width)
        discrete = 0 < len(unique) <= 32 and np.equal(unique, np.floor(unique)).all()
        identity = " ".join([name, *dataset.tags().values(), *dataset.tags(index).values()]).lower()
        if not measured and discrete:
            known = None
            if re.search(r"io[-_ ]lulc|esri[-_ ](?:10m[-_ ])?(?:land[-_ ]?cover|lulc)", identity):
                known = esri_style(annual=bool(re.search(r"annual|9[-_ ]class", identity)) or 11 in unique)
            elif re.search(r"(?:esa[-_ ])?worldcover", identity):
                known = worldcover_style()
            if known and set(unique).issubset({entry["value"] for entry in known["classes"]}):
                return known
        if not measured and discrete and (complete or values.size >= len(unique) * 8):
            return {"mode": "classes", "palette": "gray", "source": "Unique values" if complete else "Sampled values",
                    "classes": [{"value": int(value), "label": f"Class {int(value)}", "color": CLASS_COLORS[index % len(CLASS_COLORS)], "visible": True}
                                for index, value in enumerate(unique)]}
    return {"mode": "continuous", "palette": "viridis", "classes": [], "source": "Continuous values"}


def raster_distribution(preview, dataset):
    values = preview.compressed()
    values = values[np.isfinite(values)]
    complete = preview.shape[-2:] == (dataset.height, dataset.width)
    if not values.size:
        return {"histogram": [], "valid": 0, "sampled": not complete, "range": None}
    low, high = np.percentile(values, [2, 98])
    if low == high:
        low, high = values.min(), values.max()
    if low == high:
        high = low + 1
    counts, _ = np.histogram(values, bins=32, range=(float(low), float(high)))
    return {"histogram": counts.tolist(), "valid": int(values.size), "sampled": not complete,
            "range": [float(low), float(high)]}


def stac_style(collection, assets, bands):
    known = None
    if collection in {"io-lulc", "io-lulc-9-class", "io-lulc-annual-v02", "esri-10m-landcover", "esri-10m-landcover-9-class"}:
        known = esri_style(annual=collection not in {"io-lulc", "esri-10m-landcover"})
    elif collection == "esa-worldcover":
        known = worldcover_style()
    known_colors = {entry["value"]: entry["color"] for entry in known["classes"]} if known else {}
    asset = assets.get(bands.split(",")[0], {})
    metadata = (asset.get("raster:bands") or asset.get("bands") or [{}])[0]
    classes = asset.get("classification:classes") or metadata.get("classification:classes", [])
    if not classes:
        classes = [{"value": value, "description": entry.get("summary", str(value))}
                   for entry in asset.get("file:values", []) for value in entry.get("values", [])
                   if value != metadata.get("nodata") and "no data" not in entry.get("summary", "").lower()]
    entries = []
    for index, entry in enumerate(classes):
        if entry.get("value") == metadata.get("nodata"):
            continue
        color = entry.get("color_hint") or known_colors.get(entry["value"]) or CLASS_COLORS[index % len(CLASS_COLORS)]
        entries.append({"value": entry["value"], "label": entry.get("description") or entry.get("name") or str(entry["value"]),
                        "color": color if color.startswith("#") else f"#{color}", "visible": True})
    if entries:
        try:
            return Symbology(mode="classes", classes=entries, source="Class metadata").model_dump()
        except ValueError:
            pass
    if known:
        return known
    channels = {}
    for name, candidate in assets.items():
        metadata_bands = candidate.get("eo:bands") or candidate.get("bands") or []
        if len(metadata_bands) == 1:
            channels[metadata_bands[0].get("common_name")] = name
    if all(channel in channels for channel in ("red", "green", "blue")):
        return {"mode": "rgb", "palette": "gray", "classes": [], "source": "RGB metadata",
                "bands": [channels[channel] for channel in ("red", "green", "blue")]}
    style = {"mode": "rgb" if len(bands.split(",")) == 3 else "continuous", "palette": "gray", "classes": [], "source": "Band display"}
    statistics = metadata.get("statistics", {})
    low, high = statistics.get("minimum"), statistics.get("maximum")
    if style["mode"] == "continuous" and isinstance(low, (int, float)) and isinstance(high, (int, float)) and np.isfinite([low, high]).all() and low < high:
        style.update(minimum=low, maximum=high, source="Band statistics")
    return style


def worldcover_style():
    return {"mode": "classes", "palette": "gray", "source": "Dataset classification",
            "classes": [{"value": value, "label": label, "color": color, "visible": True} for value, label, color in WORLDCOVER_CLASSES]}


def presets():
    return {}