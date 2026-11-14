# Recette PyInstaller du moteur Eclipse (dossier « onedir » : démarrage rapide, pas d'extraction temporaire,
# moins de faux positifs antivirus sous Windows qu'un exécutable unique).
# Construction : pyinstaller --noconfirm --distpath dist --workpath build packaging/engine/eclipse-engine.spec
from PyInstaller.utils.hooks import collect_data_files, collect_submodules, copy_metadata

hidden = []
# keyring choisit son trousseau à l'exécution : secretstorage/jeepney (Linux), win32ctypes (Windows) doivent être inclus.
for pkg in ("poe_neural_code", "textual", "rich", "uvicorn", "mcp", "keyring", "httpx", "anyio", "secretstorage", "jeepney", "win32ctypes"):
    try:
        hidden += collect_submodules(pkg, filter=lambda n: not n.startswith("mcp.cli"))
    except Exception:
        pass

datas = collect_data_files("textual") + collect_data_files("poe_neural_code")
for dist in ("keyring", "mcp", "textual", "SecretStorage", "jeepney"):
    try:
        datas += copy_metadata(dist)
    except Exception:
        pass

a = Analysis(
    ["eclipse_engine.py"],
    pathex=["../../src"],
    hiddenimports=hidden,
    datas=datas,
    excludes=["tkinter", "pytest", "PyInstaller"],
    noarchive=False,
)
pyz = PYZ(a.pure)
exe = EXE(pyz, a.scripts, [], exclude_binaries=True, name="eclipse-engine", console=True, upx=False)
coll = COLLECT(exe, a.binaries, a.datas, name="eclipse-engine", upx=False)
