import { Composition } from "remotion";
import { HelloWorld, myCompSchema } from "./HelloWorld";
import { Logo, myCompSchema2 } from "./HelloWorld/Logo";
import { QuizVideo, quizSchema, type QuizProps } from "./QuizVideo";

// Each <Composition> is an entry in the sidebar!

export const RemotionRoot: React.FC = () => {
  const FPS = 30;
  const QUESTION_SECONDS = 4;  // Phase 1: question voice (audio: 3.55s)
  const OPTIONS_SECONDS = 9;   // Phase 2: options voice (audio: 8.62s)
  const TIMER_SECONDS = 5;     // Phase 3: countdown
  const ANSWER_SECONDS = 7;    // Phase 4: reveal (audio: 6.14s)
  // Large buffer so --frames=0-N never fails validation regardless of voice length
  const totalFrames = 120 * FPS; // 120 seconds max

  return (
    <>
      <Composition
        // You can take the "id" to render a video:
        // npx remotion render HelloWorld
        id="HelloWorld"
        component={HelloWorld}
        durationInFrames={150}
        fps={30}
        width={1920}
        height={1080}
        // You can override these props for each render:
        // https://www.remotion.dev/docs/parametrized-rendering
        schema={myCompSchema}
        defaultProps={{
          titleText: "Welcome to Remotion",
          titleColor: "#000000",
          logoColor1: "#91EAE4",
          logoColor2: "#86A8E7",
        }}
      />

      {/* Mount any React component to make it show up in the sidebar and work on it individually! */}
      <Composition
        id="QuizVideo"
        component={QuizVideo}
        durationInFrames={totalFrames}
        fps={FPS}
        width={1280}
        height={720}
        schema={quizSchema}
        defaultProps={{
          question: "What is the largest planet in our solar system?",
          options: ["Earth", "Saturn", "Jupiter", "Mars"] as [string, string, string, string],
          correctIndex: 2,
          questionSeconds: QUESTION_SECONDS,
          optionsSeconds: OPTIONS_SECONDS,
          timerSeconds: TIMER_SECONDS,
          answerSeconds: ANSWER_SECONDS,
          questionVoice: "voice/question.mp3",
          optionsVoice: "voice/options.mp3",
          answerVoice: "voice/answer.mp3",
          format: "16:9" as const,
        }}
        calculateMetadata={async ({ props }: { props: QuizProps }) => {
          const portrait = (props.format ?? "16:9") === "9:16";
          return {
            width: portrait ? 720 : 1280,
            height: portrait ? 1280 : 720,
          };
        }}
      />

      <Composition
        id="OnlyLogo"
        component={Logo}
        durationInFrames={150}
        fps={30}
        width={1920}
        height={1080}
        schema={myCompSchema2}
        defaultProps={{
          logoColor1: "#91dAE2" as const,
          logoColor2: "#86A8E7" as const,
        }}
      />
    </>
  );
};
