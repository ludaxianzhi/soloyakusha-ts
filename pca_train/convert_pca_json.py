"""Convert old PCA JSON (plain float lists) to new format (base64-encoded float32 arrays).

Usage:
    python convert_pca_json.py <input.json> [output.json]

If <output.json> is omitted, the input file is overwritten in-place.
"""

from __future__ import annotations

import argparse
import base64
import json
from pathlib import Path
from typing import Any

import numpy as np

_ARRAY_FIELDS = (
    "explained_variance",
    "explained_variance_ratio",
    "cumulative_explained_variance_ratio",
    "singular_values",
    "mean",
    "components",
)


def _ndarray_to_b64(arr: np.ndarray) -> dict[str, Any]:
    arr_f32 = np.asarray(arr, dtype=np.float32)
    return {
        "dtype": "float32",
        "shape": list(arr_f32.shape),
        "data": base64.b64encode(arr_f32.tobytes()).decode("ascii"),
    }


def _is_new_format(pca: dict[str, Any]) -> bool:
    """Return True if the pca block already uses base64 blobs."""
    return isinstance(pca.get("components"), dict)


def convert_payload(payload: dict[str, Any]) -> dict[str, Any]:
    pca: dict[str, Any] = payload.get("pca", {})

    if _is_new_format(pca):
        raise ValueError("File is already in the new base64 format — no conversion needed.")

    for field in _ARRAY_FIELDS:
        if field not in pca:
            continue
        raw = pca[field]
        arr = np.array(raw, dtype=np.float32)
        pca[field] = _ndarray_to_b64(arr)

    return payload


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Convert old PCA JSON (float lists) to new format (base64 float32 blobs)."
    )
    parser.add_argument("input", type=Path, help="Input JSON file in the old format.")
    parser.add_argument(
        "output",
        type=Path,
        nargs="?",
        help="Output JSON file. Defaults to overwriting the input file.",
    )
    return parser.parse_args()


def main() -> None:
    args = parse_args()

    with args.input.open("r", encoding="utf-8") as fh:
        payload: dict[str, Any] = json.load(fh)

    try:
        converted = convert_payload(payload)
    except ValueError as exc:
        print(f"Skipped: {exc}")
        return

    output_path = args.output or args.input
    with output_path.open("w", encoding="utf-8") as fh:
        json.dump(converted, fh, ensure_ascii=False, indent=2)
        fh.write("\n")

    print(f"Converted: {args.input} -> {output_path}")


if __name__ == "__main__":
    main()
