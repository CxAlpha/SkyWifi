import os
import shutil
import subprocess
import sys

ROOT = os.path.dirname(os.path.abspath(__file__))
SCRIPT = os.path.join(ROOT, "build.sh")

if not os.path.isfile(SCRIPT):
    raise SystemExit("build.sh not found")

bash = shutil.which("bash")
if not bash:
    raise SystemExit(
        "Bash was not found. Run this from Git Bash, WSL, or an OpenWrt/Linux build host."
    )

raise SystemExit(subprocess.call([bash, SCRIPT], cwd=ROOT))
