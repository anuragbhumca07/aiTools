import asyncio
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

try:
    import edge_tts
    TTS_AVAILABLE = True
except ImportError:
    TTS_AVAILABLE = False

app = Flask(__name__)
CORS(app)

PORT         = int(os.environ.get("PORT", 3002))
BASE_URL     = os.environ.get("BASE_URL", f"http://localhost:{PORT}")
GROQ_API_KEY = os.environ.get("GROQ_API_KEY", "")

VIDEOS_DIR = os.path.join(os.path.dirname(__file__), "videos")
os.makedirs(VIDEOS_DIR, exist_ok=True)

TTS_VOICE = "en-US-AriaNeural"   # free Microsoft neural voice via edge-tts

# ---------------------------------------------------------------------------
# TTS helpers
# ---------------------------------------------------------------------------

async def _tts_async(text: str, path: str) -> None:
    communicate = edge_tts.Communicate(text, TTS_VOICE)
    await communicate.save(path)


def generate_tts(text: str, path: str) -> float:
    """
    Render `text` to `path` (MP3) using edge-tts.
    Returns audio duration in seconds.
    """
    asyncio.run(_tts_async(text, path))

    # get duration via ffprobe (ffprobe ships with every Manim Docker image)
    r = subprocess.run(
        [
            "ffprobe", "-v", "quiet",
            "-show_entries", "format=duration",
            "-of", "default=noprint_wrappers=1:nokey=1",
            path,
        ],
        capture_output=True, text=True,
    )
    try:
        return float(r.stdout.strip())
    except ValueError:
        return 3.0   # safe fallback


# ---------------------------------------------------------------------------
# Manim scene template
# ---------------------------------------------------------------------------
# Placeholders filled via .format():
#   {topic_repr}          repr() of topic string
#   {steps_repr}          repr() of list[str]
#   {audio_files_repr}    repr() of list[str|None]  (paths or empty list)
#   {audio_durations_repr} repr() of list[float]
# ---------------------------------------------------------------------------
SCENE_TEMPLATE = """\
from manim import *
import textwrap

TOPIC        = {topic_repr}
STEPS        = {steps_repr}
AUDIO_FILES  = {audio_files_repr}
AUDIO_DURS   = {audio_durations_repr}

class ExplainerScene(Scene):
    def construct(self):
        self.camera.background_color = "#0f0f23"

        # ── Title ──────────────────────────────────────────────────────────
        title = Text(TOPIC, font_size=44, weight=BOLD, color=WHITE)
        line  = Line(LEFT*3.5, RIGHT*3.5, color="#05bfdb", stroke_width=3)
        line.next_to(title, DOWN, buff=0.18)
        title_grp = VGroup(title, line)

        # narrate topic while title animates
        if AUDIO_FILES and len(AUDIO_FILES) > len(STEPS):
            self.add_sound(AUDIO_FILES[-1])          # last slot = title audio

        self.play(Write(title), run_time=1.2)
        self.play(Create(line), run_time=0.5)
        self.wait(0.8)
        self.play(title_grp.animate.scale(0.5).to_corner(UL, buff=0.4))

        # ── Steps ──────────────────────────────────────────────────────────
        clrs = ["#05bfdb","#7c3aed","#e94560","#f5a623","#00c853",
                "#ff6b6b","#4ecdc4","#45b7d1","#96ceb4","#ffeaa7"]
        n = len(STEPS)

        for i, step in enumerate(STEPS):
            c = clrs[i % len(clrs)]

            badge_bg  = Circle(radius=0.4, color=c, fill_color=c,
                               fill_opacity=0.15, stroke_width=2.5)
            badge_num = Text(str(i+1), font_size=22, color=c, weight=BOLD)
            badge     = VGroup(badge_bg, badge_num)

            wrapped = "\\n".join(textwrap.wrap(step, 50))
            txt     = Text(wrapped, font_size=28, line_spacing=1.4, color=WHITE)
            txt.next_to(badge, RIGHT, buff=0.5)
            group = VGroup(badge, txt).move_to(ORIGIN + UP*0.1)

            bar_bg = Rectangle(width=6.5, height=0.08,
                               fill_color=GREY_D, fill_opacity=0.4, stroke_opacity=0)
            bar    = Rectangle(width=max(0.1, 6.5*(i+1)/n), height=0.08,
                               fill_color=c, fill_opacity=0.7, stroke_opacity=0)
            bar_bg.to_edge(DOWN, buff=0.6)
            bar.align_to(bar_bg, LEFT).move_to(bar_bg.get_center()).align_to(bar_bg, LEFT)
            prog = VGroup(bar_bg, bar)

            # start audio for this step
            if AUDIO_FILES and i < len(AUDIO_FILES) and AUDIO_FILES[i]:
                self.add_sound(AUDIO_FILES[i])

            write_t = max(0.8, min(1.8, len(step) * 0.03))
            anim_t  = 0.45 + write_t          # badge_grow + write_text

            self.play(GrowFromCenter(badge_bg), FadeIn(badge_num, scale=0.5),
                      run_time=0.45)
            self.play(Write(txt), FadeIn(bar_bg), FadeIn(bar), run_time=write_t)

            # wait until speech finishes
            audio_dur = AUDIO_DURS[i] if (AUDIO_DURS and i < len(AUDIO_DURS)) else 2.5
            wait_t    = max(0.4, audio_dur - anim_t)
            self.wait(wait_t)

            self.play(FadeOut(group), FadeOut(prog),
                      run_time=0.45 if i < n-1 else 0.6)

        # ── End card ───────────────────────────────────────────────────────
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
# AI solver prompt
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


def ai_solve(problem: str, api_key: str = ""):
    key = api_key or GROQ_API_KEY
    if not key:
        raise ValueError("Groq API key is required")

    payload = {
        "model": "llama-3.3-70b-versatile",
        "messages": [{"role": "user", "content": SOLVE_PROMPT.format(problem=problem)}],
        "temperature": 0.3,
        "max_tokens": 1024,
    }
    resp = requests.post(
        "https://api.groq.com/openai/v1/chat/completions",
        json=payload,
        headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json"},
        timeout=30,
    )
    if not resp.ok:
        try:
            detail = resp.json().get("error", {}).get("message", resp.text[:300])
        except Exception:
            detail = resp.text[:300]
        raise requests.HTTPError(f"{resp.status_code}: {detail}", response=resp)

    raw = resp.json()["choices"][0]["message"]["content"].strip()
    if raw.startswith("```"):
        raw = raw.split("```")[1]
        if raw.startswith("json"):
            raw = raw[4:]
        raw = raw.strip()

    data  = json.loads(raw)
    topic = str(data["topic"]).strip()
    steps = [str(s).strip() for s in data["steps"] if str(s).strip()]
    if not topic or not steps:
        raise ValueError("AI returned empty topic or steps")
    return topic, steps


# ---------------------------------------------------------------------------
# Render (with optional TTS)
# ---------------------------------------------------------------------------

def render_video(topic: str, steps: list) -> str:
    """Render Manim video with TTS narration. Returns video_id."""

    tmp_dir = tempfile.mkdtemp(prefix="manim_")
    try:
        # ── Generate TTS audio ──────────────────────────────────────────────
        audio_files: list = []
        audio_durations: list = []

        if TTS_AVAILABLE:
            for i, step in enumerate(steps):
                mp3_path = os.path.join(tmp_dir, f"step_{i}.mp3")
                try:
                    dur = generate_tts(step, mp3_path)
                    audio_files.append(mp3_path)
                    audio_durations.append(dur)
                except Exception:
                    audio_files.append(None)
                    audio_durations.append(2.5)

            # title narration appended at the end of the list
            title_mp3 = os.path.join(tmp_dir, "title.mp3")
            try:
                generate_tts(topic, title_mp3)
                audio_files.append(title_mp3)
            except Exception:
                audio_files.append(None)

        # ── Write scene ─────────────────────────────────────────────────────
        scene_source = SCENE_TEMPLATE.format(
            topic_repr=repr(topic),
            steps_repr=repr(steps),
            audio_files_repr=repr(audio_files),
            audio_durations_repr=repr(audio_durations),
        )
        scene_file = os.path.join(tmp_dir, "scene.py")
        with open(scene_file, "w", encoding="utf-8") as f:
            f.write(scene_source)

        # ── Render ──────────────────────────────────────────────────────────
        result = subprocess.run(
            [
                "manim", "render",
                scene_file, "ExplainerScene",
                "--media_dir", tmp_dir,
                "-ql", "--disable_caching",
            ],
            capture_output=True, text=True, timeout=300,
        )
        if result.returncode != 0:
            stderr = result.stderr[-2000:] if result.stderr else ""
            stdout = result.stdout[-1000:] if result.stdout else ""
            raise RuntimeError(f"Manim render failed: {stderr or stdout}")

        mp4_files = glob.glob(os.path.join(tmp_dir, "**", "*.mp4"), recursive=True)
        if not mp4_files:
            raise RuntimeError("Rendered video not found")

        video_id = str(uuid.uuid4())
        dst_path  = os.path.join(VIDEOS_DIR, f"{video_id}.mp4")
        shutil.move(mp4_files[0], dst_path)
        return video_id

    except subprocess.TimeoutExpired:
        raise RuntimeError("Render timed out (300 s limit)")
    finally:
        shutil.rmtree(tmp_dir, ignore_errors=True)


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------

@app.route("/health")
def health():
    return jsonify({"ok": True, "tts": TTS_AVAILABLE})


@app.route("/videos/<path:filename>")
def serve_video(filename):
    return send_from_directory(VIDEOS_DIR, filename)


@app.route("/api/solve", methods=["POST"])
def solve():
    data    = request.get_json(force=True, silent=True) or {}
    problem = (data.get("problem") or "").strip()
    api_key = (data.get("groq_api_key") or "").strip()

    if not problem:
        return jsonify({"success": False, "error": "problem is required"}), 400

    try:
        topic, steps = ai_solve(problem, api_key)
    except ValueError as e:
        return jsonify({"success": False, "error": str(e)}), 400
    except requests.HTTPError as e:
        return jsonify({"success": False, "error": f"AI API error: {e}"}), 502
    except (json.JSONDecodeError, KeyError):
        return jsonify({"success": False, "error": "AI returned malformed response. Try again."}), 502
    except Exception as e:
        return jsonify({"success": False, "error": str(e)}), 500

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
    data  = request.get_json(force=True, silent=True) or {}
    topic = (data.get("topic") or "").strip()
    steps = data.get("steps", [])

    if not topic:
        return jsonify({"success": False, "error": "topic is required"}), 400
    if not isinstance(steps, list) or len(steps) == 0:
        return jsonify({"success": False, "error": "steps must be a non-empty list"}), 400

    steps = [str(s).strip() for s in steps if str(s).strip()]
    if not steps:
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


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=PORT, debug=False)
