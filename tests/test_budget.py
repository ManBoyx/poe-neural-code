import pytest

from poe_neural_code.budget import Budget, BudgetExhausted, usd_to_points
from tests.conftest import MODEL


def commit(b, pts, kind="estimated", model="m1", tin=10, tout=5, res=None, tk="measured"):
    return b.commit(res, session_id="s", model=model, tokens_in=tin, tokens_out=tout, tokens_kind=tk, points=pts,
                    points_kind=kind, usd=None)


def test_example_600_points_30min_shared_pause_no_carry(budget, clock):
    budget.set_envelope(amount_points=600, period_s=1800, scope=["*"], on_exhaust="pause", carry_over=False)
    commit(budget, 400, model="a")
    commit(budget, 150, model="b")  # budget PARTAGÉ entre modèles
    st = budget.status(budget.envelopes()[0])
    assert st["remaining_points"] == 50
    with pytest.raises(BudgetExhausted):
        budget.reserve("s", "a", 80, 100, True)  # estimation > reste → pause
    clock.t += 1801  # renouvellement
    st = budget.status(budget.envelopes()[0])
    assert st["remaining_points"] == 600  # aucun report
    budget.reserve("s", "a", 80, 100, True)


def test_carry_over(budget, clock):
    budget.set_envelope(amount_points=600, period_s=1800, carry_over=True)
    commit(budget, 100)
    clock.t += 1800
    assert budget.status(budget.envelopes()[0])["remaining_points"] == 1100


def test_renewal_persists_across_restart(tmp_path, clock):
    b = Budget(tmp_path / "p.db", clock=clock)
    e = b.set_envelope(amount_points=600, period_s=1800)
    end = e.period_end
    commit(b, 500)
    b.close()
    clock.t += 600  # redémarrage 10 min plus tard : PAS de réinitialisation artificielle
    b2 = Budget(tmp_path / "p.db", clock=clock)
    st = b2.status(b2.envelopes()[0])
    assert st["remaining_points"] == 100 and st["renews_at"] == end
    clock.t += 1300
    assert b2.status(b2.envelopes()[0])["remaining_points"] == 600
    b2.close()


def test_reservations_prevent_double_spending(budget):
    budget.set_envelope(amount_points=100)
    r1 = budget.reserve("s", "m1", 70, 10, True)
    with pytest.raises(BudgetExhausted):
        budget.reserve("s", "m1", 70, 10, True)  # la première réserve déjà 70
    budget.release(r1)
    budget.reserve("s", "m1", 70, 10, True)


def test_held_reservations_released_on_restart(tmp_path):
    b = Budget(tmp_path / "r.db")
    b.set_envelope(amount_points=100)
    b.reserve("s", "m1", 90, 1, True)
    b.close()
    b2 = Budget(tmp_path / "r.db")
    b2.reserve("s", "m1", 90, 1, True)  # ne reste pas bloqué par un processus mort
    b2.close()


def test_warn_mode_does_not_block(budget):
    budget.set_envelope(amount_points=10, on_exhaust="warn")
    commit(budget, 50)
    r = budget.reserve("s", "m1", 5, 1, True)
    assert any("épuisé" in w for w in r.warnings)


def test_unknown_cost_cannot_guarantee_cap(budget):
    budget.set_envelope(amount_points=100)
    r = budget.reserve("s", "m1", None, None, False)
    assert not r.exact_cap_guaranteed and any("non garanti" in w for w in r.warnings)
    r2 = budget.reserve("s", "m1", 5, 10, True)
    assert r2.exact_cap_guaranteed


def test_scope_limits_to_models(budget):
    budget.set_envelope(amount_points=10, scope=["m1"])
    commit(budget, 50, model="other")  # hors portée : ne consomme pas
    assert budget.status(budget.envelopes()[0])["remaining_points"] == 10


def test_token_limit_separate_from_points(budget):
    budget.set_envelope(amount_points=None, token_limit=100)
    commit(budget, None, kind="unavailable", tin=60, tout=30)
    with pytest.raises(BudgetExhausted):
        budget.reserve("s", "m1", None, 50, True)


def test_kinds_never_mixed_in_totals(budget, clock):
    commit(budget, 10, kind="estimated")
    budget.add_manual("s", 5)
    commit(budget, None, kind="unavailable")
    t = budget.totals(0)
    assert t["points"] == {"measured": 0.0, "estimated": 10.0, "manual": 5.0}
    assert t["points_unavailable_requests"] == 1


def test_tokens_equivalent_unavailable_without_data(budget):
    assert budget.tokens_equivalent(100, MODEL, None) is None  # pas de taux
    assert budget.tokens_equivalent(100, None, 1000) is None  # pas de prix
    lo, hi = budget.tokens_equivalent(30, MODEL, 30000)  # 30 pts = 0.001 USD
    assert lo == pytest.approx(0.001 / 3e-6) and hi == pytest.approx(0.001 / 1e-6)


def test_usd_to_points_requires_rate():
    assert usd_to_points(1.0, None) is None and usd_to_points(None, 5) is None and usd_to_points(2.0, 10) == 20


def test_alerts_once_per_threshold(budget):
    budget.set_envelope(amount_points=100)
    commit(budget, 55)
    assert budget.pending_alerts() == [("temporary", 50)]
    assert budget.pending_alerts() == []
    commit(budget, 30)
    assert budget.pending_alerts() == [("temporary", 75)]


def test_invalid_envelope_rejected(budget):
    with pytest.raises(ValueError):
        budget.set_envelope(amount_points=None, token_limit=None)
    with pytest.raises(ValueError):
        budget.set_envelope(amount_points=5, on_exhaust="explode")
