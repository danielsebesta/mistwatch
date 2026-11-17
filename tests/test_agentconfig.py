import json

from mistwatch import cli


def test_agent_config_write_merges_and_backs_up(tmp_path, monkeypatch, capsys):
    monkeypatch.setenv("HOME", str(tmp_path))
    monkeypatch.setenv("USERPROFILE", str(tmp_path))
    cli.main(["init"])
    f = tmp_path / ".config" / "opencode" / "opencode.json"
    f.parent.mkdir(parents=True)
    f.write_text(json.dumps({"theme": "x", "provider": {"other": {"a": 1}}}))
    assert cli.main(["agent-config", "opencode", "--write"]) == 0
    d = json.loads(f.read_text())
    assert d["theme"] == "x" and d["provider"]["other"] == {"a": 1}
    p = d["provider"]["mistwatch"]
    assert p["options"]["apiKey"] == "{env:MISTWATCH_TOKEN}" and "auto" in p["models"]
    assert f.with_suffix(".json.bak").exists()


def test_pi_config_shape(tmp_path, monkeypatch, capsys):
    monkeypatch.setenv("HOME", str(tmp_path))
    monkeypatch.setenv("USERPROFILE", str(tmp_path))
    cli.main(["init"])
    capsys.readouterr()
    assert cli.main(["agent-config", "pi"]) == 0
    out = capsys.readouterr().out
    d = json.loads(out.split("\n", 1)[1])
    m = d["providers"]["mistwatch"]
    assert m["api"] == "openai-completions" and m["models"][0]["id"] == "auto"


def test_llms_txt_is_public_and_configs_need_login(tmp_path):
    import httpx
    from fastapi.testclient import TestClient

    from mistwatch.config import Config
    from mistwatch.proxy import create_app

    app = create_app(Config(db_path=tmp_path / "w.db"))
    with TestClient(app) as c:
        r = c.get("/llms.txt")
        assert r.status_code == 200 and r.headers["content-type"].startswith("text/plain")
        assert "/v1/chat/completions" in r.text and "mistwatch_budget_exhausted" in r.text
        assert c.get("/api/agent-config").status_code == 401
        c.post("/api/setup", json={"username": "daniel", "password": "correct horse battery"}, headers={"x-mw": "1"})
        out = c.get("/api/agent-config").json()
        assert [t["tool"] for t in out] == ["opencode", "pi", "vibe", "env"]
        assert all("/v1" in t["content"] for t in out)
        assert "MISTWATCH_TOKEN" in out[0]["content"]
