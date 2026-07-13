"""Configuration for benchmark scripts."""

PROXY_URL = "http://localhost:1945"
PROXIES = {
    "direct_openai": "umans",
    "direct_anthropic": "umans-anthropic",
    "proxy_openai": "umans-proxy",
    "proxy_anthropic": "umans-proxy-anthropic",
}
PI_PATH = "pi"
ITERATIONS = 3
