import logging
import os
from dataclasses import dataclass
from typing import Optional, Literal

from dotenv import load_dotenv

load_dotenv()  # single point of .env loading for the whole app

logger = logging.getLogger(__name__)

ProviderName = Literal["groq", "claude", "huggingface", "gemini", "openrouter"]

# Extra env var names, beyond the provider's primary api_key field, that also
# satisfy that provider's key requirement (back-compat aliases).
_KEY_ALIASES = {
    "gemini": ("GOOGLE_API_KEY", "GEMINI_API_KEY"),
    "huggingface": ("HF_TOKEN", "HUGGINGFACE_API_KEY", "HUGGINGFACEHUB_API_TOKEN"),
}

REQUIRED_KEY_BY_PROVIDER = {
    "groq": "GROQ_API_KEY",
    "claude": "ANTHROPIC_API_KEY",
    "huggingface": "HF_TOKEN",
    "gemini": "GOOGLE_API_KEY",
    "openrouter": "OPENROUTER_API_KEY",
}


def _as_bool(raw: Optional[str], default: bool = False) -> bool:
    if raw is None:
        return default
    return str(raw).strip().lower() in {"1", "true", "yes", "on"}


@dataclass(frozen=True)
class LLMSettings:
    name: ProviderName
    enabled: bool
    model: str
    api_key: Optional[str] = None


def _provider_order() -> list[ProviderName]:
    return ["openrouter", "gemini", "huggingface", "groq", "claude"]


_KNOWN_PROVIDERS = {"groq", "claude", "huggingface", "gemini", "openrouter"}


def get_active_provider_settings() -> LLMSettings:
    raw_active_provider = (os.environ.get("ACTIVE_PROVIDER") or "").strip().lower()

    if raw_active_provider in _KNOWN_PROVIDERS:
        provider = raw_active_provider
    else:
        if raw_active_provider:
            logger.warning(f"ACTIVE_PROVIDER={raw_active_provider!r} is not recognized; falling back to 'gemini'.")
        provider = "gemini"

    if provider == "openrouter":
        return LLMSettings(
            name="openrouter",
            enabled=_as_bool(os.environ.get("OPENROUTER_ENABLED"), default=True),
            model=os.environ.get("OPENROUTER_MODEL") or "openai/gpt-oss-20b:free",
            api_key=os.environ.get("OPENROUTER_API_KEY"),
        )

    if provider == "gemini":
        return LLMSettings(
            name="gemini",
            enabled=_as_bool(os.environ.get("GEMINI_ENABLED"), default=True),
            model=os.environ.get("GEMINI_MODEL") or "gemini-flash-latest",
            api_key=os.environ.get("GOOGLE_API_KEY") or os.environ.get("GEMINI_API_KEY"),
        )

    if provider == "huggingface":
        return LLMSettings(
            name="huggingface",
            enabled=_as_bool(os.environ.get("HUGGINGFACE_ENABLED"), default=False),
            model=os.environ.get("HUGGINGFACE_MODEL") or "Qwen/Qwen2.5-3B-Instruct",
            api_key=os.environ.get("HF_TOKEN") or os.environ.get("HUGGINGFACE_API_KEY") or os.environ.get("HUGGINGFACEHUB_API_TOKEN"),
        )

    if provider == "groq":
        return LLMSettings(
            name="groq",
            enabled=_as_bool(os.environ.get("GROQ_ENABLED"), default=True),
            model=os.environ.get("GROQ_MODEL") or "llama-3.3-70b-versatile",
            api_key=os.environ.get("GROQ_API_KEY"),
        )

    return LLMSettings(
        name="claude",
        enabled=_as_bool(os.environ.get("CLAUDE_ENABLED"), default=True),
        model=os.environ.get("CLAUDE_MODEL") or "claude-sonnet-4-6",
        api_key=os.environ.get("ANTHROPIC_API_KEY"),
    )


def build_provider_options() -> list[tuple[str, str]]:
    options = [
        ("openrouter", "OpenRouter"),
        ("gemini", "Google Gemini"),
        ("huggingface", "Hugging Face"),
        ("groq", "Groq"),
        ("claude", "Claude"),
    ]
    return options


def get_model_choices_for_provider(provider: str) -> list[str]:
    provider = (provider or "gemini").lower()
    if provider == "openrouter":
        return [
            "openai/gpt-oss-20b",
            "openai/gpt-oss-20b:free",
            "google/gemma-4-26b-a4b-it:free",
            "google/gemma-4-31b-it:free",
            "nvidia/nemotron-nano-12b-v2-vl:free",
            "nvidia/nemotron-3-ultra-550b-a55b:free",
        ]
    if provider == "gemini":
        return [
            "gemini-flash-latest",
            "gemini-2.5-flash-lite",
            "gemini-2.5-flash",
            "gemini-2.5-pro",
        ]
    if provider == "huggingface":
        return [
            "Qwen/Qwen2.5-3B-Instruct",
            "Qwen/Qwen2.5-7B-Instruct",
            "Qwen/Qwen3.8-27B",
            "OBLITERATUS/Qwen3.8-27B-OBLITERATED",
            "zai-org/GLM-5.3-Flash",
            "Qwen/Qwen3.8-2.4T-A95B",
            "zai-org/GLM-5.2",
        ]
    if provider == "groq":
        return ["llama-3.3-70b-versatile"]
    if provider == "claude":
        return ["claude-sonnet-4-6"]
    return []


def get_model_list_for_active_provider() -> list[str]:
    settings = get_active_provider_settings()
    return get_model_choices_for_provider(settings.name)


# Curated CPU-friendly sentence-transformers embedding models, roughly in
# increasing order of retrieval quality (and size/latency) per public BEIR
# benchmarks. bge-small is the long-standing default here; the others trade
# more compute for noticeably better relevance separation. Note this only
# affects ranking among candidates the vector store returns - it does NOT
# fix the "unrelated chunks still look 60-80% confident" miscalibration
# (see reranker.py for that fix). Changing this requires re-indexing:
# a Chroma collection's embedding dimensionality is fixed at creation, so
# delete chroma_db/ (or persist_dir) and re-run ingestion after switching.
EMBEDDING_MODEL_CHOICES = [
    "BAAI/bge-small-en-v1.5",              # current default: ~130MB, fastest
    "BAAI/bge-base-en-v1.5",               # ~440MB, stronger BEIR scores than -small
    "mixedbread-ai/mxbai-embed-large-v1",  # ~1.3GB, top-tier open embedding model
    "sentence-transformers/all-MiniLM-L6-v2",  # ~90MB, general-purpose baseline
]


def get_embedding_model() -> str:
    """Which sentence-transformers model VectorStore uses to embed text.
    Defaults to the current bge-small default; override via EMBEDDING_MODEL
    in .env (see EMBEDDING_MODEL_CHOICES above for tested options)."""
    return os.environ.get("EMBEDDING_MODEL") or EMBEDDING_MODEL_CHOICES[0]


def validate_active_provider() -> LLMSettings:
    """Fail fast with a clear message if the active provider is missing its required key."""
    settings = get_active_provider_settings()
    required_key = REQUIRED_KEY_BY_PROVIDER.get(settings.name)
    if required_key and not settings.api_key:
        aliases = _KEY_ALIASES.get(settings.name, ())
        names = ", ".join((required_key,) + aliases)
        raise SystemExit(f"ERROR: ACTIVE_PROVIDER={settings.name!r} but none of [{names}] is set. Add one to .env.")
    return settings


def guardrail_enabled() -> bool:
    """Whether the pre-flight scope/age guardrail (query_scope_and_age_guardrail.py)
    runs before every query. Default on; set GUARDRAIL_ENABLED=false in .env to disable."""
    return _as_bool(os.environ.get("GUARDRAIL_ENABLED"), default=True)
