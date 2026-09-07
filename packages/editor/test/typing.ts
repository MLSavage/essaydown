import { format } from "@essaydown/core";
import { baseKeymap } from "prosemirror-commands";
import type { EditorView } from "prosemirror-view";
import {
  EditorState,
  TextSelection,
  type Command,
  type Plugin,
  type Transaction,
} from "prosemirror-state";
import { editorPlugins, essaydownKeymap } from "../src/input.js";
import { pmToMdast, schema } from "../src/schema.js";

/**
 * A headless keyboard for the plugins of {@link editorPlugins}.
 *
 * `prosemirror-view` is the only thing in the stack that needs a DOM, and it contributes exactly
 * two things to typing: it calls the input-rules plugin's `handleTextInput` prop before inserting
 * a character, and it runs the keymap plugins' commands in plugin order for a key. Both are
 * reproduced here against a stand-in view — the plugin's `run` reads `composing`, `state` and
 * `dispatch` and nothing else — so the same keystroke scripts the Playwright acceptance types into
 * a real browser can be replayed in Vitest with no jsdom and no new dependency.
 *
 * Key names are Playwright's (`Shift+Tab`), so one scenario table drives both suites;
 * {@link KEY_NAMES} is the only place the two spellings meet.
 */
const KEY_NAMES: Record<string, string> = { "Shift+Tab": "Shift-Tab" };

export class Typing {
  private current: EditorState;
  private readonly rules: Plugin;
  private readonly maps: Record<string, Command>[];

  constructor() {
    const plugins = editorPlugins();
    this.current = EditorState.create({ schema, plugins });
    this.rules = plugins.filter((plugin) => plugin.spec.isInputRules === true)[0];
    this.maps = [essaydownKeymap(), baseKeymap];
  }

  /** The state as the last keystroke left it. */
  get state(): EditorState {
    return this.current;
  }

  private dispatch = (tr: Transaction): void => {
    this.current = this.current.apply(tr);
  };

  private get view(): EditorView {
    return {
      composing: false,
      state: this.current,
      dispatch: this.dispatch,
    } as unknown as EditorView;
  }

  /**
   * Type `text`, one character at a time, offering each character to the input rules first and
   * falling back to the insertion the view would have made — which is also the fifth argument the
   * view hands the prop, so the fallback exists in exactly one place here as it does there.
   */
  type(text: string): this {
    for (const character of text) {
      const { from, to } = this.current.selection;
      const insert = (): Transaction => this.current.tr.insertText(character, from, to);
      // `.call`: the prop's declared `this` is the plugin. ProseMirror binds it at construction,
      // so this only satisfies the type.
      const handled = this.rules.props.handleTextInput?.call(
        this.rules,
        this.view,
        from,
        to,
        character,
        insert,
      );
      if (handled !== true) this.dispatch(insert());
    }
    return this;
  }

  /** Press a key, trying the keymaps in the order {@link editorPlugins} installs them. */
  press(key: string): this {
    const name = KEY_NAMES[key] ?? key;
    for (const map of this.maps) {
      const command = map[name];
      if (command !== undefined && command(this.current, this.dispatch, undefined)) return this;
    }
    return this;
  }

  /**
   * Put the cursor at a document position, the keyboard-free half of clicking. The scenarios never
   * need it — they type from the start of a blank document — but a rule that reads what follows
   * the cursor cannot be reached any other way.
   */
  moveTo(pos: number): this {
    this.dispatch(this.current.tr.setSelection(TextSelection.create(this.current.doc, pos)));
    return this;
  }

  /** Replay a scenario's keystroke script. */
  run(keys: readonly Keystroke[]): this {
    for (const key of keys) {
      if ("type" in key) this.type(key.type);
      else this.press(key.press);
    }
    return this;
  }

  /** The canonical Markdown of the document, exactly as the dev route shows it. */
  markdown(): string {
    return format(pmToMdast({ doc: this.current.doc, frontMatter: null }));
  }
}

export type Keystroke = { type: string } | { press: string };

export interface Scenario {
  name: string;
  keys: Keystroke[];
  markdown: string;
}
