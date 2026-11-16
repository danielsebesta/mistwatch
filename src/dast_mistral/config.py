"""Configuration loading (TOML) and secret resolution."""
from __future__ import annotations

import os
import tomllib
from dataclasses import dataclass, field
from pathlib import Path


def home_dir() -> Path:
    return Path(os.environ.get("DAST_MISTRAL_HOME") or Path.home() / ".dast-mistral")


def config_path() -> Path:
    return Path(os.environ.get("DAST_MISTRAL_CONFIG") or home_dir() / "config.toml")


@dataclass
class Account:
    name: str
    # pool -> secret reference ("keyring:service/user" | "env:NAME" | literal). The key decides which
    # Mistral budget a request is charged to: the Vibe CLI login key -> "vibe", a console API key -> "api".
    keys: dict[str, str] = field(default_factory=dict)
    priority: int = 100  # lower = preferred on ties
    enabled: bool = True
    # Fallback when /v1/billing/budget is not readable: {"vibe": {"initial_eur": 127.5, "reset_day": 1}}
    manual: dict[str, dict] = field(default_factory=dict)

    def key_for(self, pool: str) -> str | None:
        ref = self.keys.get(pool)
        return resolve_secret(ref) if ref else None

    def any_key(self) -> str:
        for pool in self.keys:
            return resolve_secret(self.keys[pool])
        raise RuntimeError(f"account {self.name} has no keys configured")


@dataclass
class Client:
    name: str
    token: str


@dataclass
class Limits:
    reserve_pct: float = 3.0  # untouchable slice of each pool's monthly budget
    burst_5h: float = 2.0  # multiples of the fair pace allowed inside a 5h window
    burst_day: float = 1.5
    burst_week: float = 1.25
    sync_interval_s: int = 300
    strategy: str = "most_headroom"  # or "priority"
    fallback_to_other_pool: bool = True
    # Requests whose User-Agent matches are accounted to the Vibe pool; everything else to API.
    vibe_user_agent_regex: str = "Mistral-Vibe"


@dataclass
class RouterCfg:
    llm_classifier: bool = True  # ask a tiny model about ambiguous prompts
    classifier_model: str = "ministral-3b-latest"
    classifier_timeout_s: float = 2.0


@dataclass
class Config:
    host: str = "127.0.0.1"
    port: int = 8787
    upstream: str = "https://api.mistral.ai"
    usd_to_eur: float = 0.86
    db_path: Path = field(default_factory=lambda: home_dir() / "ledger.db")
    limits: Limits = field(default_factory=Limits)
    router: RouterCfg = field(default_factory=RouterCfg)
    accounts: list[Account] = field(default_factory=list)
    clients: list[Client] = field(default_factory=list)
    price_overrides: dict[str, dict] = field(default_factory=dict)


def resolve_secret(ref: str) -> str:
    if ref.startswith("env:"):
        v = os.environ.get(ref[4:])
        if not v:
            raise RuntimeError(f"environment variable {ref[4:]} is not set")
        return v
    if ref.startswith("keyring:"):
        import keyring

        service, _, user = ref[8:].partition("/")
        v = keyring.get_password(service, user)
        if not v:
            raise RuntimeError(f"no keyring entry {service}/{user}")
        return v
    return ref


def load(path: Path | None = None) -> Config:
    path = path or config_path()
    if not path.exists():
        raise FileNotFoundError(f"{path} not found - run `dast-mistral init` first")
    raw = tomllib.loads(path.read_text(encoding="utf-8"))
    cfg = Config()
    s = raw.get("server", {})
    cfg.host = s.get("host", cfg.host)
    cfg.port = int(s.get("port", cfg.port))
    cfg.upstream = raw.get("upstream", {}).get("base_url", cfg.upstream).rstrip("/")
    pr = raw.get("pricing", {})
    cfg.usd_to_eur = float(pr.get("usd_to_eur", cfg.usd_to_eur))
    cfg.price_overrides = pr.get("models", {})
    if "db_path" in raw.get("storage", {}):
        cfg.db_path = Path(raw["storage"]["db_path"])
    lim = raw.get("limits", {})
    for k, v in lim.items():
        if hasattr(cfg.limits, k):
            setattr(cfg.limits, k, type(getattr(cfg.limits, k))(v))
    for k, v in raw.get("router", {}).items():
        if hasattr(cfg.router, k):
            setattr(cfg.router, k, type(getattr(cfg.router, k))(v))
    for a in raw.get("accounts", []):
        cfg.accounts.append(
            Account(
                name=a["name"],
                keys=dict(a.get("keys", {})),
                priority=int(a.get("priority", 100)),
                enabled=bool(a.get("enabled", True)),
                manual=a.get("manual", {}),
            )
        )
    for c in raw.get("clients", []):
        cfg.clients.append(Client(name=c["name"], token=c["token"]))
    return cfg
