import {
  AbsoluteFill,
  Sequence,
  useVideoConfig,
} from "remotion";
import { z } from "zod";
import { QuizVideo, quizSchema } from "./QuizVideo";

// Per-question schema: same as quizSchema minus top-level format, plus startFrame offset
const bulkQuestionSchema = quizSchema.omit({ format: true }).extend({
  startFrame: z.number().int().min(0),
});

export const bulkQuizSchema = z.object({
  questions: z.array(bulkQuestionSchema).min(1).max(50),
  format: z.enum(["16:9", "9:16"]).default("16:9"),
});

export type BulkQuizProps = z.infer<typeof bulkQuizSchema>;

/**
 * Renders up to 50 quiz questions in a single video composition.
 * Each question is wrapped in a Remotion <Sequence> at its precomputed startFrame,
 * so the inner QuizVideo's useCurrentFrame() always starts at 0 for that question.
 */
export const BulkQuizVideo: React.FC<BulkQuizProps> = ({ questions, format }) => {
  const { fps } = useVideoConfig();

  return (
    <AbsoluteFill>
      {questions.map((q, i) => {
        const totalFrames =
          (q.questionSeconds + q.optionsSeconds + q.timerSeconds + q.answerSeconds) * fps;
        return (
          <Sequence key={i} from={q.startFrame} durationInFrames={totalFrames}>
            <QuizVideo {...q} format={format} />
          </Sequence>
        );
      })}
    </AbsoluteFill>
  );
};
