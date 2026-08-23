"use client";

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

export function MarkdownDocumentEditor({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  return (
    <MDXEditor
      markdown={value}
      onChange={(markdown) => onChange(markdown)}
      placeholder="Start writing..."
      contentEditableClassName="markdown-document-content"
      className="markdown-document-editor mdxeditor-full-height"
      plugins={[
        headingsPlugin({ allowedHeadingLevels: [1, 2, 3] }),
        listsPlugin(),
        quotePlugin(),
        linkPlugin(),
        linkDialogPlugin(),
        tablePlugin(),
        thematicBreakPlugin(),
        codeBlockPlugin({ defaultCodeBlockLanguage: "txt" }),
        codeMirrorPlugin({ codeBlockLanguages: { txt: "Plain text", ts: "TypeScript", tsx: "TSX", js: "JavaScript", json: "JSON", bash: "Bash", css: "CSS", html: "HTML", markdown: "Markdown" } }),
        diffSourcePlugin({ viewMode: "rich-text" }),
        markdownShortcutPlugin(),
        toolbarPlugin({
          toolbarContents: () => (
            <DiffSourceToggleWrapper>
              <UndoRedo />
              <Separator />
              <BlockTypeSelect />
              <BoldItalicUnderlineToggles />
              <CodeToggle />
              <CreateLink />
              <ListsToggle />
              <InsertTable />
              <InsertCodeBlock />
              <InsertThematicBreak />
            </DiffSourceToggleWrapper>
          ),
        }),
      ]}
    />
  );
}
