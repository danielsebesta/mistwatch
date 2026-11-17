import time

import httpx
import pytest
from fastapi.testclient import TestClient

from mistwatch.config import Config
from mistwatch.db import DB
from mistwatch.modelnames import ModelNames, autoname
from mistwatch.proxy import create_app
from mistwatch.usage import usage

H = {"x-mw": "1"}


@pytest.mark.parametrize("raw,pretty", [
    ("zai-glm-5-3-flash", "GLM 5.3 Flash"),
    ("zai-glm-5-3", "GLM 5.3"),
    ("mistral-large-4-0", "Mistral Large 4"),
    ("ministral-3b-2512", "Ministral 3B (2512)"),
    ("deepseek-v4-1-flash-1017", "DeepSeek V4.1 Flash (1017)"),
    ("labs-leanstral-1-5-1", "Labs Leanstral 1.5.1"),
    ("voxtral-mini-tts-2603", "Voxtral Mini TTS (2603)"),
    ("mistral-embed-2312", "Mistral Embed (2312)"),
    ("foo-latest", "Foo (latest)"),
    ("mistral-medium-3.5", "Mistral Medium 3.5"),
])
def test_autoname(raw, pretty):
    assert autoname(raw) == pretty


def test_builtin_table_beats_prettifier_and_covers_aliases():
    n = ModelNames(DB(":memory:"))
    assert n.resolve("deepseek-v4-1-flash-1017") == ("DeepSeek V4.1 Flash", "built-in")
    for alias in ("mistral-large-4-0", "mistral-large-4", "mistral-large-latest"):
        assert n.display(alias) == "Mistral Large 4"
    assert n.display("mistral-vibe-cli-latest") == "Mistral Medium 3.5"
    assert n.resolve("something-new-7b") == ("Something New 7B", "auto")
    assert n.display(None) == "(unknown)"


def test_override_wins_and_can_be_reset():
    n = ModelNames(DB(":memory:"))
    n.set_override("zai-glm-5-3", "Big GLM")
    assert n.resolve("zai-glm-5-3") == ("Big GLM", "custom")
    n.clear_override("zai-glm-5-3")
    assert n.display("zai-glm-5-3") == "GLM 5.3"
    with pytest.raises(ValueError):
        n.set_override("x", "   ")


def test_catalog_groups_aliases_and_uses_mistral_names():
    db = DB(":memory:")
    n = ModelNames(db)
    with db.lock:
        db.conn.executemany("INSERT INTO model_catalog(model_id,name,aliases,description) VALUES(?,?,?,?)", [
            ("mistral-ocr-latest", "Mistral OCR 4.1", '["mistral-ocr-4"]', None),
            ("mistral-ocr-4", "Mistral OCR 4.1", '["mistral-ocr-latest"]', None),
            ("brand-new-1", "brand-new-1", "[]", "desc")])
        db.conn.commit()
    n.reload()
    assert n.resolve("mistral-ocr-4") == ("Mistral OCR 4.1", "mistral")  # the API's own display name
    assert n.group_key("mistral-ocr-latest") == n.group_key("mistral-ocr-4")
    n.set_override("mistral-ocr-4", "OCR")  # one override covers every alias in the group
    assert n.display("mistral-ocr-latest") == "OCR"


def test_chart_merges_aliases_into_one_series():
    db = DB(":memory:")
    now = time.time()
    for i, m in enumerate(["mistral-large-4-0", "mistral-large-latest", "mistral-large-4"]):
        db.add_ledger(ts=now - 60 * i, account="a", pool="vibe", client="c", model=m, endpoint="e", cost_eur=1.0, source="proxy")
    u = usage(db, "7d", "model", now)
    assert [(s["name"], round(s["total"], 2)) for s in u["series"]] == [("Mistral Large 4", 3.0)]


def test_api_listing_rename_refresh_and_ledger(tmp_path):
    def handler(req: httpx.Request):
        if req.url.path == "/v1/models":
            return httpx.Response(200, json={"data": [
                {"id": "mistral-large-4-0", "name": "mistral-large-4", "aliases": ["mistral-large-latest"], "description": "Large"},
                {"id": "mistral-large-latest", "name": "mistral-large-4", "aliases": ["mistral-large-4-0"]}]})
        return httpx.Response(404)
    app = create_app(Config(db_path=tmp_path / "n.db"))
    with TestClient(app) as c:
        st = app.state.mw
        st.http = httpx.AsyncClient(transport=httpx.MockTransport(handler))
        assert c.get("/api/models").status_code == 401
        c.post("/api/setup", json={"username": "daniel", "password": "correct horse battery"}, headers=H)
        c.post("/api/accounts", json={"name": "a"}, headers=H)
        st.store.set_key("a", "vibe", value="key-12345678")
        st.reload_accounts()
        st.db.add_ledger(ts=time.time(), account="a", pool="vibe", client="c", model="mistral-large-latest", endpoint="e", cost_eur=0.1, source="proxy")
        assert c.post("/api/models-refresh", headers=H).json() == {"models": 2}
        rows = {r["key"]: r for r in c.get("/api/models").json()}
        assert rows["mistral-large-4"]["display"] == "Mistral Large 4" and rows["mistral-large-4"]["calls"] == 1
        assert sorted(rows["mistral-large-4"]["ids"]) == ["mistral-large-4-0", "mistral-large-latest"]
        assert c.put("/api/models/mistral-large-4", json={"display": "Large"}, headers=H).status_code == 200
        assert c.get("/api/ledger?limit=5").json()[0]["model_name"] == "Large"
        assert c.put("/api/models/mistral-large-4", json={"display": ""}, headers=H).status_code == 400
        assert c.delete("/api/models/mistral-large-4", headers=H).status_code == 200
        assert c.get("/api/ledger?limit=5").json()[0]["model_name"] == "Mistral Large 4"
