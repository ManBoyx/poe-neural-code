"""Manifeste de mise à jour : signatures obligatoires, SHA-256 exactes, notes tirées du CHANGELOG."""
import hashlib
import importlib.util
import json
from pathlib import Path

import pytest

spec = importlib.util.spec_from_file_location("make_manifest", Path(__file__).parents[1] / "packaging/release/make_manifest.py")
mm = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mm)


def make(folder: Path, name: str, data: bytes, sig: bool = True) -> str:
    (folder / name).write_bytes(data)
    if sig:
        (folder / (name + ".sig")).write_text("c2lnbmF0dXJl\n")
    return hashlib.sha256(data).hexdigest()


def test_manifest_contents(tmp_path):
    a = make(tmp_path, "Eclipse_1.2.0_amd64.AppImage", b"appimage")
    d = make(tmp_path, "Eclipse_1.2.0_amd64.deb", b"deb")
    w = make(tmp_path, "Eclipse_1.2.0_x64-setup.exe", b"nsis")
    make(tmp_path, "Eclipse_1.2.0_x64_portable.zip", b"zip", sig=False)
    make(tmp_path, "Eclipse-1.2.0.apk", b"apk", sig=False)
    cl = tmp_path / "CHANGELOG.md"
    cl.write_text("# Journal\n\n## 1.2.0 — 2026-12-01\n- nouveauté A\n- correctif B\n\n## 1.1.0\n- ancien\n", encoding="utf-8")
    m, sums = mm.build("1.2.0", "ManBoyx/eclipse-releases", tmp_path, cl, pub_date="2026-12-01T00:00:00Z")
    assert m["notes"] == "- nouveauté A\n- correctif B"
    p = m["platforms"]
    assert p["linux-x86_64-appimage"]["sha256"] == a and p["linux-x86_64"]["sha256"] == a
    assert p["linux-x86_64-deb"]["sha256"] == d
    assert p["windows-x86_64-nsis"]["url"].endswith("/v1.2.0/Eclipse_1.2.0_x64-setup.exe")
    assert p["windows-x86_64-nsis"]["sha256"] == w and p["windows-x86_64-nsis"]["signature"] == "c2lnbmF0dXJl"
    assert "linux-x86_64-rpm" not in p
    lines = sums.splitlines()
    assert len(lines) == 5 and not any(l.endswith(".sig") for l in lines)
    assert f"{a}  Eclipse_1.2.0_amd64.AppImage" in lines
    json.dumps(m)


def test_missing_signature_refuses(tmp_path):
    make(tmp_path, "Eclipse_1.2.0_amd64.AppImage", b"x", sig=False)
    with pytest.raises(SystemExit, match="signature manquante"):
        mm.build("1.2.0", "r/r", tmp_path, None)


def test_cli_writes_files(tmp_path):
    make(tmp_path, "Eclipse_1.2.0_x64_en-US.msi", b"msi")
    assert mm.main(["--version", "v1.2.0", "--repo", "r/r", "--dir", str(tmp_path)]) == 0
    m = json.loads((tmp_path / "latest.json").read_text())
    assert m["version"] == "1.2.0" and "windows-x86_64-msi" in m["platforms"]
    assert (tmp_path / "SHA256SUMS").read_text().count("\n") == 1
