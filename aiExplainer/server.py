import asyncio
import os
import uuid
import glob
import json
import shutil
import tempfile
import subprocess

import requests
from flask import Flask, jsonify, request, send_from_directory, send_file
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

TTS_VOICE = "en-US-AriaNeural"

# Manim scene timing constants — must stay in sync with SCENE_TEMPLATE below
_TITLE_DUR  = 1.2 + 0.5 + 0.8 + 1.0   # Write + Create + wait + scale = 3.5 s
_FADE_DUR   = 0.45                       # FadeOut between steps
_BADGE_DUR  = 0.45                       # GrowFromCenter badge

# ---------------------------------------------------------------------------
# TTS helpers
# ---------------------------------------------------------------------------

async def _tts_async(text: str, path: str) -> None:
    communicate = edge_tts.Communicate(text, TTS_VOICE)
    await communicate.save(path)


def _tts_to_mp3(text: str, path: str) -> None:
    asyncio.run(_tts_async(text, path))


def _audio_duration(path: str) -> float:
    """
    Get audio duration by parsing ffmpeg -i stderr output.
    More reliable than ffprobe which may not be in PATH in some images.
    """
    r = subprocess.run(["ffmpeg", "-i", path],
                       capture_output=True, text=True)
    for line in r.stderr.split("\n"):
        if "Duration:" in line:
            try:
                dur_str = line.split("Duration:")[1].split(",")[0].strip()
                h, m, s = dur_str.split(":")
                return float(h) * 3600 + float(m) * 60 + float(s)
            except Exception:
                pass
    return 3.0


def _mp3_to_wav(mp3: str, wav: str) -> None:
    """Convert MP3 → PCM WAV (44 100 Hz stereo) for reliable concat."""
    subprocess.run(
        ["ffmpeg", "-y", "-i", mp3,
         "-ar", "44100", "-ac", "2", "-c:a", "pcm_s16le", wav],
        capture_output=True, check=True,
    )


def _silence_wav(duration_s: float, wav: str) -> None:
    """Generate a silent PCM WAV of the given duration."""
    subprocess.run(
        ["ffmpeg", "-y",
         "-f", "lavfi", "-i", "anullsrc=r=44100:cl=stereo",
         "-t", str(max(0.01, duration_s)),
         "-c:a", "pcm_s16le", wav],
        capture_output=True, check=True,
    )


def build_audio_track(
    step_mp3s: list,          # per-step MP3 paths (None if TTS failed)
    step_durations: list,     # per-step audio durations in seconds
    write_times: list,        # per-step write animation durations
    title_mp3: str | None,
    tmp: str,
) -> str | None:
    """
    Assemble a single WAV audio track that matches the Manim video timeline:

      [title audio (padded to _TITLE_DUR)] [step0] [_FADE_DUR gap] [step1] … [end silence]

    The audio for step i begins exactly when the step's badge animation starts
    in the Manim scene.  Each step holds for audio_duration seconds, then
    fades out in _FADE_DUR seconds, after which the next step begins.

    Returns path to the combined WAV file, or None on failure.
    """
    wavs: list[str] = []

    def sil(name: str, dur: float) -> str:
        p = os.path.join(tmp, f"{name}.wav")
        _silence_wav(dur, p)
        return p

    def to_wav(mp3: str, name: str) -> str:
        p = os.path.join(tmp, f"{name}.wav")
        _mp3_to_wav(mp3, p)
        return p

    # ── Title segment ────────────────────────────────────────────────────────
    if title_mp3 and os.path.exists(title_mp3):
        title_dur = _audio_duration(title_mp3)
        wavs.append(to_wav(title_mp3, "title"))
        pad = _TITLE_DUR - title_dur
        if pad > 0.02:
            wavs.append(sil("sil_title_pad", pad))
    else:
        wavs.append(sil("sil_intro", _TITLE_DUR))

    # ── Step segments ────────────────────────────────────────────────────────
    for i, (mp3, dur) in enumerate(zip(step_mp3s, step_durations)):
        if mp3 and os.path.exists(mp3):
            wavs.append(to_wav(mp3, f"step_{i}"))
        else:
            # replace missing audio with silence of the same length
            wavs.append(sil(f"sil_step_{i}", dur))

        # Gap = fade-out time (step stays visible while fading; no overlap)
        if i < len(step_mp3s) - 1:
            wavs.append(sil(f"sil_fade_{i}", _FADE_DUR))

    # ── End-card silence ─────────────────────────────────────────────────────
    wavs.append(sil("sil_end", 4.0))

    # ── Concatenate with ffmpeg concat demuxer ───────────────────────────────
    list_file = os.path.join(tmp, "concat_list.txt")
    with open(list_file, "w") as f:
        for w in wavs:
            f.write(f"file '{w}'\n")

    out_wav = os.path.join(tmp, "audio_track.wav")
    r = subprocess.run(
        ["ffmpeg", "-y", "-f", "concat", "-safe", "0",
         "-i", list_file,
         "-c:a", "pcm_s16le", out_wav],
        capture_output=True, text=True,
    )
    if r.returncode != 0:
        return None
    return out_wav


def mux_audio_video(video: str, audio: str, out: str) -> bool:
    """Mux a silent video with an audio track into `out`. Returns success."""
    r = subprocess.run(
        ["ffmpeg", "-y",
         "-i", video, "-i", audio,
         "-c:v", "copy",
         "-c:a", "aac", "-b:a", "128k",
         "-map", "0:v:0", "-map", "1:a:0",
         "-shortest", out],
        capture_output=True, text=True,
    )
    return r.returncode == 0


# ---------------------------------------------------------------------------
# Manim scene template  (purely visual — no add_sound calls)
# ---------------------------------------------------------------------------
SCENE_TEMPLATE = """\
from manim import *
import textwrap

TOPIC      = {topic_repr}
STEPS      = {steps_repr}
AUDIO_DURS = {audio_durations_repr}

class ExplainerScene(Scene):
    def construct(self):
        self.camera.background_color = "#0f0f23"

        # ── Title (3.5 s total to match audio track gap) ───────────────────
        title = Text(TOPIC, font_size=44, weight=BOLD, color=WHITE)
        line  = Line(LEFT * 3.5, RIGHT * 3.5, color="#05bfdb", stroke_width=3)
        line.next_to(title, DOWN, buff=0.18)
        title_grp = VGroup(title, line)
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
            badge_num = Text(str(i + 1), font_size=22, color=c, weight=BOLD)
            badge     = VGroup(badge_bg, badge_num)

            wrapped = "\\n".join(textwrap.wrap(step, 50))
            txt     = Text(wrapped, font_size=28, line_spacing=1.4, color=WHITE)
            txt.next_to(badge, RIGHT, buff=0.5)
            group = VGroup(badge, txt).move_to(ORIGIN + UP * 0.1)

            bar_bg = Rectangle(width=6.5, height=0.08,
                               fill_color=GREY_D, fill_opacity=0.4, stroke_opacity=0)
            bar    = Rectangle(width=max(0.1, 6.5 * (i + 1) / n), height=0.08,
                               fill_color=c, fill_opacity=0.7, stroke_opacity=0)
            bar_bg.to_edge(DOWN, buff=0.6)
            bar.align_to(bar_bg, LEFT).move_to(bar_bg.get_center()).align_to(bar_bg, LEFT)
            prog = VGroup(bar_bg, bar)

            write_t   = max(0.8, min(1.8, len(step) * 0.03))
            audio_dur = AUDIO_DURS[i] if (AUDIO_DURS and i < len(AUDIO_DURS)) else 2.5

            # badge appear
            self.play(GrowFromCenter(badge_bg), FadeIn(badge_num, scale=0.5),
                      run_time=0.45)
            # text + progress bar write
            self.play(Write(txt), FadeIn(bar_bg), FadeIn(bar), run_time=write_t)
            # hold until the voice-over finishes
            # (audio started at the top of this step; anim already consumed 0.45+write_t)
            hold = max(0.3, audio_dur - 0.45 - write_t)
            self.wait(hold)

            self.play(FadeOut(group), FadeOut(prog),
                      run_time=0.45 if i < n - 1 else 0.6)

        # ── End card ───────────────────────────────────────────────────────
        check = Text("\\u2713", font_size=86, color="#00c853", weight=BOLD)
        done  = Text("Complete!", font_size=44, color=WHITE, weight=BOLD)
        echo  = Text(TOPIC, font_size=24, color=GREY_A)
        done.next_to(check, DOWN, buff=0.2)
        echo.next_to(done, DOWN, buff=0.22)
        VGroup(check, done, echo).move_to(ORIGIN)
        self.play(GrowFromCenter(check), run_time=0.6)
        self.play(FadeIn(done, shift=UP * 0.25), run_time=0.5)
        self.play(FadeIn(echo, shift=UP * 0.2), run_time=0.45)
        self.wait(2.5)
"""

# ---------------------------------------------------------------------------
# AI solver
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
        "messages": [{"role": "user",
                       "content": SOLVE_PROMPT.format(problem=problem)}],
        "temperature": 0.3,
        "max_tokens": 1024,
    }
    resp = requests.post(
        "https://api.groq.com/openai/v1/chat/completions",
        json=payload,
        headers={"Authorization": f"Bearer {key}",
                 "Content-Type": "application/json"},
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
# Main render pipeline
# ---------------------------------------------------------------------------

def render_video(topic: str, steps: list) -> str:
    tmp = tempfile.mkdtemp(prefix="manim_")
    try:
        # ── Step 1: Generate TTS ─────────────────────────────────────────────
        step_mp3s: list       = []
        step_durations: list  = []
        title_mp3: str | None = None

        if TTS_AVAILABLE:
            for i, step in enumerate(steps):
                mp3 = os.path.join(tmp, f"step_{i}.mp3")
                try:
                    _tts_to_mp3(step, mp3)
                    dur = _audio_duration(mp3)
                    step_mp3s.append(mp3)
                    step_durations.append(dur)
                except Exception:
                    step_mp3s.append(None)
                    step_durations.append(2.5)

            t_mp3 = os.path.join(tmp, "title.mp3")
            try:
                _tts_to_mp3(topic, t_mp3)
                title_mp3 = t_mp3
            except Exception:
                title_mp3 = None
        else:
            step_durations = [2.5] * len(steps)

        # ── Step 2: Render silent Manim video ────────────────────────────────
        write_times = [max(0.8, min(1.8, len(s) * 0.03)) for s in steps]

        scene_src = SCENE_TEMPLATE.format(
            topic_repr=repr(topic),
            steps_repr=repr(steps),
            audio_durations_repr=repr(step_durations),
        )
        scene_file = os.path.join(tmp, "scene.py")
        with open(scene_file, "w", encoding="utf-8") as f:
            f.write(scene_src)

        result = subprocess.run(
            ["manim", "render", scene_file, "ExplainerScene",
             "--media_dir", tmp, "-ql", "--disable_caching"],
            capture_output=True, text=True, timeout=300,
        )
        if result.returncode != 0:
            err = result.stderr[-2000:] if result.stderr else result.stdout[-1000:]
            raise RuntimeError(f"Manim render failed: {err}")

        mp4s = glob.glob(os.path.join(tmp, "**", "*.mp4"), recursive=True)
        if not mp4s:
            raise RuntimeError("Rendered video not found")
        silent_mp4 = mp4s[0]

        # ── Step 3: Build audio track ────────────────────────────────────────
        video_id = str(uuid.uuid4())
        dst      = os.path.join(VIDEOS_DIR, f"{video_id}.mp4")

        if TTS_AVAILABLE:
            audio_track = build_audio_track(
                step_mp3s, step_durations, write_times, title_mp3, tmp
            )
            if audio_track:
                final_mp4 = os.path.join(tmp, "final.mp4")
                ok = mux_audio_video(silent_mp4, audio_track, final_mp4)
                shutil.move(final_mp4 if ok else silent_mp4, dst)
            else:
                shutil.move(silent_mp4, dst)
        else:
            shutil.move(silent_mp4, dst)

        return video_id

    except subprocess.TimeoutExpired:
        raise RuntimeError("Render timed out (300 s limit)")
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


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
        return jsonify({"success": False,
                        "error": "AI returned malformed response. Try again."}), 502
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
        return jsonify({"success": False,
                        "error": "steps must be a non-empty list"}), 400

    steps = [str(s).strip() for s in steps if str(s).strip()]
    if not steps:
        return jsonify({"success": False,
                        "error": "steps must contain at least one non-empty step"}), 400
    if len(steps) > 10:
        return jsonify({"success": False,
                        "error": "maximum 10 steps allowed"}), 400

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


@app.route("/api/generate", methods=["POST"])
def generate():
    """
    All-in-one API endpoint.
    Request  (JSON): { "groq_api_key": "gsk_...", "problem": "2x + y = 7, x - y = 1" }
    Response        : MP4 video file (Content-Type: video/mp4)
    On error        : JSON { "success": false, "error": "..." } with 4xx/5xx status
    """
    data    = request.get_json(force=True, silent=True) or {}
    problem = (data.get("problem") or "").strip()
    api_key = (data.get("groq_api_key") or "").strip()

    if not problem:
        return jsonify({"success": False, "error": "problem is required"}), 400
    if not api_key:
        return jsonify({"success": False, "error": "groq_api_key is required"}), 400

    try:
        topic, steps = ai_solve(problem, api_key)
    except ValueError as e:
        return jsonify({"success": False, "error": str(e)}), 400
    except requests.HTTPError as e:
        return jsonify({"success": False, "error": f"AI API error: {e}"}), 502
    except (json.JSONDecodeError, KeyError):
        return jsonify({"success": False,
                        "error": "AI returned malformed response. Try again."}), 502
    except Exception as e:
        return jsonify({"success": False, "error": str(e)}), 500

    try:
        video_id = render_video(topic, steps)
    except RuntimeError as e:
        return jsonify({"success": False, "error": str(e)}), 500
    except Exception as e:
        return jsonify({"success": False, "error": str(e)}), 500

    video_path = os.path.join(VIDEOS_DIR, f"{video_id}.mp4")
    safe_name  = "".join(c if c.isalnum() or c in "-_ " else "_" for c in topic)[:60]
    filename   = f"{safe_name}.mp4"

    return send_file(
        video_path,
        mimetype="video/mp4",
        as_attachment=True,
        download_name=filename,
    )


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=PORT, debug=False)
