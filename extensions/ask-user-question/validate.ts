import type { Question } from "./schema";

export function validateQuestions(questions: Question[]): string | null {
  const seenQuestions = new Set<string>();

  for (const question of questions) {
    if (seenQuestions.has(question.question)) {
      return `Duplicate question: \"${question.question}\"`;
    }
    seenQuestions.add(question.question);

    const seenLabels = new Set<string>();
    for (const option of question.options) {
      if (seenLabels.has(option.label)) {
        return `Duplicate option label \"${option.label}\" in question \"${question.question}\"`;
      }
      seenLabels.add(option.label);
    }
  }

  return null;
}
