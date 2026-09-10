"""Hide the X pointer on the hidden display. Chromium composites the cursor from the X cursor
image, so besides XFIXES HideCursor we also define a fully transparent root cursor."""
import os, sys, time
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "vendor"))
from Xlib import display, X
from Xlib.ext import xfixes

d = display.Display(sys.argv[1] if len(sys.argv) > 1 else ":99")
root = d.screen().root
# Transparent 1x1 cursor on the root window (inherited by windows using the default cursor).
pm = root.create_pixmap(1, 1, 1)
black = d.screen().black_pixel
cursor = pm.create_cursor(pm, (0, 0, 0), (0, 0, 0), 0, 0)
root.change_attributes(cursor=cursor)
if d.has_extension("XFIXES"):
    d.xfixes_query_version()
    root.xfixes_hide_cursor()
d.sync()
print("cursor blanked on", d.get_display_name())
while True:
    time.sleep(3600)
