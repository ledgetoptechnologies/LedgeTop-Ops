import { useEffect, useMemo, useRef } from "react";
import {
  BlockTypeSelect,
  BoldItalicUnderlineToggles,
  CodeToggle,
  CreateLink,
  DiffSourceToggleWrapper,
  InsertCodeBlock,
  InsertTable,
  InsertThematicBreak,
  ListsToggle,
  MDXEditor,
  type MDXEditorMethods,
  Separator,
  UndoRedo,
  codeBlockPlugin,
  codeMirrorPlugin,
  diffSourcePlugin,
  headingsPlugin,
  linkDialogPlugin,
  linkPlugin,
  listsPlugin,
  markdownShortcutPlugin,
  quotePlugin,
  tablePlugin,
  thematicBreakPlugin,
  toolbarPlugin,
} from "@mdxeditor/editor";
import "@mdxeditor/editor/style.css";

export function SopMarkdownEditor({
  value,
  disabled,
  onChange,
  onError,
}: {
  value: string;
  disabled: boolean;
  onChange(markdown: string): void;
  onError(message: string): void;
}) {
  const editor = useRef<MDXEditorMethods>(null);
  const lastEditorValue = useRef(value);
  const plugins = useMemo(() => [
    headingsPlugin(),
    listsPlugin(),
    quotePlugin(),
    thematicBreakPlugin(),
    linkPlugin(),
    linkDialogPlugin(),
    tablePlugin(),
    codeBlockPlugin({ defaultCodeBlockLanguage: "text" }),
    codeMirrorPlugin({ codeBlockLanguages: { text: "Plain text", bash: "Shell", json: "JSON" } }),
    markdownShortcutPlugin(),
    diffSourcePlugin({ viewMode: "rich-text", diffMarkdown: "", readOnlyDiff: true }),
    toolbarPlugin({
      toolbarClassName: "sop-rich-toolbar",
      toolbarContents: () => (
        <DiffSourceToggleWrapper options={["rich-text", "source"]}>
          <UndoRedo />
          <Separator />
          <BlockTypeSelect />
          <BoldItalicUnderlineToggles options={["Bold", "Italic"]} />
          <CodeToggle />
          <Separator />
          <ListsToggle />
          <CreateLink />
          <InsertTable />
          <InsertThematicBreak />
          <InsertCodeBlock />
        </DiffSourceToggleWrapper>
      ),
    }),
  ], []);

  useEffect(() => {
    if (value === lastEditorValue.current) return;
    lastEditorValue.current = value;
    editor.current?.setMarkdown(value);
  }, [value]);

  return <MDXEditor
    ref={editor}
    className="sop-rich-editor"
    contentEditableClassName="sop-rich-editor-content"
    markdown={value}
    plugins={plugins}
    readOnly={disabled}
    spellCheck
    suppressHtmlProcessing
    onError={({ error }) => onError(`The rich-text editor could not parse this Markdown: ${error}`)}
    onChange={(markdown, initialMarkdownNormalize) => {
      lastEditorValue.current = markdown;
      if (!initialMarkdownNormalize) onChange(markdown);
    }}
  />;
}
