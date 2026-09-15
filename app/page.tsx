import VocabApp from "@/components/vocab-app";
import StudyBoundary from "@/components/studio/error-boundary";

export default function Home() {
  return (
    <StudyBoundary>
      <VocabApp />
    </StudyBoundary>
  );
}
