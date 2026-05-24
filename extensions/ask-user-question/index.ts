/**
 * The ask-user-question extension is derived from pi-askuserquestion by ghoseb, licensed under MIT.
 * Original source: https://github.com/ghoseb/pi-askuserquestion
 */
import type { ExtensionAPI, ToolExecutionMode } from "@earendil-works/pi-coding-agent";
import { Box, TruncatedText } from "@earendil-works/pi-tui";
import { AskUserQuestionComponent } from "./component";
import { InputSchema, type AskUserQuestionResult, type Question } from "./schema";
import { validateQuestions } from "./validate";

function cancelledResult(questions: Question[]): AskUserQuestionResult {
  return {
    questions,
    answers: {},
    cancelled: true,
  };
}

export default function askUserQuestion(pi: ExtensionAPI) {
  pi.registerTool({
    name: "ask_user_question",
    label: "Ask User",
    description: `Ask the user 1-4 clarifying questions before proceeding.
Use ask_user_question when you need the user's preference, approval, or a choice between valid approaches.
Each question must have 2-4 concise options. The UI already provides a free-text \"Type your own answer...\" option, so never add your own \"Other\" option.
Set multiSelect to true only when multiple options can be true at the same time.
header is a short tab label and must fit within 12 characters.
When you call ask_user_question, emit only ask_user_question in that assistant message and wait for the tool result before doing anything else.`,
    promptSnippet: "Ask the user structured clarifying questions with choices, multi-select, and free-text answers.",
    promptGuidelines: [
      "Use ask_user_question instead of asking clarifying questions in plain assistant text.",
      "When calling ask_user_question, emit only ask_user_question in that assistant response and wait for its result before making edits or calling other tools.",
      "Each ask_user_question call should include 1-4 questions with 2-4 concise options per question, and ask_user_question should not include an explicit 'Other' option because the UI already provides free-text input.",
    ],
    parameters: InputSchema,
    executionMode: "sequential" as ToolExecutionMode,

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const validationError = validateQuestions(params.questions);
      if (validationError) {
        return {
          content: [{ type: "text", text: `Error: ${validationError}` }],
          details: cancelledResult(params.questions),
        };
      }

      if (!ctx.hasUI) {
        pi.setActiveTools(pi.getActiveTools().filter((toolName) => toolName !== "ask_user_question"));
        return {
          content: [
            {
              type: "text",
              text: "Error: ask_user_question requires an interactive session. The tool has been disabled for this session.",
            },
          ],
          details: cancelledResult(params.questions),
        };
      }

      const result = await ctx.ui.custom<AskUserQuestionResult | null>((tui, theme, _keybindings, done) => {
        return new AskUserQuestionComponent(params.questions, tui, theme, done);
      });

      if (!result || result.cancelled) {
        return {
          content: [{ type: "text", text: "User cancelled" }],
          details: cancelledResult(params.questions),
        };
      }

      const summary = result.questions.map((question) => {
        const answer = result.answers[question.question] ?? "(no answer)";
        return `\"${question.question}\" = \"${answer}\"`;
      });

      return {
        content: [{ type: "text", text: summary.join("\n") }],
        details: result,
      };
    },

    renderCall(args, theme) {
      const questions = Array.isArray(args.questions) ? (args.questions as Question[]) : [];
      const headers = questions.map((question) => question.header).join(", ");
      return new TruncatedText(
        theme.fg("toolTitle", theme.bold("ask user ")) +
          theme.fg("muted", headers || `${questions.length || 0} question${questions.length === 1 ? "" : "s"}`),
        0,
        0,
      );
    },

    renderResult(result, _options, theme) {
      const details = result.details as AskUserQuestionResult | undefined;
      if (!details) {
        const text = result.content[0];
        return new TruncatedText(text?.type === "text" ? text.text : "", 0, 0);
      }

      if (details.cancelled) {
        return new TruncatedText(theme.fg("warning", "Cancelled"), 0, 0);
      }

      const box = new Box(0, 0);
      for (const question of details.questions) {
        const answer = details.answers[question.question] ?? "(no answer)";
        box.addChild(
          new TruncatedText(
            theme.fg("success", "✓ ") + theme.fg("accent", `${question.header}: `) + theme.fg("text", answer),
            0,
            0,
          ),
        );
      }
      return box;
    },
  });
}
