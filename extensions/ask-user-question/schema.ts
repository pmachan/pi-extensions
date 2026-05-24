import { Type } from "typebox";

export interface QuestionOption {
  label: string;
  description?: string;
}

export interface Question {
  question: string;
  header: string;
  options: QuestionOption[];
  multiSelect: boolean;
}

export interface AskUserQuestionInput {
  questions: Question[];
}

export interface AskUserQuestionResult {
  questions: Question[];
  answers: Record<string, string>;
  cancelled: boolean;
}

export const OptionSchema = Type.Object({
  label: Type.String({
    description: "Display label shown to the user and returned to the model",
  }),
  description: Type.Optional(
    Type.String({
      description: "Optional hint shown below the option label",
    }),
  ),
});

export const QuestionSchema = Type.Object({
  question: Type.String({
    description: "Full question text shown to the user",
  }),
  header: Type.String({
    minLength: 1,
    maxLength: 12,
    description: "Short tab label for this question, max 12 characters",
  }),
  options: Type.Array(OptionSchema, {
    minItems: 2,
    maxItems: 4,
    description: "Two to four concise answer choices",
  }),
  multiSelect: Type.Boolean({
    description: "Set true when multiple options can apply at the same time",
  }),
});

export const InputSchema = Type.Object({
  questions: Type.Array(QuestionSchema, {
    minItems: 1,
    maxItems: 4,
    description: "One to four questions to ask the user",
  }),
});

export const ResultSchema = Type.Object({
  questions: Type.Array(QuestionSchema),
  answers: Type.Record(Type.String(), Type.String()),
  cancelled: Type.Boolean(),
});
