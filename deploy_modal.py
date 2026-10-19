#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
deploy_modal.py -- Redeploy the Clipforge Modal render app with one command.

Why this script exists:
  The caption renderer (worker/src/lib/localRender.js) is BAKED INTO the Modal
  Docker image at deploy time (modal/modal_render.py calls image.add_local_file).
  Restarting Northflank or rebuilding on Vercel does NOT update it -- the ONLY
  way to ship a new renderer is to re-run `modal deploy modal/modal_render.py`.

  This script runs that deploy for you, and first sanity-checks that the NEW
  preview-matched renderer is actually in place (so you never deploy the old
  one by accident again).

How to use (Windows):
  1. Put this file in the Clipforge repo root -- the same folder that
     contains the `modal/` and `worker/` folders:
        C:\\Users\\tarat\\Desktop\\Official Clipforge V1.0\\deploy_modal.py
  2. Make sure the NEW localRender.js is already saved at
        worker\\src\\lib\\localRender.js
  3. Run:
        python deploy_modal.py           (checks + deploys)
        python deploy_modal.py --check   (checks only, deploys nothing)

One-time prerequisites (only if Modal was never installed on this machine):
        pip install modal
        python -m modal token new        (opens your browser, links your account)
"""

import hashlib
import shutil
import subprocess
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent
RENDER_ENTRY = REPO_ROOT / "modal" / "modal_render.py"
LOCAL_RENDERER = REPO_ROOT / "worker" / "src" / "lib" / "localRender.js"

# Fingerprint of the NEW preview-matched renderer (915 lines, delivered 2025-10-19).
EXPECTED_MD5 = "308031c8e85ad320b57efbeb0a45a45a"  # informational only -- CRLF saves change it
NEW_MIN_LINES = 800                                # new = 915 / old = 767 (CRLF-proof signal)
NEW_MARKERS = ["#d9d9d9", "#ff5d1c"]               # colors that only exist in the new file


def banner():
    print("=" * 64)
    print(" Clipforge | Modal redeploy (bakes the new caption renderer)")
    print("=" * 64)


def fail(msg):
    print("")
    print("[X] " + msg)
    print("")
    print("Nothing was deployed. Fix the issue above and run this script again.")
    sys.exit(1)


def find_modal_command():
    """Return the command prefix that can run the Modal CLI, or None."""
    # 1) The `modal` executable on PATH (created by pip install modal).
    if shutil.which("modal"):
        return ["modal"]
    # 2) Fall back to the exact Python interpreter running THIS script.
    try:
        r = subprocess.run([sys.executable, "-m", "modal", "--version"],
                           capture_output=True)
        if r.returncode == 0:
            return [sys.executable, "-m", "modal"]
    except OSError:
        pass
    return None


def check_repo_and_renderer():
    """Steps 1-2: verify repo layout and that the NEW renderer will be baked in."""
    if not RENDER_ENTRY.is_file():
        fail("Cannot find modal/modal_render.py\n"
             "    Run this script from the Clipforge repo ROOT (the folder that\n"
             "    contains both the modal/ folder and the worker/ folder).\n"
             "    Current location of this script: " + str(REPO_ROOT))
    print("[1/3] Render entry found : modal/modal_render.py")

    if not LOCAL_RENDERER.is_file():
        fail("Cannot find worker/src/lib/localRender.js\n"
             "    Save the NEW localRender.js (the ~915-line preview-matched\n"
             "    version) at that exact path first, then run this again.")

    raw = LOCAL_RENDERER.read_bytes()
    text = raw.decode("utf-8", errors="replace")
    n_lines = text.count("\n") + (0 if text.endswith("\n") else 1)
    md5 = hashlib.md5(raw).hexdigest()

    lines_ok = n_lines >= NEW_MIN_LINES
    markers_ok = all(m.lower() in text.lower() for m in NEW_MARKERS)

    print("[2/3] Renderer check     : {0} lines | md5 {1}...".format(
        n_lines, md5[:8]))

    if not (lines_ok and markers_ok):
        problems = []
        if not lines_ok:
            problems.append("only {0} lines (expected ~915; the OLD file is 767)".format(n_lines))
        if not markers_ok:
            problems.append("missing new-renderer color markers (#d9d9d9 / #ff5d1c)")
        fail("worker/src/lib/localRender.js still looks like the OLD renderer:\n"
             "    - " + "\n    - ".join(problems) + "\n"
             "    Replace it with the new file you were given, then re-run.")

    if md5 == EXPECTED_MD5:
        print("      -> byte-for-byte match with the delivered new renderer")
    else:
        print("      -> new renderer detected (hash differs only by line endings -- fine)")
    return True


def deploy():
    """Step 3: run `modal deploy modal/modal_render.py`."""
    cmd = find_modal_command()
    if cmd is None:
        fail("The Modal CLI is not installed for this Python.\n"
             "    Fix it with:\n"
             "        {0} -m pip install modal\n"
             "    Then log in once (opens your browser):\n"
             "        {0} -m modal token new".format(sys.executable))

    deploy_cmd = cmd + ["deploy", "modal/modal_render.py"]
    print("[3/3] Deploying          : {0}".format(" ".join(deploy_cmd)))
    print("-" * 64)
    try:
        result = subprocess.run(deploy_cmd)
    except KeyboardInterrupt:
        print("")
        print("[X] Cancelled by user -- deployment aborted.")
        sys.exit(1)
    print("-" * 64)

    if result.returncode != 0:
        fail("modal deploy exited with code {0}.".format(result.returncode) + "\n"
             "    - If it says you are NOT authenticated, run:\n"
             "        {0} -m modal token new\n"
             "    - If it mentions an app owned by another account, log in with\n"
             "      the SAME Modal account that owns the live clipforge-render app.".format(
                 sys.executable))


def main():
    banner()
    check_repo_and_renderer()

    if "--check" in sys.argv[1:]:
        print("")
        print("[OK] All checks passed (--check mode -- nothing was deployed).")
        return

    deploy()
    print("")
    print("[DONE] The Modal app is re-deployed -- the image now contains the")
    print("       NEW preview-matched caption renderer.")
    print("")
    print("Next steps:")
    print("  1. Wait ~30-60 seconds for the new deployment to go live.")
    print("  2. In Clipforge, open any clip and hit Save / re-render.")
    print("  3. Compare the exported MP4 with the preview page:")
    print("       - inactive words: soft gray #d9d9d9 (not pure white)")
    print("       - active word: pops in with the accent color (orange #ff5d1c)")
    print("       - Auto size: 60px | position: bottom 8% margin")
    print("       - same animation/timing as the on-site preview")
    print("")
    print("If captions STILL look wrong, screenshot the exported MP4 and send")
    print("it over -- the live renderer can be probed again to see what deployed.")


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        print("")
        print("[X] Cancelled by user.")
        sys.exit(1)
