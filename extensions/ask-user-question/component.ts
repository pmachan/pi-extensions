import type { Theme } from "@earendil-works/pi-coding-agent";
import {
  type Component,
  Editor,
  type EditorTheme,
  Key,
  matchesKey,
  type TUI,
  truncateToWidth,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import type { AskUserQuestionResult, Question, QuestionOption } from "./schema";

interface QuestionState {
  cursorIndex: number;
  selectedIndex: number | null;
  selectedIndices: Set<number>;
  confirmed: boolean;
  freeTextValue: string | null;
  inEditMode: boolean;
}

type DisplayOption = QuestionOption & { isOther?: true };

export class AskUserQuestionComponent implements Component {
  private readonly states: QuestionState[];
  private readonly editor: Editor;

  private activeTab = 0;
  private cachedWidth?: number;
  private cachedLines?: string[];
  private resolved = false;

  constructor(
    private readonly questions: Question[],
    private readonly tui: TUI,
    private readonly theme: Theme,
    private readonly done: (result: AskUserQuestionResult | null) => void,
  ) {
    this.states = questions.map(() => ({
      cursorIndex: 0,
      selectedIndex: null,
      selectedIndices: new Set<number>(),
      confirmed: false,
      freeTextValue: null,
      inEditMode: false,
    }));

    const editorTheme: EditorTheme = {
      borderColor: (text) => theme.fg("muted", text),
      selectList: {
        selectedPrefix: (text) => theme.fg("accent", text),
        selectedText: (text) => theme.fg("accent", text),
        description: (text) => theme.fg("muted", text),
        scrollInfo: (text) => theme.fg("dim", text),
        noMatch: (text) => theme.fg("warning", text),
      },
    };

    this.editor = new Editor(tui, editorTheme);
    this.editor.disableSubmit = true;
    this.editor.onChange = () => {
      this.invalidate();
      this.tui.requestRender();
    };
  }

  invalidate(): void {
    this.cachedWidth = undefined;
    this.cachedLines = undefined;
  }

  render(width: number): string[] {
    if (this.cachedWidth === width && this.cachedLines) {
      return this.cachedLines;
    }

    if (this.questions.length === 0) {
      return [];
    }

    const lines: string[] = [];
    const add = (text: string) => lines.push(truncateToWidth(text, width));

    add(this.theme.fg("accent", "─".repeat(width)));

    if (!this.isSingleQuestion()) {
      this.renderTabBar(add);
      lines.push("");
    }

    const question = this.questions[this.activeTab];
    if (!question) {
      this.renderSubmitTab(add);
    } else {
      this.renderQuestionBody(question, this.states[this.activeTab], width, add);
    }

    add(this.theme.fg("accent", "─".repeat(width)));

    this.cachedWidth = width;
    this.cachedLines = lines;
    return lines;
  }

  handleInput(data: string): void {
    if (this.resolved) {
      return;
    }

    if (!this.isSingleQuestion() && this.activeTab === this.questions.length) {
      this.handleSubmitTabInput(data);
      return;
    }

    const question = this.questions[this.activeTab];
    const state = this.states[this.activeTab];

    if (state.inEditMode) {
      this.handleEditModeInput(data, question, state);
      return;
    }

    if (matchesKey(data, Key.escape)) {
      this.cancel();
      return;
    }

    if (!this.isSingleQuestion() && matchesKey(data, Key.right)) {
      this.autoConfirmIfAnswered(question, state);
      this.activeTab = (this.activeTab + 1) % this.totalTabs();
      this.refresh();
      return;
    }

    if (!this.isSingleQuestion() && matchesKey(data, Key.left)) {
      this.autoConfirmIfAnswered(question, state);
      this.activeTab = (this.activeTab - 1 + this.totalTabs()) % this.totalTabs();
      this.refresh();
      return;
    }

    if (matchesKey(data, Key.up)) {
      this.moveCursor(-1);
      return;
    }

    if (matchesKey(data, Key.down)) {
      this.moveCursor(1);
      return;
    }

    const options = this.allOptions(question);
    const onOther = state.cursorIndex === options.length - 1;

    if (onOther) {
      if (matchesKey(data, Key.space) || matchesKey(data, Key.tab)) {
        this.enterEditMode(state);
        return;
      }
      if (matchesKey(data, Key.enter) && state.freeTextValue !== null) {
        this.confirmAndAdvance(state);
        return;
      }
    }

    if (question.multiSelect) {
      if (matchesKey(data, Key.space) && !onOther) {
        this.toggleSelected(state, state.cursorIndex);
        return;
      }
      if (matchesKey(data, Key.enter) && !onOther) {
        if (state.selectedIndices.size > 0 || state.freeTextValue !== null) {
          this.confirmAndAdvance(state);
        }
        return;
      }
      return;
    }

    if (matchesKey(data, Key.enter) && !onOther) {
      state.selectedIndex = state.cursorIndex;
      state.freeTextValue = null;
      this.confirmAndAdvance(state);
    }
  }

  private handleSubmitTabInput(data: string): void {
    if (matchesKey(data, Key.enter)) {
      if (this.allConfirmed()) {
        this.submit();
      }
      return;
    }

    if (matchesKey(data, Key.escape)) {
      this.cancel();
      return;
    }

    if (matchesKey(data, Key.right)) {
      this.activeTab = 0;
      this.refresh();
      return;
    }

    if (matchesKey(data, Key.left)) {
      this.activeTab = this.questions.length - 1;
      this.refresh();
    }
  }

  private handleEditModeInput(data: string, question: Question, state: QuestionState): void {
    if (matchesKey(data, Key.escape)) {
      this.exitEditMode(state, false);
      this.tui.requestRender();
      return;
    }

    if (matchesKey(data, Key.enter)) {
      const value = this.editor.getText().trim();
      if (value) {
        this.exitEditMode(state, true);
        if (question.multiSelect) {
          this.tui.requestRender();
        } else {
          this.confirmAndAdvance(state);
        }
      } else {
        state.freeTextValue = null;
        if (question.multiSelect && state.selectedIndices.size === 0) {
          state.confirmed = false;
        }
        this.exitEditMode(state, false);
        this.tui.requestRender();
      }
      return;
    }

    this.editor.handleInput(data);
    this.refresh();
  }

  private renderTabBar(add: (text: string) => void): void {
    const parts: string[] = [" "];

    for (let index = 0; index < this.questions.length; index++) {
      const question = this.questions[index];
      const state = this.states[index];
      const header = truncateToWidth(question.header, 12);
      const label = ` ${header} `;

      if (index === this.activeTab) {
        parts.push(this.theme.bg("selectedBg", this.theme.fg("text", label)));
      } else if (state.confirmed) {
        parts.push(this.theme.fg("success", ` ■${header} `));
      } else {
        parts.push(this.theme.fg("muted", `  ${header} `));
      }
    }

    const submitLabel = " ✓ Submit ";
    if (this.activeTab === this.questions.length) {
      parts.push(this.theme.bg("selectedBg", this.theme.fg("text", submitLabel)));
    } else if (this.allConfirmed()) {
      parts.push(this.theme.fg("success", submitLabel));
    } else {
      parts.push(this.theme.fg("dim", submitLabel));
    }

    add(parts.join(""));
  }

  private renderQuestionBody(
    question: Question,
    state: QuestionState,
    width: number,
    add: (text: string) => void,
  ): void {
    const options = this.allOptions(question);

    for (const line of wrapTextWithAnsi(this.theme.fg("text", ` ${question.question}`), Math.max(1, width - 2))) {
      add(line);
    }
    add("");

    for (let index = 0; index < options.length; index++) {
      const option = options[index];
      const selected = index === state.cursorIndex;
      const prefix = selected ? this.theme.fg("accent", ">") : " ";
      const isOther = option.isOther === true;

      if (question.multiSelect && !isOther) {
        const checked = state.selectedIndices.has(index);
        const box = checked ? this.theme.fg("accent", "[✓]") : this.theme.fg("dim", "[ ]");
        const labelColor = selected ? "accent" : "text";
        add(`${prefix} ${box} ${this.theme.fg(labelColor, `${index + 1}. ${option.label}`)}`);
      } else if (isOther) {
        const hasFreeText = state.freeTextValue !== null && !state.inEditMode;
        const suffix = state.inEditMode ? this.theme.fg("accent", " ✎") : "";
        const labelColor = selected ? "accent" : "muted";

        if (question.multiSelect) {
          const box = hasFreeText ? this.theme.fg("success", "[✓]") : this.theme.fg("dim", "[ ]");
          add(`${prefix} ${box} ${this.theme.fg(labelColor, `${index + 1}. ${option.label}`)}${suffix}`);
        } else {
          const check = hasFreeText ? this.theme.fg("success", "✓") : " ";
          add(`${prefix} ${check} ${this.theme.fg(labelColor, `${index + 1}. ${option.label}`)}${suffix}`);
        }

        if (hasFreeText) {
          const indent = question.multiSelect ? "       " : "     ";
          const preview = truncateToWidth(state.freeTextValue ?? "", Math.max(1, width - indent.length));
          add(`${indent}${this.theme.fg("dim", `\"${preview}\"`)}`);
        }
      } else {
        const isConfirmedChoice = state.selectedIndex === index;
        const check = isConfirmedChoice ? this.theme.fg("success", "✓") : " ";
        const labelColor = selected ? "accent" : "text";
        add(`${prefix} ${check} ${this.theme.fg(labelColor, `${index + 1}. ${option.label}`)}`);
      }

      if (!isOther && option.description) {
        const indent = question.multiSelect ? "       " : "     ";
        for (const line of wrapTextWithAnsi(this.theme.fg("muted", option.description), Math.max(1, width - indent.length))) {
          add(`${indent}${line}`);
        }
      }
    }

    if (state.inEditMode) {
      add("");
      add(this.theme.fg("muted", " Your answer:"));
      for (const line of this.editor.render(Math.max(1, width - 4))) {
        add(` ${line}`);
      }
    }

    add("");

    if (state.inEditMode) {
      add(this.theme.fg("dim", " Enter submit · Esc back"));
      return;
    }

    const onOther = state.cursorIndex === options.length - 1;
    const tabHint = this.isSingleQuestion() ? "" : " · ←→ switch tabs";
    let actionHint = "Enter select";

    if (onOther) {
      actionHint = "Space/Tab open editor";
    } else if (question.multiSelect) {
      actionHint = "Space toggle · Enter confirm";
    }

    add(this.theme.fg("dim", ` ↑↓ navigate · ${actionHint}${tabHint} · Esc cancel`));
  }

  private renderSubmitTab(add: (text: string) => void): void {
    const ready = this.allConfirmed();

    add(ready ? this.theme.fg("success", this.theme.bold(" Ready to submit")) : this.theme.fg("warning", this.theme.bold(" Unanswered questions")));
    add("");

    for (let index = 0; index < this.questions.length; index++) {
      const question = this.questions[index];
      const answer = this.getAnswerText(question, this.states[index]);
      const header = truncateToWidth(question.header, 12);

      if (answer !== null) {
        add(this.theme.fg("muted", ` ${header}: `) + this.theme.fg("text", answer));
      } else {
        add(this.theme.fg("dim", ` ${header}: `) + this.theme.fg("warning", "—"));
      }
    }

    add("");

    if (ready) {
      add(this.theme.fg("success", " Press Enter to submit"));
    } else {
      const missing = this.questions
        .filter((_, index) => !this.states[index].confirmed)
        .map((question) => truncateToWidth(question.header, 12))
        .join(", ");
      add(this.theme.fg("warning", ` Still needed: ${missing}`));
    }

    add("");
    add(this.theme.fg("dim", " ←→ switch tabs · Esc cancel"));
  }

  private isSingleQuestion(): boolean {
    return this.questions.length === 1;
  }

  private totalTabs(): number {
    return this.questions.length + 1;
  }

  private allOptions(question: Question): DisplayOption[] {
    return [...question.options, { label: "Type your own answer...", isOther: true }];
  }

  private allConfirmed(): boolean {
    return this.states.every((state) => state.confirmed);
  }

  private refresh(): void {
    this.invalidate();
    this.tui.requestRender();
  }

  private moveCursor(delta: -1 | 1): void {
    const question = this.questions[this.activeTab];
    const state = this.states[this.activeTab];
    const maxIndex = this.allOptions(question).length - 1;
    state.cursorIndex = Math.max(0, Math.min(maxIndex, state.cursorIndex + delta));
    this.refresh();
  }

  private toggleSelected(state: QuestionState, index: number): void {
    if (state.selectedIndices.has(index)) {
      state.selectedIndices.delete(index);
    } else {
      state.selectedIndices.add(index);
    }

    if (state.selectedIndices.size === 0 && state.freeTextValue === null) {
      state.confirmed = false;
    }

    this.refresh();
  }

  private enterEditMode(state: QuestionState): void {
    state.inEditMode = true;
    this.editor.setText(state.freeTextValue ?? "");
    this.refresh();
  }

  private exitEditMode(state: QuestionState, save: boolean): void {
    if (save) {
      state.freeTextValue = this.editor.getText().trim();
      state.selectedIndex = null;
    } else if (!state.confirmed) {
      state.freeTextValue = null;
    }

    this.editor.setText("");
    state.inEditMode = false;
    this.invalidate();
  }

  private autoConfirmIfAnswered(question: Question, state: QuestionState): void {
    if (state.confirmed) {
      return;
    }

    if (question.multiSelect) {
      if (state.selectedIndices.size > 0 || state.freeTextValue !== null) {
        state.confirmed = true;
      }
      return;
    }

    if (state.selectedIndex !== null || state.freeTextValue !== null) {
      state.confirmed = true;
    }
  }

  private confirmAndAdvance(state: QuestionState): void {
    state.confirmed = true;
    this.advance();
  }

  private advance(): void {
    if (this.isSingleQuestion()) {
      this.submit();
      return;
    }

    if (this.activeTab < this.questions.length - 1) {
      this.activeTab += 1;
    } else {
      this.activeTab = this.questions.length;
    }

    this.refresh();
  }

  private getAnswerText(question: Question, state: QuestionState): string | null {
    if (!state.confirmed) {
      return null;
    }

    if (question.multiSelect) {
      const labels = [...state.selectedIndices]
        .sort((left, right) => left - right)
        .map((index) => question.options[index].label);

      if (state.freeTextValue !== null) {
        labels.push(state.freeTextValue);
      }

      return labels.join(", ");
    }

    if (state.freeTextValue !== null) {
      return state.freeTextValue;
    }

    if (state.selectedIndex !== null) {
      return question.options[state.selectedIndex].label;
    }

    return null;
  }

  private buildResult(): AskUserQuestionResult {
    const answers: Record<string, string> = {};

    for (let index = 0; index < this.questions.length; index++) {
      const question = this.questions[index];
      const answer = this.getAnswerText(question, this.states[index]);
      if (answer !== null) {
        answers[question.question] = answer;
      }
    }

    return {
      questions: this.questions,
      answers,
      cancelled: false,
    };
  }

  private submit(): void {
    this.resolved = true;
    this.done(this.buildResult());
  }

  private cancel(): void {
    this.resolved = true;
    this.done(null);
  }
}
