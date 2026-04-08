import os
import uuid
import glob
import shutil
import tempfile
import subprocess

from flask import Flask, jsonify, request, send_from_directory
from flask_cors import CORS

app = Flask(__name__)
CORS(app)

PORT = int(os.environ.get("PORT", 3002))
BASE_URL = os.environ.get("BASE_URL", f"http://localhost:{PORT}")

VIDEOS_DIR = os.path.join(os.path.dirname(__file__), "videos")
os.makedirs(VIDEOS_DIR, exist_ok=True)

# ---------------------------------------------------------------------------
# Manim scene template.
# {topic_repr} and {steps_repr} are filled via .format() using repr() values,
# so they are valid Python literals (strings / lists of strings) that land
# directly in the generated source file.
# ---------------------------------------------------------------------------
SCENE_TEMPLATE = """\
from manim import *
import textwrap

TOPIC = {topic_repr}
STEPS = {steps_repr}

class ExplainerScene(Scene):
    def construct(self):
        self.camera.background_color = "#0f0f23"

        # Title
        title = Text(TOPIC, font_size=44, weight=BOLD, color=WHITE)
        line = Line(LEFT*3.5, RIGHT*3.5, color="#05bfdb", stroke_width=3)
        line.next_to(title, DOWN, buff=0.18)
        title_grp = VGroup(title, line)
        self.play(Write(title), run_time=1.2)
        self.play(Create(line), run_time=0.5)
        self.wait(0.8)
        self.play(title_grp.animate.scale(0.5).to_corner(UL, buff=0.4))

        # Step colors
        clrs = ["#05bfdb","#7c3aed","#e94560","#f5a623","#00c853",
                "#ff6b6b","#4ecdc4","#45b7d1","#96ceb4","#ffeaa7"]
        n = len(STEPS)

        for i, step in enumerate(STEPS):
            c = clrs[i % len(clrs)]

            badge_bg  = Circle(radius=0.4, color=c, fill_color=c, fill_opacity=0.15, stroke_width=2.5)
            badge_num = Text(str(i+1), font_size=22, color=c, weight=BOLD)
            badge = VGroup(badge_bg, badge_num)

            wrapped = "\\n".join(textwrap.wrap(step, 50))
            txt = Text(wrapped, font_size=28, line_spacing=1.4, color=WHITE)
            txt.next_to(badge, RIGHT, buff=0.5)

            group = VGroup(badge, txt).move_to(ORIGIN + UP*0.1)

            bar_bg = Rectangle(width=6.5, height=0.08, fill_color=GREY_D, fill_opacity=0.4, stroke_opacity=0)
            bar    = Rectangle(width=max(0.1, 6.5*(i+1)/n), height=0.08, fill_color=c, fill_opacity=0.7, stroke_opacity=0)
            bar_bg.to_edge(DOWN, buff=0.6)
            bar.align_to(bar_bg, LEFT).move_to(bar_bg.get_center()).align_to(bar_bg, LEFT)
            prog = VGroup(bar_bg, bar)

            self.play(GrowFromCenter(badge_bg), FadeIn(badge_num, scale=0.5), run_time=0.45)
            self.play(
                Write(txt),
                FadeIn(bar_bg), FadeIn(bar),
                run_time=max(0.8, min(1.8, len(step)*0.03))
            )
            self.wait(2.0)
            if i < n-1:
                self.play(FadeOut(group), FadeOut(prog), run_time=0.45)
            else:
                self.play(FadeOut(group), FadeOut(prog), run_time=0.6)

        # End card
        check = Text("\\u2713", font_size=86, color="#00c853", weight=BOLD)
        done  = Text("Complete!", font_size=44, color=WHITE, weight=BOLD)
        echo  = Text(TOPIC, font_size=24, color=GREY_A)
        done.next_to(check, DOWN, buff=0.2)
        echo.next_to(done, DOWN, buff=0.22)
        VGroup(check, done, echo).move_to(ORIGIN)
        self.play(GrowFromCenter(check), run_time=0.6)
        self.play(FadeIn(done, shift=UP*0.25), run_time=0.5)
        self.play(FadeIn(echo, shift=UP*0.2), run_time=0.45)
        self.wait(2.5)
"""


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------

@app.route("/health")
def health():
    return jsonify({"ok": True})


@app.route("/videos/<path:filename>")
def serve_video(filename):
    return send_from_directory(VIDEOS_DIR, filename)


@app.route("/api/explain", methods=["POST"])
def explain():
    data = request.get_json(force=True, silent=True) or {}

    topic = (data.get("topic") or "").strip()
    steps = data.get("steps", [])

    # ── Validation ──────────────────────────────────────────────────────────
    if not topic:
        return jsonify({"success": False, "error": "topic is required"}), 400

    if not isinstance(steps, list) or len(steps) == 0:
        return jsonify({"success": False, "error": "steps must be a non-empty list"}), 400

    steps = [str(s).strip() for s in steps if str(s).strip()]
    if len(steps) == 0:
        return jsonify({"success": False, "error": "steps must contain at least one non-empty step"}), 400

    if len(steps) > 10:
        return jsonify({"success": False, "error": "maximum 10 steps allowed"}), 400

    # ── Generate scene source ────────────────────────────────────────────────
    scene_source = SCENE_TEMPLATE.format(
        topic_repr=repr(topic),
        steps_repr=repr(steps),
    )

    tmp_dir = tempfile.mkdtemp(prefix="manim_")
    try:
        scene_file = os.path.join(tmp_dir, "scene.py")
        with open(scene_file, "w", encoding="utf-8") as f:
            f.write(scene_source)

        # ── Render ──────────────────────────────────────────────────────────
        result = subprocess.run(
            [
                "manim", "render",
                scene_file,
                "ExplainerScene",
                "--media_dir", tmp_dir,
                "-ql",
                "--disable_caching",
            ],
            capture_output=True,
            text=True,
            timeout=180,
        )

        if result.returncode != 0:
            stderr = result.stderr[-2000:] if result.stderr else ""
            stdout = result.stdout[-1000:] if result.stdout else ""
            return jsonify({
                "success": False,
                "error": "Manim render failed",
                "details": stderr or stdout,
            }), 500

        # ── Locate rendered file ─────────────────────────────────────────────
        mp4_files = glob.glob(os.path.join(tmp_dir, "**", "*.mp4"), recursive=True)
        if not mp4_files:
            return jsonify({"success": False, "error": "Rendered video not found"}), 500

        src_path = mp4_files[0]
        video_id = str(uuid.uuid4())
        dst_path = os.path.join(VIDEOS_DIR, f"{video_id}.mp4")
        shutil.move(src_path, dst_path)

    except subprocess.TimeoutExpired:
        return jsonify({"success": False, "error": "Render timed out (180 s limit)"}), 504
    except Exception as exc:
        return jsonify({"success": False, "error": str(exc)}), 500
    finally:
        shutil.rmtree(tmp_dir, ignore_errors=True)

    video_url = f"{BASE_URL}/videos/{video_id}.mp4"
    return jsonify({
        "success": True,
        "videoUrl": video_url,
        "topic": topic,
        "steps": steps,
    })


# ---------------------------------------------------------------------------
if __name__ == "__main__":
    app.run(host="0.0.0.0", port=PORT, debug=False)
