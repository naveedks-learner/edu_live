import importlib.util
import os
import sys
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
SRC = ROOT / "src"
sys.path.insert(0, str(SRC))


def test_env_driven_provider_config_supports_openrouter():
    with patch.dict(os.environ, {
        "ACTIVE_PROVIDER": "openrouter",
        "OPENROUTER_ENABLED": "true",
        "OPENROUTER_MODEL": "openai/gpt-oss-20b:free",
        "OPENROUTER_API_KEY": "test_openrouter_key",
    }, clear=False):
        import importlib
        llm_config = importlib.import_module("llm_config")
        cfg = llm_config.get_active_provider_settings()

        assert cfg.name == "openrouter"
        assert cfg.model == "openai/gpt-oss-20b:free"
        assert cfg.api_key == "test_openrouter_key"


def test_gemini_provider_supports_google_model():
    with patch.dict(os.environ, {
        "ACTIVE_PROVIDER": "gemini",
        "LLM_PROVIDER": "gemini",
        "GOOGLE_API_KEY": "test_google_key",
    }, clear=False):
        spec = importlib.util.spec_from_file_location("rag_module", SRC / "rag.py")
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)

        assert module.LLM_PROVIDER == "gemini"
        assert module.GEMINI_MODEL == "gemini-2.5-flash"
        assert module.GOOGLE_API_KEY == "test_google_key"


def test_streamlit_app_includes_gemini_provider_option():
    app_text = (ROOT / "src" / "app.py").read_text(encoding="utf-8")
    assert '"gemini"' in app_text
    assert 'provider_choices = ["groq", "claude", "huggingface", "gemini"]' in app_text
    assert 'Gemini model' in app_text
    assert 'gemini_model_choices' in app_text
    assert 'SmolLM3-3B' not in app_text
    assert 'smol' not in app_text.lower()


def test_active_provider_takes_priority_over_legacy_llm_provider():
    with patch.dict(os.environ, {
        "ACTIVE_PROVIDER": "openrouter",
        "LLM_PROVIDER": "gemini",
        "OPENROUTER_ENABLED": "true",
        "OPENROUTER_MODEL": "openai/gpt-oss-20b:free",
        "OPENROUTER_API_KEY": "test_openrouter_key",
    }, clear=False):
        import importlib
        llm_config = importlib.import_module("llm_config")
        cfg = llm_config.get_active_provider_settings()

        assert cfg.name == "openrouter"
        assert cfg.model == "openai/gpt-oss-20b:free"


def test_provider_package_exposes_default_runner():
    import providers
    assert hasattr(providers, "get_provider_runner")
    assert callable(providers.get_provider_runner)
    assert callable(providers.call_provider_text)


def test_document_first_web_search_policy_is_enforced():
    rag_text = (ROOT / "src" / "rag.py").read_text(encoding="utf-8")
    app_text = (ROOT / "src" / "app.py").read_text(encoding="utf-8")

    assert "Document-first" in rag_text or "document-first" in rag_text.lower()
    assert "Never use web_search before search_documents" in rag_text
    assert "RAG only" in app_text or "RAG + web fallback" in app_text
    assert "Hard fail when no document found" in app_text
    assert "hard_fail_on_no_document" in rag_text


def test_huggingface_model_choices_do_not_include_smol_model():
    import importlib
    llm_config = importlib.import_module("llm_config")
    choices = llm_config.get_model_choices_for_provider("huggingface")
    assert all("SmolLM3-3B" not in choice and "smol" not in choice.lower() for choice in choices)


def test_repeated_tool_cycle_detection_stops_endless_loops():
    trace = [
        {"tool": "search_documents", "input": "what is reflection of light"},
        {"tool": "search_documents", "input": "what is reflection of light"},
    ]
    import importlib.util
    import sys

    spec = importlib.util.spec_from_file_location("rag_module_for_testing", ROOT / "src" / "rag.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)

    assert module._has_repeated_tool_cycle(trace, "search_documents", "what is reflection of light") is True
