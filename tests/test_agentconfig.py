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
