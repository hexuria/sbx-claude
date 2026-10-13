"""Computer-use MCP server for the virtual XFCE desktop (DISPLAY :1, viewable over VNC).

Drives the desktop with xdotool and captures it with ImageMagick `import`.
Coordinates are screen pixels (default 1280x800), origin top-left.
"""

import os
import subprocess
import time

from mcp.server.fastmcp import FastMCP, Image

DISPLAY = os.environ.get("DISPLAY", ":1")
ENV = {**os.environ, "DISPLAY": DISPLAY}
HOME = os.path.expanduser("~")
SETTLE = 0.6  # seconds to let the UI update before an automatic screenshot

APPS = {
    "browser": [f"{HOME}/.local/bin/chromium"],
    "terminal": ["xfce4-terminal"],
    "files": ["thunar"],
}

mcp = FastMCP("desktop")


def _run(*args: str) -> str:
    out = subprocess.run(args, env=ENV, capture_output=True, text=True, timeout=30)
    if out.returncode != 0:
        raise RuntimeError(out.stderr.strip() or f"{args[0]} failed")
    return out.stdout.strip()


def _ensure_desktop() -> None:
    if subprocess.run(["xdpyinfo"], env=ENV, capture_output=True).returncode != 0:
        subprocess.run([f"{HOME}/.local/bin/desktop-start"], capture_output=True, timeout=90)


def _shot() -> Image:
    _ensure_desktop()
    png = subprocess.run(
        ["import", "-silent", "-window", "root", "png:-"], env=ENV, capture_output=True, timeout=30
    ).stdout
    return Image(data=png, format="png")


def _after(screenshot: bool, msg: str):
    if not screenshot:
        return msg
    time.sleep(SETTLE)
    return [msg, _shot()]


@mcp.tool()
def screenshot() -> Image:
    """Capture the whole desktop as a PNG."""
    return _shot()


@mcp.tool()
def screen_info() -> str:
    """Return the screen size, the cursor position and the title of the focused window."""
    _ensure_desktop()
    size = _run("xdotool", "getdisplaygeometry")
    pos = _run("xdotool", "getmouselocation")
    try:
        title = _run("xdotool", "getactivewindow", "getwindowname")
    except RuntimeError:
        title = "(none)"
    return f"screen: {size}\ncursor: {pos}\nactive window: {title}"


@mcp.tool()
def click(x: int, y: int, button: str = "left", count: int = 1, screenshot: bool = True):
    """Click at (x, y). button: left | middle | right. count=2 for double-click."""
    btn = {"left": "1", "middle": "2", "right": "3"}[button]
    _run("xdotool", "mousemove", str(x), str(y), "click", "--repeat", str(count), "--delay", "80", btn)
    return _after(screenshot, f"{button} click x{count} at ({x}, {y})")


@mcp.tool()
def move(x: int, y: int, screenshot: bool = False):
    """Move the mouse to (x, y) without clicking (e.g. to hover)."""
    _run("xdotool", "mousemove", str(x), str(y))
    return _after(screenshot, f"moved to ({x}, {y})")


@mcp.tool()
def drag(x1: int, y1: int, x2: int, y2: int, screenshot: bool = True):
    """Press the left button at (x1, y1), drag to (x2, y2) and release."""
    _run("xdotool", "mousemove", str(x1), str(y1), "mousedown", "1",
         "mousemove", "--sync", str(x2), str(y2), "mouseup", "1")
    return _after(screenshot, f"dragged ({x1}, {y1}) -> ({x2}, {y2})")


@mcp.tool()
def type_text(text: str, screenshot: bool = True):
    """Type text into the focused window. Use key() for Enter, Tab, shortcuts."""
    _run("xdotool", "type", "--delay", "12", "--", text)
    return _after(screenshot, f"typed {len(text)} chars")


@mcp.tool()
def key(keys: str, screenshot: bool = True):
    """Press a key or chord, xdotool syntax: 'Return', 'Tab', 'Escape', 'ctrl+l', 'ctrl+shift+t', 'alt+F4'.
    Several space-separated keys are pressed in sequence."""
    _run("xdotool", "key", "--delay", "60", *keys.split())
    return _after(screenshot, f"pressed {keys}")


@mcp.tool()
def scroll(x: int, y: int, direction: str = "down", amount: int = 5, screenshot: bool = True):
    """Scroll at (x, y). direction: up | down | left | right. amount = wheel clicks."""
    btn = {"up": "4", "down": "5", "left": "6", "right": "7"}[direction]
    _run("xdotool", "mousemove", str(x), str(y), "click", "--repeat", str(amount), "--delay", "30", btn)
    return _after(screenshot, f"scrolled {direction} x{amount} at ({x}, {y})")


@mcp.tool()
def launch(app: str, screenshot: bool = True):
    """Open a desktop app: browser | terminal | files."""
    _ensure_desktop()
    subprocess.Popen(APPS[app], env=ENV, start_new_session=True,
                     stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    time.sleep(2.5)
    return _after(screenshot, f"launched {app}")


@mcp.tool()
def wait(seconds: float = 1.0, screenshot: bool = True):
    """Wait for the UI to settle (max 30 s), then optionally screenshot."""
    time.sleep(max(0.0, min(seconds, 30.0)))
    return _after(screenshot, f"waited {seconds}s")


if __name__ == "__main__":
    mcp.run()
