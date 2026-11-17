# Mistwatch

Nezávislý nástroj, není produktem ani nijak spojený s Mistral AI.
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
