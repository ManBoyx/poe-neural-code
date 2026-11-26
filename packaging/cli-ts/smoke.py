"""Démarre l'interface de l'exécutable dans un pseudo-terminal (100 x 30), avec des données jetables, et vérifie
qu'au bout de 6 s elle tourne encore ET que l'écran rendu (pyte) montre l'accueil ou le choix du modèle. Usage : smoke.py CHEMIN/Eclipse"""
import fcntl, os, pty, select, shutil, struct, sys, tempfile, termios, time
import pyte

binary = os.path.abspath(sys.argv[1])
cols, rows = 100, 30
tmp = tempfile.mkdtemp(prefix="eclipse-smoke-")
try:
    for d in ("home", "projet", "data"):
        os.makedirs(os.path.join(tmp, d))
    pid, fd = pty.fork()
    if pid == 0:
        os.chdir(os.path.join(tmp, "projet"))
        os.environ.update(HOME=os.path.join(tmp, "home"), PNC_HOME=os.path.join(tmp, "data"), ECLIPSE_PROJECTS=os.path.join(tmp, "home", "Projets"),
                          TERM="xterm-256color", COLUMNS=str(cols), LINES=str(rows))
        os.execv(binary, [binary])
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))
    screen = pyte.Screen(cols, rows)
    stream = pyte.ByteStream(screen)
    end = time.time() + 6
    closed = False
    while time.time() < end:
        r, _, _ = select.select([fd], [], [], 0.1)
        if r:
            try:
                data = os.read(fd, 65536)
            except OSError:
                data = b""
            if not data:  # terminal fermé avant la fin du délai : échec, même si le processus vit encore
                closed = True
                break
            stream.feed(data)
    alive = not closed and os.waitpid(pid, os.WNOHANG) == (0, 0)
    text = "\n".join(line.rstrip() for line in screen.display)
    try:
        os.kill(pid, 9)
        os.waitpid(pid, 0)
    except (ProcessLookupError, ChildProcessError):
        pass
    # accueil, ou au tout premier lancement (aucun modèle choisi) le sélecteur de modèle
    drawn = any(m in text for m in ("Eclipse 5", "Demandez", "Choisir un modèle"))
    if not alive or not drawn:
        print("échec : " + ("terminal fermé avant 6 s" if closed else "l'interface s'est arrêtée" if not alive else "accueil non dessiné") + "\n" + text, file=sys.stderr)
        sys.exit(1)
    print("interface : démarrage vérifié (accueil affiché, toujours en marche après 6 s)")
finally:
    shutil.rmtree(tmp, ignore_errors=True)
