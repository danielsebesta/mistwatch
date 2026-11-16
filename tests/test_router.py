from dast_mistral.router import decide, apply

def d(text, **kw):
    body = {"messages": [{"role": "user", "content": text}], **kw}
    return decide(body, kw.pop("name", "auto") if False else "auto", kw.get("pressure", 1.0)) if False else decide(body)

def test_trivial_goes_small():
    r = d("ahoj")
    assert r.model == "mistral-small-2603" and r.effort == "none"

def test_hard_debug_goes_up():
    r = d("Debug this race condition and refactor the architecture, think carefully:\n```py\nx=1\n```\nTraceback (most recent call last):\n  File x")
    assert r.level >= 3

def test_tools_and_agent_use_large():
    body = {"messages": [{"role": "user", "content": "Implement the migration and fix the bug in the parser"}], "tools": [{}]}
    assert decide(body).model in ("mistral-large-4-0", "zai-glm-5-3")

def test_image_never_goes_to_glm53():
    body = {"messages": [{"role": "user", "content": [{"type": "text", "text": "debug refactor optimize analyze this design " * 40},
                                                       {"type": "image_url", "image_url": "x"}]}]}
    assert decide(body).model != "zai-glm-5-3"

def test_pressure_only_downgrades():
    body = {"messages": [{"role": "user", "content": "Implement and optimize and debug this algorithm carefully " * 20}]}
    assert decide(body, pressure=0.05).level < decide(body, pressure=1.0).level

def test_auto_fast_caps_and_apply():
    body = {"messages": [{"role": "user", "content": "debug refactor optimize analyze architecture " * 80}], "reasoning_effort": "xx"}
    r = decide(body, "auto-fast")
    assert r.level <= 2
    out = apply(body, r)
    assert out["model"] == r.model and out["reasoning_effort"] == r.effort


def test_llm_score_blends_and_can_raise():
    body = {"messages": [{"role": "user", "content": "Proč mi padá vlákno?"}]}
    base = decide(body)
    raised = decide(body, llm_score=9)
    assert raised.llm_score == 9 and raised.level > base.level and ";llm=9" in raised.header()
    assert decide(body, llm_score=0).level <= base.level
