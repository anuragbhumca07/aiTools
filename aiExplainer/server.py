import os
import uuid
import glob
import json
import shutil
import tempfile
import subprocess

import requests
from flask import Flask, jsonify, request, send_from_directory
from flask_cors import CORS

app = Flask(__name__)
CORS(app)

PORT     = int(os.environ.get("PORT", 3002))
BASE_URL = os.environ.get("BASE_URL", f"http://localhost:{PORT}")
GROQ_API_KEY = os.environ.get("GROQ_API_KEY", "")

VIDEOS_DIR = os.path.join(os.path.dirname(__file__), "videos")
os.makedirs(VIDEOS_DIR, exist_ok=True)

# ---------------------------------------------------------------------------
# Manim scene template
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
# AI solver — calls Groq to turn a problem into topic + explanation steps
# ---------------------------------------------------------------------------
SOLVE_PROMPT = """\
You are an expert tutor who solves problems and explains them clearly.

Problem: {problem}

Solve this problem completely and create a step-by-step explanation.
Return ONLY valid JSON — no markdown fences, no extra text — in this exact format:
{{
  "topic": "<short title, e.g. 'Solving System of Linear Equations'>",
  "steps": [
    "<step 1: identify what is given and what to find>",
    "<step 2: show the method / first operation>",
    "<step 3: continue working through the solution>",
    "<step 4: ...>",
    "<final step: clearly state the answer>"
  ]
}}

Rules:
- 5 to 8 steps total
- Each step is a single plain-English sentence with the actual numbers/values shown
- No LaTeX, no markdown, no bullet symbols inside the strings
- The final step must state the complete answer explicitly
"""

def ai_solve(problem: str):
    """Call Groq to solve `problem` and return (topic, steps) or raise."""
    if not GROQ_API_KEY:
        raise ValueError("GROQ_API_KEY environment variable is not set")

    payload = {
        "model": "llama3-70b-8192",
        "messages": [
            {"role": "user", "content": SOLVE_PROMPT.format(problem=problem)}
        ],
        "temperature": 0.3,
        "max_tokens": 1024,
    }
    resp = requests.post(
        "https://api.groq.com/openai/v1/chat/completions",
        json=payload,
        headers={
            "Authorization": f"Bearer {GROQ_API_KEY}",
            "Content-Type": "application/json",
        },
        timeout=30,
    )
    resp.raise_for_status()

    raw = resp.json()["choices"][0]["message"]["content"].strip()

    # Strip markdown fences if the model added them anyway
    if raw.startswith("```"):
        raw = raw.split("```")[1]
        if raw.startswith("json"):
            raw = raw[4:]
        raw = raw.strip()

    data = json.loads(raw)
    topic = str(data["topic"]).strip()
    steps = [str(s).strip() for s in data["steps"] if str(s).strip()]

    if not topic or not steps:
        raise ValueError("AI returned empty topic or steps")

    return topic, steps


# ---------------------------------------------------------------------------
# Shared Manim rendering logic
# ---------------------------------------------------------------------------
def render_video(topic: str, steps: list[str]):
    """Render a Manim video for `topic` / `steps`. Returns video_id."""
    scene_source = SCENE_TEMPLATE.format(
        topic_repr=repr(topic),
        steps_repr=repr(steps),
    )

    tmp_dir = tempfile.mkdtemp(prefix="manim_")
    try:
        scene_file = os.path.join(tmp_dir, "scene.py")
        with open(scene_file, "w", encoding="utf-8") as f:
            f.write(scene_source)

        result = subprocess.run(
            [
                "manim", "render",
                scene_file, "ExplainerScene",
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
            raise RuntimeError(f"Manim render failed: {stderr or stdout}")

        mp4_files = glob.glob(os.path.join(tmp_dir, "**", "*.mp4"), recursive=True)
        if not mp4_files:
            raise RuntimeError("Rendered video not found")

        video_id = str(uuid.uuid4())
        dst_path = os.path.join(VIDEOS_DIR, f"{video_id}.mp4")
        shutil.move(mp4_files[0], dst_path)
        return video_id

    except subprocess.TimeoutExpired:
        raise RuntimeError("Render timed out (180 s limit)")
    finally:
        shutil.rmtree(tmp_dir, ignore_errors=True)


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------

@app.route("/health")
def health():
    return jsonify({"ok": True})


@app.route("/videos/<path:filename>")
def serve_video(filename):
    return send_from_directory(VIDEOS_DIR, filename)


@app.route("/api/solve", methods=["POST"])
def solve():
    """
    Accept a problem description, solve it with AI, render explanation video.
    Body: { "problem": "..." }
    """
    data    = request.get_json(force=True, silent=True) or {}
    problem = (data.get("problem") or "").strip()

    if not problem:
        return jsonify({"success": False, "error": "problem is required"}), 400

    # Step 1 — AI solve
    try:
        topic, steps = ai_solve(problem)
    except ValueError as e:
        return jsonify({"success": False, "error": str(e)}), 400
    except requests.HTTPError as e:
        return jsonify({"success": False, "error": f"AI API error: {e}"}), 502
    except (json.JSONDecodeError, KeyError):
        return jsonify({"success": False, "error": "AI returned malformed response. Try again."}), 502
    except Exception as e:
        return jsonify({"success": False, "error": str(e)}), 500

    # Step 2 — Manim render
    try:
        video_id = render_video(topic, steps)
    except RuntimeError as e:
        return jsonify({"success": False, "error": str(e)}), 500
    except Exception as e:
        return jsonify({"success": False, "error": str(e)}), 500

    return jsonify({
        "success":  True,
        "videoUrl": f"{BASE_URL}/videos/{video_id}.mp4",
        "topic":    topic,
        "steps":    steps,
    })


@app.route("/api/explain", methods=["POST"])
def explain():
    """
    Manual mode: caller provides topic + steps directly.
    Body: { "topic": "...", "steps": ["...", ...] }
    """
    data  = request.get_json(force=True, silent=True) or {}
    topic = (data.get("topic") or "").strip()
    steps = data.get("steps", [])

    if not topic:
        return jsonify({"success": False, "error": "topic is required"}), 400
    if not isinstance(steps, list) or len(steps) == 0:
        return jsonify({"success": False, "error": "steps must be a non-empty list"}), 400

    steps = [str(s).strip() for s in steps if str(s).strip()]
    if len(steps) == 0:
        return jsonify({"success": False, "error": "steps must contain at least one non-empty step"}), 400
    if len(steps) > 10:
        return jsonify({"success": False, "error": "maximum 10 steps allowed"}), 400

    try:
        video_id = render_video(topic, steps)
    except RuntimeError as e:
        return jsonify({"success": False, "error": str(e)}), 500
    except Exception as e:
        return jsonify({"success": False, "error": str(e)}), 500

    return jsonify({
        "success":  True,
        "videoUrl": f"{BASE_URL}/videos/{video_id}.mp4",
        "topic":    topic,
        "steps":    steps,
    })


# ---------------------------------------------------------------------------
if __name__ == "__main__":
    app.run(host="0.0.0.0", port=PORT, debug=False)
