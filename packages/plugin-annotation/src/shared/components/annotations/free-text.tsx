import { MouseEvent, useEffect, useRef, suppressContentEditableWarningProps } from '@framework';
import {
  PdfFreeTextAnnoObject,
  PdfVerticalAlignment,
  standardFontCssProperties,
  textAlignmentToCss,
} from '@embedpdf/models';
import { useAnnotationCapability, useIOSZoomPrevention } from '../..';
import { TrackedAnnotation } from '@embedpdf/plugin-annotation';

interface FreeTextProps {
  documentId: string;
  isSelected: boolean;
  isEditing: boolean;
  annotation: TrackedAnnotation<PdfFreeTextAnnoObject>;
  pageIndex: number;
  scale: number;
  onClick?: (e: MouseEvent<HTMLDivElement>) => void;
  onEditEnd?: () => void;
  /** When true, AP canvas provides the visual; hide text content */
  appearanceActive?: boolean;
}

type BrowserFreeTextLine = {
  text: string;
  sourceStart: number;
  sourceEnd: number;
  x: number;
  baselineFromTop: number;
};

type BrowserFreeTextLayout = {
  version: 1;
  sourceText: string;
  rect: { width: number; height: number };
  fontFamily: number;
  fontSize: number;
  textAlign: number;
  verticalAlign: number;
  lineHeight: number;
  lines: BrowserFreeTextLine[];
};

function isManagedFreeText(annotation: PdfFreeTextAnnoObject): boolean {
  return (annotation.custom as any)?.yubin?.managedFreeText === true;
}

/**
 * Capture the exact browser line assignment used by the contenteditable.
 * The PDF writer consumes this contract verbatim; it never wraps text again.
 */
function captureBrowserFreeTextLayout(
  editor: HTMLSpanElement,
  annotation: PdfFreeTextAnnoObject,
  scale: number,
  sourceText = editor.innerText.replace(/\u00a0/g, ' '),
): BrowserFreeTextLayout | null {
  if (!scale || !Number.isFinite(scale)) return null;
  const editorRect = editor.getBoundingClientRect();
  const style = getComputedStyle(editor);
  const lineHeightPx = Number.parseFloat(style.lineHeight);
  if (!editorRect.width || !editorRect.height || !Number.isFinite(lineHeightPx)) return null;

  const canvas = document.createElement('canvas');
  const context = canvas.getContext('2d');
  if (!context) return null;
  context.font = style.font;
  const fontMetrics = context.measureText('Hg가');
  const ascent = fontMetrics.fontBoundingBoxAscent || fontMetrics.actualBoundingBoxAscent;
  const descent = fontMetrics.fontBoundingBoxDescent || fontMetrics.actualBoundingBoxDescent;
  const baselineOffsetPx = Math.max(0, (lineHeightPx - ascent - descent) / 2) + ascent;

  type MeasuredCharacter = {
    text: string;
    sourceStart: number;
    sourceEnd: number;
    left: number;
    top: number;
  };
  const characters: MeasuredCharacter[] = [];
  const walker = document.createTreeWalker(editor, NodeFilter.SHOW_TEXT);
  let sourceCursor = 0;
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const value = node.textContent ?? '';
    for (let offset = 0; offset < value.length;) {
      const codePoint = value.codePointAt(offset);
      if (codePoint === undefined) break;
      const text = String.fromCodePoint(codePoint).replace(/\u00a0/g, ' ');
      const length = codePoint > 0xffff ? 2 : 1;
      let sourceStart = sourceText.indexOf(text, sourceCursor);
      if (sourceStart < 0) {
        offset += length;
        continue;
      }
      sourceCursor = sourceStart + text.length;
      const range = document.createRange();
      range.setStart(node, offset);
      range.setEnd(node, offset + length);
      const rect = range.getBoundingClientRect();
      if (rect.height > 0 && text !== '\r' && text !== '\n') {
        characters.push({
          text,
          sourceStart,
          sourceEnd: sourceStart + text.length,
          left: rect.left,
          top: rect.top,
        });
      }
      offset += length;
    }
  }
  if (sourceText.length && !characters.length) return null;

  const visualLines: Array<{ top: number; characters: MeasuredCharacter[] }> = [];
  for (const character of characters) {
    let line = visualLines.find((candidate) => Math.abs(candidate.top - character.top) <= 0.5);
    if (!line) {
      line = { top: character.top, characters: [] };
      visualLines.push(line);
    }
    line.characters.push(character);
  }
  visualLines.sort((a, b) => a.top - b.top);
  const lines = visualLines.map((line): BrowserFreeTextLine => {
    line.characters.sort((a, b) => a.sourceStart - b.sourceStart);
    const first = line.characters[0];
    const last = line.characters[line.characters.length - 1];
    return {
      text: line.characters.map((character) => character.text).join(''),
      sourceStart: first.sourceStart,
      sourceEnd: last.sourceEnd,
      x: (first.left - editorRect.left) / scale,
      baselineFromTop: (line.top - editorRect.top + baselineOffsetPx) / scale,
    };
  });

  return {
    version: 1,
    sourceText,
    rect: { width: annotation.rect.size.width, height: annotation.rect.size.height },
    fontFamily: annotation.fontFamily,
    fontSize: annotation.fontSize,
    textAlign: annotation.textAlign,
    verticalAlign: annotation.verticalAlign,
    lineHeight: lineHeightPx / scale,
    lines,
  };
}

export function FreeText({
  documentId,
  isSelected,
  isEditing,
  annotation,
  pageIndex,
  scale,
  onClick,
  onEditEnd,
  appearanceActive = false,
}: FreeTextProps) {
  const editorRef = useRef<HTMLSpanElement>(null);
  const editingRef = useRef(false);
  const { provides: annotationCapability } = useAnnotationCapability();
  const annotationProvides = annotationCapability?.forDocument(documentId) ?? null;
  const { adjustedFontPx, wrapperStyle } = useIOSZoomPrevention(
    annotation.object.fontSize * scale,
    isEditing,
  );

  useEffect(() => {
    if (isEditing && editorRef.current) {
      editingRef.current = true;
      const editor = editorRef.current;
      editor.focus();

      const tool = annotationProvides?.findToolForAnnotation(annotation.object);
      const isDefaultContent =
        tool?.defaults?.contents != null && annotation.object.contents === tool.defaults.contents;

      const selection = window.getSelection();
      if (selection) {
        const range = document.createRange();
        range.selectNodeContents(editor);
        if (!isDefaultContent) {
          range.collapse(false);
        }
        selection.removeAllRanges();
        selection.addRange(range);
      }
    }
  }, [isEditing]);

  useEffect(() => {
    if (isEditing || !isManagedFreeText(annotation.object) || !editorRef.current) return;
    let cancelled = false;
    const syncLayout = async () => {
      await document.fonts?.ready;
      if (cancelled || !editorRef.current || !annotationProvides) return;
      const layout = captureBrowserFreeTextLayout(editorRef.current, annotation.object, scale);
      if (!layout) return;
      const current = (annotation.object.custom as any)?.yubin?.freeTextLayout;
      if (JSON.stringify(current) === JSON.stringify(layout)) return;
      annotationProvides.updateAnnotation(pageIndex, annotation.object.id, {
        custom: {
          ...(annotation.object.custom as any),
          yubin: {
            ...((annotation.object.custom as any)?.yubin ?? {}),
            freeTextLayout: layout,
          },
        },
      });
    };
    void syncLayout();
    return () => { cancelled = true; };
  }, [
    isEditing,
    scale,
    annotation.object.contents,
    annotation.object.rect.size.width,
    annotation.object.rect.size.height,
    annotation.object.fontFamily,
    annotation.object.fontSize,
    annotation.object.textAlign,
    annotation.object.verticalAlign,
  ]);

  const handleBlur = () => {
    if (!editingRef.current) return;
    editingRef.current = false;
    if (!annotationProvides) return;
    if (!editorRef.current) return;
    const contents = editorRef.current.innerText.replace(/\u00A0/g, ' ');
    const layout = isManagedFreeText(annotation.object)
      ? captureBrowserFreeTextLayout(editorRef.current, annotation.object, scale, contents)
      : null;
    annotationProvides.updateAnnotation(pageIndex, annotation.object.id, {
      contents,
      ...(layout ? {
        custom: {
          ...(annotation.object.custom as any),
          yubin: {
            ...((annotation.object.custom as any)?.yubin ?? {}),
            freeTextLayout: layout,
          },
        },
      } : {}),
    });
    onEditEnd?.();
  };

  return (
    <div
      data-epdf-annotation-id={annotation.object.id}
      data-epdf-annotation-type="free-text"
      style={{
        position: 'absolute',
        width: annotation.object.rect.size.width * scale,
        height: annotation.object.rect.size.height * scale,
        cursor: isSelected && !isEditing ? 'move' : 'default',
        pointerEvents: !onClick ? 'none' : isSelected && !isEditing ? 'none' : 'auto',
        zIndex: 2,
        opacity: appearanceActive ? 0 : 1,
      }}
      onPointerDown={onClick}
    >
      <span
        ref={editorRef}
        onBlur={handleBlur}
        tabIndex={0}
        style={{
          color: annotation.object.fontColor,
          fontSize: adjustedFontPx,
          ...standardFontCssProperties(annotation.object.fontFamily),
          textAlign: textAlignmentToCss(annotation.object.textAlign),
          flexDirection: 'column',
          justifyContent:
            annotation.object.verticalAlign === PdfVerticalAlignment.Top
              ? 'flex-start'
              : annotation.object.verticalAlign === PdfVerticalAlignment.Middle
                ? 'center'
                : 'flex-end',
          display: 'flex',
          backgroundColor: annotation.object.color ?? annotation.object.backgroundColor,
          opacity: annotation.object.opacity,
          width: '100%',
          height: '100%',
          lineHeight: '1.18',
          overflow: 'hidden',
          cursor: isEditing ? 'text' : onClick ? 'pointer' : 'default',
          outline: 'none',
          ...wrapperStyle,
        }}
        contentEditable={isEditing}
        {...suppressContentEditableWarningProps}
      >
        {annotation.object.contents}
      </span>
    </div>
  );
}
