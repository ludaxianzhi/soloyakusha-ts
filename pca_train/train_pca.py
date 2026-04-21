from __future__ import annotations

import argparse
import asyncio
import json
import logging
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterable

import numpy as np
import httpx
import yaml
from openai import AsyncOpenAI
from sklearn.decomposition import PCA

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class EmbeddingConfig:
    api_key: str
    model: str
    base_url: str | None = None
    batch_size: int = 50
    max_concurrency: int = 10
    timeout: float | None = None
    trust_env: bool = False


def load_yaml_config(path: Path) -> dict[str, Any]:
    with path.open("r", encoding="utf-8") as handle:
        loaded = yaml.safe_load(handle)
    if not isinstance(loaded, dict):
        raise ValueError(f"Configuration file must contain a YAML mapping: {path}")
    return loaded


def extract_embedding_config(config: dict[str, Any]) -> EmbeddingConfig:
    candidates: Iterable[dict[str, Any]] = (
        config.get("embedding")
        if isinstance(config.get("embedding"), dict)
        else {},
        config.get("embeddings")
        if isinstance(config.get("embeddings"), dict)
        else {},
        config.get("openai_embedding")
        if isinstance(config.get("openai_embedding"), dict)
        else {},
        config,
    )

    selected: dict[str, Any] | None = None
    for candidate in candidates:
        if isinstance(candidate, dict) and "model" in candidate and (
            "api_key" in candidate or "apiKey" in candidate
        ):
            selected = candidate
            break

    if selected is None:
        raise ValueError(
            "Unable to find embedding configuration. Expected an object with at least "
            "'model' and 'api_key' fields."
        )

    api_key = selected.get("api_key") or selected.get("apiKey")
    model = selected.get("model")
    if not isinstance(api_key, str) or not api_key.strip():
        raise ValueError("Embedding config field 'api_key' must be a non-empty string.")
    if not isinstance(model, str) or not model.strip():
        raise ValueError("Embedding config field 'model' must be a non-empty string.")

    base_url = selected.get("base_url") or selected.get("baseUrl")
    if base_url is not None and (not isinstance(base_url, str) or not base_url.strip()):
        raise ValueError("Embedding config field 'base_url' must be a string when provided.")

    batch_size = int(selected.get("batch_size", selected.get("batchSize", 50)))
    max_concurrency = int(selected.get("max_concurrency", selected.get("maxConcurrency", 10)))
    timeout_value = selected.get("timeout")
    timeout = float(timeout_value) if timeout_value is not None else None
    trust_env_value = selected.get("trust_env", selected.get("trustEnv", False))
    if isinstance(trust_env_value, bool):
        trust_env = trust_env_value
    elif isinstance(trust_env_value, str):
        trust_env = trust_env_value.strip().lower() in {"1", "true", "yes", "on"}
    else:
        trust_env = bool(trust_env_value)

    if batch_size <= 0:
        raise ValueError("Embedding config field 'batch_size' must be greater than zero.")
    if max_concurrency <= 0:
        raise ValueError("Embedding config field 'max_concurrency' must be greater than zero.")

    return EmbeddingConfig(
        api_key=api_key,
        model=model,
        base_url=base_url.strip() if isinstance(base_url, str) else None,
        batch_size=batch_size,
        max_concurrency=max_concurrency,
        timeout=timeout,
        trust_env=trust_env,
    )


def read_text_lines(path: Path) -> list[str]:
    with path.open("r", encoding="utf-8") as handle:
        return [line.rstrip("\r\n") for line in handle]


def chunked(items: list[str], size: int) -> Iterable[tuple[int, list[str]]]:
    for start in range(0, len(items), size):
        yield start // size, items[start : start + size]


async def embed_batch(
    client: AsyncOpenAI,
    model: str,
    texts: list[str],
    batch_index: int,
) -> tuple[int, np.ndarray]:
    response = await client.embeddings.create(model=model, input=texts)
    ordered = sorted(response.data, key=lambda item: item.index)
    matrix = np.array([item.embedding for item in ordered], dtype=np.float32)
    return batch_index, matrix


async def embed_texts(config: EmbeddingConfig, texts: list[str]) -> np.ndarray:
    client_kwargs: dict[str, Any] = {"api_key": config.api_key}
    if config.base_url is not None:
        client_kwargs["base_url"] = config.base_url
    if config.timeout is not None:
        client_kwargs["timeout"] = config.timeout

    semaphore = asyncio.Semaphore(config.max_concurrency)
    batch_sizes = [len(batch_texts) for _, batch_texts in chunked(texts, config.batch_size)]
    total_batches = len(batch_sizes)
    logger.info(
        "Embedding %d lines in %d batches (batch_size=%d, max_concurrency=%d)",
        len(texts),
        total_batches,
        config.batch_size,
        config.max_concurrency,
    )

    async with httpx.AsyncClient(trust_env=config.trust_env) as http_client:
        client = AsyncOpenAI(http_client=http_client, **client_kwargs)

        async def run_one(batch_index: int, batch_texts: list[str]) -> tuple[int, np.ndarray]:
            async with semaphore:
                return await embed_batch(client, config.model, batch_texts, batch_index)

        tasks = [
            asyncio.create_task(run_one(batch_index, batch_texts))
            for batch_index, batch_texts in chunked(texts, config.batch_size)
        ]
        if not tasks:
            raise ValueError("No texts were loaded from the input file.")

        batches: list[tuple[int, np.ndarray]] = []
        completed_texts = 0
        for completed_batches, future in enumerate(asyncio.as_completed(tasks), start=1):
            batch_index, matrix = await future
            batches.append((batch_index, matrix))
            completed_texts += batch_sizes[batch_index]
            logger.info(
                "Embedding progress: %d/%d batches, %d/%d lines complete",
                completed_batches,
                total_batches,
                completed_texts,
                len(texts),
            )

    batches.sort(key=lambda item: item[0])
    return np.vstack([matrix for _, matrix in batches])


def train_pca(vectors: np.ndarray, target_dim: int) -> tuple[PCA, np.ndarray]:
    if vectors.ndim != 2:
        raise ValueError("Embedding matrix must be two-dimensional.")
    if target_dim <= 0:
        raise ValueError("Target PCA dimension must be greater than zero.")
    if target_dim > min(vectors.shape[0], vectors.shape[1]):
        raise ValueError(
            f"Target PCA dimension {target_dim} exceeds the allowed maximum "
            f"of {min(vectors.shape[0], vectors.shape[1])} for the current dataset."
        )

    pca = PCA(n_components=target_dim)
    transformed = pca.fit_transform(vectors)
    return pca, transformed


def save_outputs(
    output_base: Path,
    transformed: np.ndarray,
    pca: PCA,
    *,
    source_file: Path,
    config_file: Path,
    embedding_config: EmbeddingConfig,
    target_dim: int,
    text_count: int,
) -> None:
    output_base.parent.mkdir(parents=True, exist_ok=True)
    np.save(output_base.with_suffix(".npy"), transformed.astype(np.float32))
    payload = {
        "source_file": str(source_file),
        "config_file": str(config_file),
        "output_basename": str(output_base),
        "text_count": text_count,
        "embedding": {
            "model": embedding_config.model,
            "base_url": embedding_config.base_url,
            "batch_size": embedding_config.batch_size,
            "max_concurrency": embedding_config.max_concurrency,
            "timeout": embedding_config.timeout,
        },
        "pca": {
            "target_dim": target_dim,
            "input_dim": int(pca.n_features_in_),
            "sample_count": int(pca.n_samples_),
            "components": pca.components_.tolist(),
            "mean": pca.mean_.tolist(),
            "explained_variance": pca.explained_variance_.tolist(),
            "explained_variance_ratio": pca.explained_variance_ratio_.tolist(),
            "explained_variance_ratio_sum": float(np.sum(pca.explained_variance_ratio_)),
            "cumulative_explained_variance_ratio": np.cumsum(
                pca.explained_variance_ratio_
            ).tolist(),
            "singular_values": pca.singular_values_.tolist(),
        },
    }
    with output_base.with_suffix(".json").open("w", encoding="utf-8") as handle:
        json.dump(payload, handle, ensure_ascii=False, indent=2)
        handle.write("\n")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Embed text lines and train a PCA projection.")
    parser.add_argument("--config", required=True, type=Path, help="YAML configuration file.")
    parser.add_argument("--input", required=True, type=Path, help="Text file to read line-by-line.")
    parser.add_argument("--target-dim", required=True, type=int, help="PCA output dimension.")
    parser.add_argument("--basename", required=True, type=Path, help="Output basename without extension.")
    return parser.parse_args()


def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    args = parse_args()
    config_data = load_yaml_config(args.config)
    embedding_config = extract_embedding_config(config_data)
    texts = read_text_lines(args.input)
    if not texts:
        raise ValueError(f"No lines were found in the input file: {args.input}")

    logger.info("Loaded %d lines from %s", len(texts), args.input)
    logger.info("Training PCA to %d dimensions", args.target_dim)
    vectors = asyncio.run(embed_texts(embedding_config, texts))
    pca, transformed = train_pca(vectors, args.target_dim)
    variance_retained = float(np.sum(pca.explained_variance_ratio_))
    logger.info(
        "PCA complete: input_dim=%d output_dim=%d retained_variance=%.4f",
        int(pca.n_features_in_),
        args.target_dim,
        variance_retained,
    )
    save_outputs(
        args.basename,
        transformed,
        pca,
        source_file=args.input,
        config_file=args.config,
        embedding_config=embedding_config,
        target_dim=args.target_dim,
        text_count=len(texts),
    )


if __name__ == "__main__":
    main()
