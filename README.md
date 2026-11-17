<p align="center"><picture><source media="(prefers-color-scheme: dark)" srcset="src/mistwatch/web/logo-dark.svg"><img src="src/mistwatch/web/logo.svg" alt="Mistwatch" height="48"></picture></p>

# Mistwatch

> **Neoficiální nástroj.** Mistwatch je nezávislý projekt. Není produktem Mistral AI, není s ní nijak spojený ani jí schválený či sponzorovaný. „Mistral“ je ochranná známka společnosti Mistral AI a je zde použita jen k popisu služby, se kterou nástroj komunikuje.

Místní proxy pro Mistral (Vibe Code + Studio/API), která hlídá rozpočty, rozkládá je v čase a umí model `auto`.

```
mistwatch serve        # pak otevři http://127.0.0.1:8787/
```

## Web UI

Adresa `/`, přihlášení účtem (první spuštění nabídne vytvoření). Stránky:

- **Přehled** – rozpočty Vibe a Studio, okna 5 h / den / týden / měsíc, poslední požadavky.
- **Účty a klíče** – Mistral účty, ke každému Vibe klíč (lze převzít z Vibe CLI jedním klikem) a Studio API klíč. Klíč se před uložením ověří a načte se rozpočet.
- **API klíče** – klíče `mw-…` pro tvoje nástroje; celý klíč se ukáže jen při vytvoření.
- **Nastavení** – změna hesla, další uživatelé.

## Bezpečnost

- Hesla: scrypt se solí. Session a proxy klíče: v DB jen SHA-256.
- Mistral klíče nejdou hashovat (posílají se dál), proto jsou v úložišti klíčů systému (Windows Credential Manager); DB drží jen odkaz.
- Cookie `HttpOnly`, `SameSite=Strict`, změny vyžadují hlavičku `x-mw`; po 5 špatných pokusech zámek na 60 s.
- Server poslouchá jen na `127.0.0.1`. Nevystavuj ho do sítě bez reverzní proxy s HTTPS.
- Zapomenuté heslo: `mistwatch passwd <jmeno>`.

## Konfigurace

`~/.mistwatch/config.toml` obsahuje už jen server, limity, ceny a `[router]`. Účty a klienti ze starého configu se při prvním spuštění jednorázově přenesou do DB; poté je smaž z `config.toml` (zejména případné klíče v plaintextu).

Další příkazy: `status`, `sync`, `route "prompt" [--llm]`, `vibe-config`, `import-vibe`.

## Logo a favicony

Značku „MW“ a nápis tvoří pixely z fontu [Tiny5](https://github.com/Gissio/font_tiny5) (SIL OFL 1.1, viz `brand/OFL.txt`) v barevném přechodu od jantarové ke korálové. Je to záměrně jiné písmo, tvar i paleta než logo Mistral AI. Soubory se generují skriptem `brand/build.py` (výstup do `src/mistwatch/web/`) a optimalizují přes `svgo`:

```
uv run --no-project --with fonttools --with pillow python brand/build.py
npx svgo@3 --config brand/svgo.config.mjs src/mistwatch/web/*.svg
```
