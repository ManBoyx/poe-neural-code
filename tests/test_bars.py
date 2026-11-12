from poe_neural_code.ui.bars import bar, color_for, labelled, pace
from poe_neural_code.ui.panels import render_claude
from poe_neural_code.claude_runner import ClaudeInfo


def test_bar_geometry_and_colors():
    assert bar(0, 10).plain == "░" * 10 and bar(1, 10).plain == "█" * 10
    b = bar(0.5, 10)
    assert b.plain.count("█") == 5 and len(b.plain) == 10
    assert len(bar(0.37, 20).plain) == 20 and "▏" in bar(0.011, 10).plain + "▏"  # fraction fine : case partielle
    assert bar(None, 8).plain == "░" * 8  # inconnu = barre grisée, jamais une valeur inventée
    assert bar(2.5, 10).plain == "█" * 10 and bar(-1, 10).plain == "░" * 10  # borné
    assert color_for(0.3) == "#4ade80" and color_for(0.7) == "#fbbf24" and color_for(0.85) == "#fb923c" and color_for(0.97) == "#f87171"
    assert color_for(0.97, invert=True) == "#4ade80"  # reste élevé = bon


def test_labelled_and_pace():
    t = labelled("usage", 0.95, "reset 20:00", 10)
    assert "95 %" in t.plain and "reset 20:00" in t.plain
    assert "—" in labelled("x", None).plain
    assert "rythme bas" in pace(0.3, 0.6).plain and "rythme élevé" in pace(0.9, 0.3).plain and pace(None, 0.5).plain == ""


def test_claude_block_has_usage_and_time_bars_with_pace():
    import time
    now = time.time()
    info = ClaudeInfo(rate={"unifiedWindows": {"five_hour": {"utilization": 0.92, "resetsAt": now + 3600},
                                              "seven_day": {"utilization": 0.84, "resetsAt": now + 86400 * 3}}})
    out = render_claude(info, now).plain
    assert "Usage   5 h" in out and "92 %" in out and "Temps   5 h" in out and "Usage   7 j" in out and "84 %" in out
    assert "rythme élevé" in out  # 92 % d'usage pour 80 % du temps écoulé → rythme élevé
