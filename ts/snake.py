import curses

def main(scr):
    scr.addstr(0, 0, "Snake")

curses.wrapper(main)
