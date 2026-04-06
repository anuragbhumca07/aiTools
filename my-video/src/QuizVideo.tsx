import {
  AbsoluteFill,
  Audio,
  interpolate,
  spring,
  staticFile,
  useCurrentFrame,
  useVideoConfig,
  Sequence,
} from "remotion";
import { z } from "zod";
import { FANFARE_SND, TICK_LAST_SND, TICK_SND } from "./audio-utils";

export const quizSchema = z.object({
  question: z.string(),
  options: z.tuple([z.string(), z.string(), z.string(), z.string()]),
  correctIndex: z.number().min(0).max(3),
  /** Phase 1: seconds the question voice plays before options are read. */
  questionSeconds: z.number().default(4),
  /** Phase 2: seconds the options voice plays (before timer). */
  optionsSeconds: z.number().default(9),
  /** Phase 3: countdown timer duration in seconds. */
  timerSeconds: z.number().default(5),
  /** Phase 4: answer reveal duration in seconds. */
  answerSeconds: z.number().default(7),
  /** Path (relative to public/) for each voice clip. */
  questionVoice: z.string().default("voice/question.mp3"),
  optionsVoice: z.string().default("voice/options.mp3"),
  answerVoice: z.string().default("voice/answer.mp3"),
  /** Video aspect ratio: '16:9' for YouTube / landscape, '9:16' for Shorts / Reels */
  format: z.enum(["16:9", "9:16"]).default("16:9"),
});

export type QuizProps = z.infer<typeof quizSchema>;

const OPTION_COLORS = ["#e94560", "#533483", "#05bfdb", "#f5a623"];
const OPTION_LABELS = ["A", "B", "C", "D"];

/** Returns layout constants that adapt to portrait (9:16) vs landscape (16:9). */
function useLayout() {
  const { width, height } = useVideoConfig();
  const portrait = height > width;
  return {
    portrait,
    cardWidth: portrait ? Math.round(width * 0.9) : 1100,
    optionCols: portrait ? "1fr" : "1fr 1fr",
    questionFontSize: portrait ? 36 : 50,
    subtitleFontSize: portrait ? 22 : 26,
    optionFontSize: portrait ? 28 : 34,
    optionPad: portrait ? "22px 28px" : "26px 32px",
    badgeSize: portrait ? 48 : 56,
    badgeFontSize: portrait ? 22 : 28,
    gridTop: portrait ? 350 : 310,
    gridGap: portrait ? 16 : 22,
    cardTop: portrait ? 60 : 55,
    cardPad: portrait ? "28px 32px" : "36px 56px",
    timerBottom: portrait ? 70 : 36,
    celebTop: portrait ? 160 : 72,
    celebEmoji: portrait ? 72 : 88,
    celebFont: portrait ? 60 : 80,
    answerBottom: portrait ? 200 : 90,
    answerPad: portrait ? "28px 48px" : "36px 80px",
    answerFont: portrait ? 38 : 52,
  };
}

/* ─────────────────────────────────────────────────────────────
   Phase 1 – Question
   Reads the question aloud. Options visible but not highlighted.
───────────────────────────────────────────────────────────────*/
function QuestionPhase({ question, options }: Pick<QuizProps, "question" | "options">) {
  const { fps } = useVideoConfig();
  const frame = useCurrentFrame();
  const lay = useLayout();
  const cardScale = spring({ frame, fps, config: { damping: 14 } });

  return (
    <AbsoluteFill style={{ backgroundColor: "#1a1a2e", fontFamily: "'Segoe UI', sans-serif" }}>
      <Stars />
      <SpeakerPulse frame={frame} />
      <div style={{
        position: "absolute", top: lay.cardTop, left: "50%",
        transform: `translateX(-50%) scale(${cardScale})`,
        backgroundColor: "#16213e", borderRadius: 24,
        padding: lay.cardPad, width: lay.cardWidth, textAlign: "center",
        boxShadow: "0 8px 32px rgba(0,0,0,0.4)", border: "2px solid #0f3460",
      }}>
        <div style={{ fontSize: lay.subtitleFontSize, color: "#aaa", marginBottom: 10, letterSpacing: 3 }}>
          QUIZ TIME! 🎯
        </div>
        <div style={{ fontSize: lay.questionFontSize, fontWeight: 800, color: "#fff", lineHeight: 1.3 }}>
          {question}
        </div>
      </div>
      <OptionGrid options={options} activeIndex={-1} frame={frame} fps={fps} animate />
    </AbsoluteFill>
  );
}

/* ─────────────────────────────────────────────────────────────
   Phase 2 – Options reading
   Each option pulses in turn while the voice reads it.
   optionsSeconds ≈ 9 s (8.62 s audio + buffer).
   We spotlight options A→D roughly every 9/4 ≈ 2.25 s.
───────────────────────────────────────────────────────────────*/
function OptionsPhase({
  question,
  options,
  optionsSeconds,
}: Pick<QuizProps, "question" | "options" | "optionsSeconds">) {
  const { fps } = useVideoConfig();
  const frame = useCurrentFrame();
  const lay = useLayout();
  const totalFrames = optionsSeconds * fps;
  const segmentFrames = totalFrames / options.length;
  const activeIndex = Math.min(Math.floor(frame / segmentFrames), options.length - 1);

  return (
    <AbsoluteFill style={{ backgroundColor: "#1a1a2e", fontFamily: "'Segoe UI', sans-serif" }}>
      <Stars />
      <SpeakerPulse frame={frame} />
      <div style={{
        position: "absolute", top: lay.cardTop, left: "50%",
        transform: "translateX(-50%)",
        backgroundColor: "#16213e", borderRadius: 24,
        padding: lay.cardPad, width: lay.cardWidth, textAlign: "center",
        border: "2px solid #0f3460",
      }}>
        <div style={{ fontSize: lay.subtitleFontSize, color: "#aaa", marginBottom: 8, letterSpacing: 3 }}>
          QUIZ TIME! 🎯
        </div>
        <div style={{ fontSize: lay.questionFontSize - 4, fontWeight: 800, color: "#fff", lineHeight: 1.3 }}>
          {question}
        </div>
      </div>
      <OptionGrid options={options} activeIndex={activeIndex} frame={frame} fps={fps} animate={false} />
      <div style={{
        position: "absolute", bottom: lay.timerBottom - 10, left: "50%",
        transform: "translateX(-50%)",
        color: "#aaa", fontSize: lay.subtitleFontSize - 4, letterSpacing: 3,
      }}>
        LISTEN CAREFULLY...
      </div>
    </AbsoluteFill>
  );
}

/* ─────────────────────────────────────────────────────────────
   Phase 3 – Timer countdown
───────────────────────────────────────────────────────────────*/
function TimerPhase({
  question,
  options,
  timerSeconds,
}: Pick<QuizProps, "question" | "options" | "timerSeconds">) {
  const { fps } = useVideoConfig();
  const frame = useCurrentFrame();
  const lay = useLayout();
  const totalFrames = timerSeconds * fps;
  const progress = Math.max(0, 1 - frame / totalFrames);
  const secondsLeft = Math.ceil(Math.max(0, (totalFrames - frame) / fps));
  const radius = 44;
  const circ = 2 * Math.PI * radius;
  const fracInSec = ((totalFrames - frame) % fps) / fps;
  const ringScale = interpolate(fracInSec, [0.8, 1], [1.15, 1], {
    extrapolateLeft: "clamp", extrapolateRight: "clamp",
  });

  return (
    <AbsoluteFill style={{ backgroundColor: "#1a1a2e", fontFamily: "'Segoe UI', sans-serif" }}>
      <Stars />
      <div style={{
        position: "absolute", top: lay.cardTop, left: "50%",
        transform: "translateX(-50%)",
        backgroundColor: "#16213e", borderRadius: 24,
        padding: lay.cardPad, width: lay.cardWidth, textAlign: "center",
        border: "2px solid #0f3460",
      }}>
        <div style={{ fontSize: lay.subtitleFontSize, color: "#aaa", marginBottom: 8, letterSpacing: 3 }}>
          QUIZ TIME! 🎯
        </div>
        <div style={{ fontSize: lay.questionFontSize - 4, fontWeight: 800, color: "#fff", lineHeight: 1.3 }}>
          {question}
        </div>
      </div>
      <OptionGrid options={options} activeIndex={-1} frame={frame} fps={fps} animate={false} />
      <div style={{
        position: "absolute", bottom: lay.timerBottom, left: "50%",
        transform: `translateX(-50%) scale(${ringScale})`,
        display: "flex", flexDirection: "column", alignItems: "center",
      }}>
        <svg width={130} height={130} viewBox="0 0 100 100">
          <circle cx={50} cy={50} r={radius} fill="#0f3460" />
          <circle cx={50} cy={50} r={radius} fill="none" stroke="#555" strokeWidth={8} />
          <circle
            cx={50} cy={50} r={radius} fill="none"
            stroke={progress > 0.35 ? "#05bfdb" : "#e94560"}
            strokeWidth={8} strokeDasharray={circ}
            strokeDashoffset={circ * (1 - progress)}
            strokeLinecap="round" transform="rotate(-90 50 50)"
          />
          <text x={50} y={50} textAnchor="middle" dominantBaseline="central"
            fill="#fff" fontSize={30} fontWeight={900}>{secondsLeft}</text>
        </svg>
        <div style={{ color: "#aaa", fontSize: lay.subtitleFontSize - 4, marginTop: 4, letterSpacing: 3 }}>
          THINK FAST! ⏰
        </div>
      </div>
    </AbsoluteFill>
  );
}

/* ─────────────────────────────────────────────────────────────
   Phase 4 – Answer reveal
───────────────────────────────────────────────────────────────*/
function AnswerPhase({ options, correctIndex }: Pick<QuizProps, "options" | "correctIndex">) {
  const { fps } = useVideoConfig();
  const frame = useCurrentFrame();
  const lay = useLayout();

  const celebScale = spring({ frame, fps, config: { damping: 10, stiffness: 200 } });
  const cardScale = spring({ frame: Math.max(0, frame - 8), fps, config: { damping: 12 } });
  const bounceY = interpolate(frame % 30, [0, 15, 30], [0, -16, 0], {
    extrapolateLeft: "clamp", extrapolateRight: "clamp",
  });
  const starOpacity = interpolate(frame, [0, 10], [0, 1], { extrapolateRight: "clamp" });

  return (
    <AbsoluteFill style={{
      backgroundColor: "#0d1b2a",
      fontFamily: "'Segoe UI', sans-serif",
      overflow: "hidden",
    }}>
      {/* Falling confetti */}
      {Array.from({ length: 24 }).map((_, i) => {
        const x = (i * 137.5) % 100;
        const y = interpolate(frame - i * 2, [0, 72], [-5, 115], {
          extrapolateLeft: "clamp", extrapolateRight: "clamp",
        });
        const emojis = ["⭐", "🌟", "✨", "🎉", "🎊", "💫", "🏆", "🎈"];
        return (
          <div key={i} style={{
            position: "absolute", left: `${x}%`, top: `${y}%`,
            fontSize: 14 + (i % 4) * 8,
            opacity: starOpacity,
            transform: `rotate(${frame * (i % 2 === 0 ? 4 : -4)}deg)`,
            pointerEvents: "none",
          }}>
            {emojis[i % emojis.length]}
          </div>
        );
      })}

      {/* "You Are Correct!" */}
      <div style={{
        position: "absolute", top: lay.celebTop, left: "50%",
        transform: `translateX(-50%) scale(${celebScale}) translateY(${bounceY}px)`,
        textAlign: "center",
      }}>
        <div style={{ fontSize: lay.celebEmoji, marginBottom: 8 }}>🎉</div>
        <div style={{
          fontSize: lay.celebFont, fontWeight: 900, color: "#00c853",
          textShadow: "0 0 40px rgba(0,200,83,0.55)", letterSpacing: 2,
        }}>
          You Are Correct!
        </div>
      </div>

      {/* Correct answer card */}
      <div style={{
        position: "absolute", bottom: lay.answerBottom, left: "50%",
        transform: `translateX(-50%) scale(${cardScale})`,
        backgroundColor: "#00c853", borderRadius: 28,
        padding: lay.answerPad, display: "flex",
        alignItems: "center", gap: 30,
        boxShadow: "0 8px 40px rgba(0,200,83,0.5)",
        maxWidth: lay.cardWidth,
      }}>
        <Badge label={OPTION_LABELS[correctIndex]} size={64} fontSize={32} />
        <span style={{ fontSize: lay.answerFont, fontWeight: 800, color: "#fff" }}>
          {options[correctIndex]}
        </span>
        <span style={{ fontSize: lay.answerFont - 4 }}>✅</span>
      </div>
    </AbsoluteFill>
  );
}

/* ─────────────────────────────────────────────────────────────
   Root composition
───────────────────────────────────────────────────────────────*/
export const QuizVideo: React.FC<QuizProps> = (props) => {
  const { fps } = useVideoConfig();
  const {
    question, options, correctIndex,
    questionSeconds, optionsSeconds, timerSeconds, answerSeconds,
    questionVoice, optionsVoice, answerVoice,
  } = props;

  const qF = questionSeconds * fps;   // Phase 1
  const oF = optionsSeconds * fps;    // Phase 2
  const tF = timerSeconds * fps;      // Phase 3
  const aF = answerSeconds * fps;     // Phase 4

  return (
    <AbsoluteFill>
      {/* ── Audio ──────────────────────────────────────── */}

      {/* Phase 1: question voice */}
      {questionVoice && (
        <Sequence from={0} durationInFrames={qF}>
          <Audio src={staticFile(questionVoice)} volume={1} />
        </Sequence>
      )}

      {/* Phase 2: options voice */}
      {optionsVoice && (
        <Sequence from={qF} durationInFrames={oF}>
          <Audio src={staticFile(optionsVoice)} volume={1} />
        </Sequence>
      )}

      {/* Phase 3: tick beeps */}
      {Array.from({ length: timerSeconds }).map((_, i) => (
        <Sequence key={i} from={qF + oF + i * fps} durationInFrames={Math.floor(fps * 0.3)}>
          <Audio src={i === timerSeconds - 1 ? TICK_LAST_SND : TICK_SND} volume={0.6} />
        </Sequence>
      ))}

      {/* Phase 4: fanfare + answer voice */}
      <Sequence from={qF + oF + tF} durationInFrames={aF}>
        <Audio src={FANFARE_SND} volume={1} />
      </Sequence>
      {answerVoice && (
        <Sequence from={qF + oF + tF + fps} durationInFrames={aF - fps}>
          <Audio src={staticFile(answerVoice)} volume={1} />
        </Sequence>
      )}

      {/* ── Visuals ────────────────────────────────────── */}
      <Sequence from={0} durationInFrames={qF}>
        <QuestionPhase question={question} options={options} />
      </Sequence>
      <Sequence from={qF} durationInFrames={oF}>
        <OptionsPhase question={question} options={options} optionsSeconds={optionsSeconds} />
      </Sequence>
      <Sequence from={qF + oF} durationInFrames={tF}>
        <TimerPhase question={question} options={options} timerSeconds={timerSeconds} />
      </Sequence>
      <Sequence from={qF + oF + tF} durationInFrames={aF}>
        <AnswerPhase options={options} correctIndex={correctIndex} />
      </Sequence>
    </AbsoluteFill>
  );
};

/* ─────────────────────────────────────────────────────────────
   Shared sub-components
───────────────────────────────────────────────────────────────*/
function OptionGrid({
  options,
  activeIndex,
  frame,
  fps,
  animate,
}: {
  options: readonly string[];
  activeIndex: number;
  frame: number;
  fps: number;
  animate: boolean;
}) {
  const lay = useLayout();
  return (
    <div style={{
      position: "absolute", top: lay.gridTop, left: "50%",
      transform: "translateX(-50%)",
      display: "grid", gridTemplateColumns: lay.optionCols,
      gap: lay.gridGap, width: lay.cardWidth,
    }}>
      {options.map((option, i) => {
        const isActive = activeIndex === i;
        const s = animate
          ? spring({ frame: Math.max(0, frame - i * 6), fps, config: { damping: 14 } })
          : 1;
        const glow = isActive
          ? "0 0 30px rgba(255,255,255,0.6), 0 4px 20px rgba(0,0,0,0.35)"
          : "0 4px 20px rgba(0,0,0,0.35)";
        return (
          <div key={i} style={{
            backgroundColor: OPTION_COLORS[i],
            borderRadius: 20, padding: lay.optionPad,
            display: "flex", alignItems: "center", gap: 18,
            transform: `scale(${s * (isActive ? 1.04 : 1)})`,
            boxShadow: glow,
            border: isActive ? "3px solid #fff" : "3px solid transparent",
            transition: "transform 0.2s, box-shadow 0.2s",
            opacity: activeIndex >= 0 && !isActive ? 0.6 : 1,
          }}>
            <Badge label={OPTION_LABELS[i]} size={lay.badgeSize} fontSize={lay.badgeFontSize} />
            <span style={{ fontSize: lay.optionFontSize, fontWeight: 700, color: "#fff" }}>{option}</span>
          </div>
        );
      })}
    </div>
  );
}

function Badge({ label, size = 56, fontSize = 28 }: { label: string; size?: number; fontSize?: number }) {
  return (
    <div style={{
      width: size, height: size, borderRadius: "50%",
      backgroundColor: "rgba(255,255,255,0.25)",
      display: "flex", alignItems: "center", justifyContent: "center",
      fontSize, fontWeight: 900, color: "#fff", flexShrink: 0,
    }}>
      {label}
    </div>
  );
}

function Stars() {
  return (
    <AbsoluteFill style={{ overflow: "hidden", opacity: 0.22, pointerEvents: "none" }}>
      {Array.from({ length: 30 }).map((_, i) => (
        <div key={i} style={{
          position: "absolute",
          left: `${(i * 137.5) % 100}%`, top: `${(i * 97.3) % 100}%`,
          width: i % 3 === 0 ? 6 : 3, height: i % 3 === 0 ? 6 : 3,
          borderRadius: "50%", backgroundColor: "#fff",
        }} />
      ))}
    </AbsoluteFill>
  );
}

function SpeakerPulse({ frame }: { frame: number }) {
  const pulse = 0.85 + 0.15 * Math.sin((frame / 8) * Math.PI);
  return (
    <div style={{
      position: "absolute", bottom: 38, right: 72,
      fontSize: 46, transform: `scale(${pulse})`, opacity: 0.85,
    }}>
      🔊
    </div>
  );
}
