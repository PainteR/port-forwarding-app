import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import {
  bracketMatching,
  HighlightStyle,
  indentOnInput,
  indentUnit,
  syntaxHighlighting,
} from "@codemirror/language";
import {
  Annotation,
  Compartment,
  EditorState,
  Transaction,
} from "@codemirror/state";
import {
  drawSelection,
  EditorView,
  highlightActiveLineGutter,
  highlightSpecialChars,
  keymap,
  lineNumbers,
} from "@codemirror/view";
import { tags } from "@lezer/highlight";
import { useEffect, useRef } from "react";

import { nginxLanguage } from "@/lib/nginx-language";
import "./nginx-code-editor.css";

const externalChange = Annotation.define<boolean>();
const highlighting = HighlightStyle.define([
  { tag: tags.keyword, class: "nginx-token-directive" },
  { tag: tags.controlKeyword, class: "nginx-token-block" },
  { tag: tags.tagName, class: "nginx-token-name" },
  { tag: tags.variableName, class: "nginx-token-variable" },
  { tag: tags.string, class: "nginx-token-string" },
  { tag: [tags.number, tags.bool, tags.atom], class: "nginx-token-number" },
  { tag: tags.comment, class: "nginx-token-comment" },
]);

export default function NginxCodeEditor({
  id,
  value,
  onChange,
  disabled = false,
}: {
  id: string;
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
}) {
  const parent = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const onChangeRef = useRef(onChange);
  const editability = useRef(new Compartment()).current;
  onChangeRef.current = onChange;

  useEffect(() => {
    if (!parent.current) return;
    const editor = new EditorView({
      parent: parent.current,
      state: EditorState.create({
        doc: value,
        extensions: [
          lineNumbers(),
          highlightActiveLineGutter(),
          highlightSpecialChars(),
          drawSelection(),
          history(),
          keymap.of([...defaultKeymap, ...historyKeymap]),
          indentUnit.of("    "),
          indentOnInput(),
          bracketMatching(),
          nginxLanguage,
          syntaxHighlighting(highlighting),
          EditorView.contentAttributes.of({
            id,
            role: "textbox",
            "aria-label": "Nginx configuration",
            "aria-multiline": "true",
            tabindex: "0",
            spellcheck: "false",
            autocorrect: "off",
            autocapitalize: "off",
          }),
          editability.of([
            EditorState.readOnly.of(disabled),
            EditorView.editable.of(!disabled),
            EditorView.contentAttributes.of({
              "aria-readonly": String(disabled),
            }),
          ]),
          EditorView.updateListener.of((update) => {
            if (
              update.docChanged &&
              !update.transactions.some((transaction) =>
                transaction.annotation(externalChange),
              )
            ) {
              onChangeRef.current(update.state.doc.toString());
            }
          }),
        ],
      }),
    });
    view.current = editor;
    return () => {
      view.current = null;
      editor.destroy();
    };
    // Prop updates are synchronized below without remounting the editor.
  }, [id, editability]);

  useEffect(() => {
    const editor = view.current;
    if (!editor || editor.state.doc.toString() === value) return;
    editor.dispatch({
      changes: { from: 0, to: editor.state.doc.length, insert: value },
      annotations: [
        externalChange.of(true),
        Transaction.addToHistory.of(false),
      ],
    });
  }, [value]);

  useEffect(() => {
    view.current?.dispatch({
      effects: editability.reconfigure([
        EditorState.readOnly.of(disabled),
        EditorView.editable.of(!disabled),
        EditorView.contentAttributes.of({ "aria-readonly": String(disabled) }),
      ]),
    });
  }, [disabled, editability]);

  return (
    <div className="nginx-code-editor" data-disabled={disabled} ref={parent} />
  );
}
