from pathlib import Path

p = Path("modal_render.py")
src = p.read_text(encoding="utf-8")
lines = src.split("\n")

# 1) delete EVERY existing stored_path assignment, whatever its indentation
lines = [l for l in lines if not l.strip().startswith("stored_path = os.path.join(RENDERS_DIR")]
src = "\n".join(lines)

# 2) insert exactly ONE correct 4-space assignment before the EXDEV comment
marker = "    # /tmp and the Volume are different filesystems"
assign = '    stored_path = os.path.join(RENDERS_DIR, f"{render_id}.mp4")'
if assign not in src:
    src = src.replace(marker, assign + "\n" + marker, 1)

p.write_text(src, encoding="utf-8")
print("done — stored_path restored at function level (4 spaces)")