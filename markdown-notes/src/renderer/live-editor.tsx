import React, { forwardRef, useEffect, useImperativeHandle, useRef } from 'react';
import {
  Annotation,
  Prec,
  Compartment,
  EditorSelection,
  EditorState,
  StateField,
  Transaction,
  type Range,
} from '@codemirror/state';
import {
  Decoration,
  EditorView,
  WidgetType,
  keymap,
  placeholder,
  type DecorationSet,
} from '@codemirror/view';
import {
  defaultKeymap,
  history,
  historyKeymap,
  indentWithTab,
  insertNewlineAndIndent,
} from '@codemirror/commands';
import { markdown, markdownLanguage, insertNewlineContinueMarkup } from '@codemirror/lang-markdown';
import { ensureSyntaxTree, syntaxTree } from '@codemirror/language';
import { mathAt } from '../shared/math';
import { refs } from '../shared/rules';
import { safeMarkdown } from './markdown';
import './live-editor.css';

class Label extends WidgetType {
  constructor(readonly text: string) {
    super();
  }
  eq(other: Label) {
    return other.text === this.text;
  }
  toDOM() {
    const e = document.createElement('span');
    e.className = 'live-marker';
    e.textContent = this.text;
    return e;
  }
}
class RenderedBlock extends WidgetType {
  constructor(
    readonly source: string,
    readonly from: number,
    readonly label: string,
  ) {
    super();
  }
  eq(other: RenderedBlock) {
    return this.source === other.source && this.from === other.from;
  }
  toDOM(view: EditorView) {
    const inline = this.label === '公式' && !/^(\$\$|\\\[)/.test(this.source);
    const e = document.createElement(inline ? 'span' : 'div');
    e.className = 'markdown live-rendered-block';
    e.innerHTML = safeMarkdown(this.source);
    if (inline) e.classList.add('live-inline-render');
    e.setAttribute('role', 'button');
    e.setAttribute('aria-label', '编辑' + this.label);
    e.tabIndex = 0;
    const edit = () => {
      if (view.state.readOnly) return;
      view.dispatch({
        selection: { anchor: this.from + Math.min(2, this.source.length) },
        scrollIntoView: true,
      });
      view.focus();
    };
    e.addEventListener('mousedown', (event) => {
      const mouse = event as MouseEvent;
      if (mouse.ctrlKey || mouse.metaKey) return;
      event.preventDefault();
      edit();
    });
    e.addEventListener('keydown', (event) => {
      if ((event as KeyboardEvent).key === 'Enter') {
        event.preventDefault();
        edit();
      }
    });
    return e;
  }
  ignoreEvent() {
    return true;
  }
}

/** Decorations only: the authoritative document remains Markdown, never HTML. */
export function liveDecorations(state: EditorState): DecorationSet {
  const source = state.doc.toString(),
    ranges: Range<Decoration>[] = [],
    hidden: [number, number][] = [];
  const blocked = new Uint8Array(source.length);
  const tree = ensureSyntaxTree(state, state.doc.length, 40) ?? syntaxTree(state);
  tree.iterate({
    enter(node) {
      if (['FencedCode', 'CodeBlock', 'InlineCode'].includes(node.name)) {
        blocked.fill(1, node.from, node.to);
        return false;
      }
    },
  });
  const selected = (from: number, to: number) =>
    state.selection.ranges.some((r) => r.from <= to && r.to >= from);
  const hide = (from: number, to: number, widget?: WidgetType, block = false) => {
    if (from < to) {
      ranges.push(Decoration.replace({ widget, block, atomic: true }).range(from, to));
      hidden.push([from, to]);
    }
  };
  for (let i = 0; i < source.length; i++) {
    if (blocked[i] || (source[i] !== '$' && source[i] !== '\\')) continue;
    const match = mathAt(source, i);
    if (!match || blocked.subarray(i, match.end).includes(1)) continue;
    if (!selected(i, match.end))
      hide(i, match.end, new RenderedBlock(source.slice(i, match.end), i, '公式'), match.display);
    blocked.fill(1, i, match.end);
    i = match.end - 1;
  }
  tree.iterate({
    enter(node) {
      const { from, to, name } = node;
      if (
        hidden.some(([a, b]) => from < b && to > a) ||
        (blocked.subarray(from, to).includes(1) &&
          !['FencedCode', 'CodeBlock', 'InlineCode', 'CodeText', 'CodeMark', 'CodeInfo'].includes(
            name,
          ))
      ) {
        if (blocked[from] && !['Document', 'Paragraph'].includes(name)) return false;
        if (hidden.some(([a, b]) => from >= a && to <= b)) return false;
      }
      if (/^ATXHeading[1-6]$/.test(name)) {
        ranges.push(
          Decoration.line({
            class: 'live-h' + name.at(-1),
            attributes: { role: 'heading', 'aria-level': name.at(-1)! },
          }).range(state.doc.lineAt(from).from),
        );
        const prefix = source.slice(from, to).match(/^#{1,6}[ \t]+/);
        if (prefix) hide(from, from + prefix[0].length);
      } else if (['FencedCode', 'CodeBlock'].includes(name)) {
        for (let n = state.doc.lineAt(from).number; n <= state.doc.lineAt(to).number; n++)
          ranges.push(Decoration.line({ class: 'live-code-line' }).range(state.doc.line(n).from));
        return false;
      } else if (name === 'Table' || name === 'HorizontalRule') {
        if (!selected(from, to)) {
          hide(
            from,
            to,
            new RenderedBlock(source.slice(from, to), from, name === 'Table' ? '表格' : '分隔线'),
            true,
          );
          return false;
        }
      } else if (['StrongEmphasis', 'Emphasis', 'Strikethrough', 'InlineCode'].includes(name)) {
        ranges.push(
          Decoration.mark({
            class:
              name === 'StrongEmphasis'
                ? 'live-bold'
                : name === 'Emphasis'
                  ? 'live-italic'
                  : name === 'Strikethrough'
                    ? 'live-strike'
                    : 'live-inline-code',
          }).range(from, to),
        );
      } else if (['EmphasisMark', 'StrikethroughMark', 'CodeMark'].includes(name)) {
        hide(from, to);
      } else if (name === 'ListMark') {
        const mark = source.slice(from, to);
        hide(
          from,
          to + (source[to] === ' ' ? 1 : 0),
          new Label(/^\d/.test(mark) ? mark + ' ' : '• '),
        );
      } else if (name === 'QuoteMark') {
        ranges.push(
          Decoration.line({ class: 'live-quote-line' }).range(state.doc.lineAt(from).from),
        );
        hide(from, to + (source[to] === ' ' ? 1 : 0));
      } else if (name === 'Link') {
        const raw = source.slice(from, to),
          match = raw.match(/^\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)$/i);
        if (match) {
          hide(from, from + 1);
          hide(from + 1 + match[1].length, to);
          ranges.push(
            Decoration.mark({
              class: 'live-link',
              attributes: { 'data-url': match[2], title: 'Ctrl+单击打开链接' },
            }).range(from + 1, from + 1 + match[1].length),
          );
          return false;
        }
      }
    },
  });
  for (const ref of refs(source)) {
    if (hidden.some(([a, b]) => ref.start < b && ref.end > a)) continue;
    hide(ref.start, ref.start + 2);
    hide(ref.end - 2, ref.end);
    ranges.push(
      Decoration.mark({
        class: 'live-wiki',
        attributes: { 'data-note': encodeURIComponent(ref.key), title: 'Ctrl+单击打开笔记' },
      }).range(ref.start + 2, ref.end - 2),
    );
  }
  return Decoration.set(ranges, true);
}
const display = StateField.define<DecorationSet>({
  create: liveDecorations,
  update(value, tr) {
    return tr.docChanged || tr.selection || syntaxTree(tr.startState) !== syntaxTree(tr.state)
      ? liveDecorations(tr.state)
      : value;
  },
  provide: (field) => [
    EditorView.decorations.from(field),
    EditorView.atomicRanges.of((view) =>
      view.state.field(field).update({ filter: (_a, _b, d) => d.spec.atomic === true }),
    ),
  ],
});
const externalChange = Annotation.define<boolean>();
export type LiveEditorHandle = { focus(): void; insert(a: string, b?: string): void };
export const LiveEditor = forwardRef<
  LiveEditorHandle,
  {
    value: string;
    readOnly: boolean;
    onChange(value: string): void;
    onLink(kind: 'note' | 'url', target: string): void;
  }
>(function LiveEditor(props, ref) {
  const host = useRef<HTMLDivElement>(null),
    view = useRef<EditorView | null>(null),
    latest = useRef(props),
    lastValue = useRef(props.value),
    readOnly = useRef(new Compartment());
  latest.current = props;
  useImperativeHandle(
    ref,
    () => ({
      focus() {
        view.current?.focus();
      },
      insert(a, b = '') {
        const v = view.current;
        if (!v || v.state.readOnly) return;
        const { from, to } = v.state.selection.main;
        v.dispatch({
          changes: { from, to, insert: a + v.state.sliceDoc(from, to) + b },
          selection: EditorSelection.range(from + a.length, to + a.length),
          userEvent: 'input',
        });
        v.focus();
      },
    }),
    [],
  );
  useEffect(() => {
    const v = new EditorView({
      parent: host.current!,
      state: EditorState.create({
        doc: props.value,
        extensions: [
          EditorState.lineSeparator.of(props.value.includes('\r\n') ? '\r\n' : '\n'),
          Prec.highest(
            keymap.of([
              {
                key: 'Enter',
                run(view) {
                  const selection = view.state.selection.main,
                    line = view.state.doc.lineAt(selection.head);
                  const suffix = view.state.sliceDoc(selection.head, line.to);
                  // End-of-line is visually before hidden closing marks. Enter must close formatting first.
                  if (selection.empty && suffix && /^[*_`~]+$/.test(suffix)) {
                    let closing = false;
                    view.state.field(display).between(selection.head, line.to, (from, to, d) => {
                      if (d.spec.atomic && from === selection.head && to <= line.to) closing = true;
                    });
                    if (closing) view.dispatch({ selection: { anchor: line.to } });
                  }
                  return insertNewlineContinueMarkup(view) || insertNewlineAndIndent(view);
                },
              },
            ]),
          ),
          markdown({ base: markdownLanguage, completeHTMLTags: false }),
          history(),
          keymap.of([...historyKeymap, ...defaultKeymap, indentWithTab]),
          EditorView.lineWrapping,
          placeholder('直接开始写作，输入 ## 空格创建二级标题…'),
          display,
          readOnly.current.of([
            EditorState.readOnly.of(props.readOnly),
            EditorView.editable.of(!props.readOnly),
          ]),
          EditorView.contentAttributes.of({ 'aria-label': '即时编辑器', spellcheck: 'false' }),
          EditorView.updateListener.of((update) => {
            if (
              update.docChanged &&
              !update.transactions.some((tr) => tr.annotation(externalChange))
            ) {
              const text = update.state.sliceDoc();
              lastValue.current = text;
              latest.current.onChange(text);
            }
          }),
          EditorView.domEventHandlers({
            click(event) {
              if (!(event.ctrlKey || event.metaKey)) return false;
              const e = (event.target as HTMLElement).closest<HTMLElement>(
                '[data-note],[data-url],a[href]',
              );
              if (!e) return false;
              const note = e.dataset.note,
                url = e.dataset.url || e.getAttribute('href');
              if (note) latest.current.onLink('note', decodeURIComponent(note));
              else if (url && /^https?:\/\//i.test(url)) latest.current.onLink('url', url);
              event.preventDefault();
              return true;
            },
          }),
        ],
      }),
    });
    view.current = v;
    if (!props.readOnly) v.focus();
    return () => {
      view.current = null;
      v.destroy();
    };
  }, []);
  useEffect(() => {
    if (view.current && props.value !== lastValue.current) {
      lastValue.current = props.value;
      view.current.dispatch({
        changes: { from: 0, to: view.current.state.doc.length, insert: props.value },
        annotations: [externalChange.of(true), Transaction.addToHistory.of(false)],
      });
    }
  }, [props.value]);
  useEffect(() => {
    view.current?.dispatch({
      effects: readOnly.current.reconfigure([
        EditorState.readOnly.of(props.readOnly),
        EditorView.editable.of(!props.readOnly),
      ]),
    });
  }, [props.readOnly]);
  return <div ref={host} className="live-editor" />;
});
