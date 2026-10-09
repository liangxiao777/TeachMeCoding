import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import CodeMirror from '@uiw/react-codemirror';
import { LanguageDescription, type LanguageSupport } from '@codemirror/language';
import { languages } from '@codemirror/language-data';
import { EditorView, keymap, type ViewUpdate } from '@codemirror/view';
import { cn } from '@/lib/utils';

export type EditorPosition = { start: number; end: number; top: number; left: number };

const basicSetup = {
  foldGutter: false,
  highlightActiveLineGutter: false,
  highlightActiveLine: false,
  highlightSelectionMatches: false,
  autocompletion: false,
  closeBrackets: false,
  allowMultipleSelections: false,
  indentOnInput: false,
  tabSize: 4,
};
const editorTheme = EditorView.theme({
  '&.cm-editor': { backgroundColor: 'var(--ide)', color: 'var(--ide-foreground)', fontSize: '13px' },
  '&.cm-focused': { outline: 'none' },
  '.cm-scroller': { overflow: 'auto', fontFamily: 'var(--font-mono)', lineHeight: '24px' },
  '.cm-content': { padding: '12px 0', minHeight: '100%' },
  '.cm-line': { padding: '0 16px 0 0' },
  '&.cm-editor .cm-gutters': { backgroundColor: 'var(--ide)', color: 'color-mix(in srgb, var(--ide-foreground) 40%, transparent)', border: 'none' },
  '.cm-lineNumbers .cm-gutterElement': { minWidth: '40px', padding: '0 12px 0 16px' },
  '.cm-cursor': { borderLeftColor: 'var(--ide-foreground)' },
}, { dark: true });
const tabKeymap = keymap.of([{ key: 'Tab', run: (view) => {
  view.dispatch({ ...view.state.replaceSelection('    '), scrollIntoView: true, userEvent: 'input' });
  return true;
} }]);

export function CodeEditor({ value, onChange, onSelectText, label, filename, language, className, position, disabled }: {
  value: string;
  onChange: (value: string) => void;
  onSelectText?: (text: string) => void;
  label: string;
  filename?: string;
  language?: string;
  className?: string;
  position?: EditorPosition;
  disabled?: boolean;
}) {
  const initial = useRef(position ? { ...position } : undefined).current;
  const restoring = useRef(!!initial);
  const description = useMemo(() => LanguageDescription.matchFilename(languages, filename ?? '')
    ?? (language ? LanguageDescription.matchLanguageName(languages, language, false) : null), [filename, language]);
  const [support, setSupport] = useState<LanguageSupport | null>(description?.support ?? null);
  useEffect(() => {
    let active = true;
    setSupport(description?.support ?? null);
    description?.load().then((loaded) => { if (active) setSupport(loaded); }).catch(() => { /* Keep editable plain text if loading fails. */ });
    return () => { active = false; };
  }, [description]);
  const extensions = useMemo(() => [editorTheme, tabKeymap, ...(support ? [support] : []),
    EditorView.contentAttributes.of({ 'aria-label': label, 'aria-disabled': String(!!disabled) }),
    EditorView.domEventHandlers({ scroll(_event, view) {
      if (position && !restoring.current) { position.top = view.scrollDOM.scrollTop; position.left = view.scrollDOM.scrollLeft; }
    } }),
  ], [support, label, disabled, position]);
  const onCreateEditor = useCallback((view: EditorView) => {
    if (!initial) return;
    view.requestMeasure({
      read: () => initial,
      write: (saved, current) => {
        current.scrollDOM.scrollTop = saved.top;
        current.scrollDOM.scrollLeft = saved.left;
        restoring.current = false;
      },
    });
  }, [initial]);
  const onUpdate = useCallback((update: ViewUpdate) => {
    if (!update.selectionSet && !update.docChanged) return;
    const { from, to } = update.state.selection.main;
    if (position && !restoring.current) { position.start = from; position.end = to; }
    onSelectText?.(update.state.sliceDoc(from, to));
  }, [position, onSelectText]);
  return <CodeMirror className={cn('min-h-0 min-w-0 overflow-hidden', className)} height="100%"
    value={value} onChange={onChange} onUpdate={onUpdate} onCreateEditor={onCreateEditor}
    selection={initial ? { anchor: Math.min(initial.start, value.length), head: Math.min(initial.end, value.length) } : undefined}
    theme="dark" basicSetup={basicSetup} indentWithTab={false} extensions={extensions} editable={!disabled} readOnly={disabled} />;
}
