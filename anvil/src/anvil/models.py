MODELS = [
    {"id": "claude-opus-4-8",          "name": "Claude Opus 4.8",    "provider": "anthropic", "tier": "flagship"},
    {"id": "claude-opus-4-7",          "name": "Claude Opus 4.7",    "provider": "anthropic", "tier": "flagship"},
    {"id": "claude-opus-4-6",          "name": "Claude Opus 4.6",    "provider": "anthropic", "tier": "flagship"},
    {"id": "claude-opus-4-5",          "name": "Claude Opus 4.5",    "provider": "anthropic", "tier": "flagship"},
    {"id": "claude-opus-4-1",          "name": "Claude Opus 4.1",    "provider": "anthropic", "tier": "standard"},
    {"id": "claude-sonnet-4-6",        "name": "Claude Sonnet 4.6",  "provider": "anthropic", "tier": "standard"},
    {"id": "gpt-5-5",                  "name": "GPT-5.5",            "provider": "openai",    "tier": "flagship"},
    {"id": "gpt-5-4",                  "name": "GPT-5.4",            "provider": "openai",    "tier": "flagship"},
    {"id": "gpt-5-3",                  "name": "GPT-5.3",            "provider": "openai",    "tier": "flagship"},
    {"id": "gpt-5-1",                  "name": "GPT-5.1",            "provider": "openai",    "tier": "flagship"},
    {"id": "gpt-5",                    "name": "GPT-5",              "provider": "openai",    "tier": "flagship"},
    {"id": "gpt-5-mini",               "name": "GPT-5 Mini",         "provider": "openai",    "tier": "fast"},
    {"id": "gpt-4o",                   "name": "GPT-4o",             "provider": "openai",    "tier": "standard"},
    {"id": "gpt-4o-mini",              "name": "GPT-4o Mini",        "provider": "openai",    "tier": "fast"},
    {"id": "gemini-3-1-pro",           "name": "Gemini 3.1 Pro",     "provider": "google",    "tier": "flagship"},
    {"id": "gemini-3-pro",             "name": "Gemini 3 Pro",       "provider": "google",    "tier": "flagship"},
    {"id": "gemini-3-flash",           "name": "Gemini 3 Flash",     "provider": "google",    "tier": "fast"},
    {"id": "gemini-2.5-flash",         "name": "Gemini 2.5 Flash",   "provider": "google",    "tier": "fast"},
    {"id": "deepseek-v4-pro",          "name": "DeepSeek V4 Pro",    "provider": "deepseek",  "tier": "flagship"},
    {"id": "deepseek-v4-flash",        "name": "DeepSeek V4 Flash",  "provider": "deepseek",  "tier": "fast"},
    {"id": "deepseek-r1",              "name": "DeepSeek R1",        "provider": "deepseek",  "tier": "reasoning"},
    {"id": "grok-4",                   "name": "Grok 4",             "provider": "xai",       "tier": "flagship"},
    {"id": "qwen-3-max",               "name": "Qwen 3 Max",         "provider": "alibaba",   "tier": "standard"},
    {"id": "qwen-3-5-397b",            "name": "Qwen 3.5",           "provider": "alibaba",   "tier": "standard"},
    {"id": "kimi-k2-6",                "name": "Kimi K2.6",          "provider": "moonshot",  "tier": "standard"},
    {"id": "deepinfra-kimi-k2",        "name": "Kimi K2",            "provider": "moonshot",  "tier": "standard"},
    {"id": "llama-3-3-70b-versatile",  "name": "Llama 3.3 70B",      "provider": "meta",      "tier": "standard"},
]

PROVIDERS = {
    "anthropic": {"name": "Anthropic", "color": "dark_orange"},
    "openai":    {"name": "OpenAI",    "color": "green"},
    "google":    {"name": "Google",    "color": "blue"},
    "deepseek":  {"name": "DeepSeek",  "color": "cyan"},
    "xai":       {"name": "xAI",       "color": "red"},
    "alibaba":   {"name": "Alibaba",   "color": "magenta"},
    "moonshot":  {"name": "Moonshot",  "color": "bright_magenta"},
    "meta":      {"name": "Meta",      "color": "bright_blue"},
}

TIER_COLORS = {
    "flagship":  "yellow",
    "reasoning": "magenta",
    "standard":  "blue",
    "fast":      "green",
}

DEFAULT_MODEL = "gpt-5-4"


def get_model(model_id: str) -> dict:
    """Return catalog entry or pass through any custom model id unchanged."""
    if not model_id:
        return MODELS[0]
    found = next((m for m in MODELS if m["id"] == model_id), None)
    if found:
        return found
    return {"id": model_id, "name": model_id, "provider": "custom", "tier": ""}


def merge_models(remote: list[dict] | None) -> list[dict]:
    """Static catalog + live backend list + any custom ids (no restrictions)."""
    by_id: dict[str, dict] = {m["id"]: dict(m) for m in MODELS}
    if remote:
        for m in remote:
            mid = (m.get("id") or m.get("slug") or "").strip()
            if not mid:
                continue
            name = (m.get("name") or m.get("label") or mid).strip()
            if mid in by_id:
                by_id[mid]["name"] = name
            else:
                by_id[mid] = {
                    "id": mid,
                    "name": name,
                    "provider": m.get("provider") or "remote",
                    "tier": m.get("tier") or "",
                }
    return list(by_id.values())


def find_model(query: str):
    q = query.lower().strip()
    return next(
        (m for m in MODELS if q in m["name"].lower() or q in m["id"].lower() or q in m["provider"].lower()),
        None,
    )
