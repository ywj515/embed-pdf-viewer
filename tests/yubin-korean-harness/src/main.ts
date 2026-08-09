import { PdfiumNative } from '../../../packages/engines/dist/index.js';
import { FontCharset, PdfAnnotationSubtype, PdfStandardFont, PdfTextAlignment, PdfVerticalAlignment, uuidV4 } from '../../../packages/models/dist/index.js';
import { init } from '../../../packages/pdfium/dist/index.browser.js';
import wasmUrl from '../../../packages/pdfium/dist/pdfium.wasm?url';
import sourcePdfUrl from '../../../../../tmp/embedpdf-e2e/source.pdf?url';
import ttfUrl from '../../../../../backend/assets/fonts/NotoSansKR-Regular.ttf?url';
import otfUrl from '../../../../../backend/assets/fonts/NotoSansKR-Regular.otf?url';

const KOREAN = '안지오텐신 전환효소 억제제는 혈압을 감소시킨다.';
const RECT = { origin: { x: 72, y: 96 }, size: { width: 440, height: 72 } };

function toBase64(value: Uint8Array | ArrayBuffer): string {
  const bytes = value instanceof Uint8Array ? value : new Uint8Array(value);
  let binary = '';
  const chunk = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunk) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunk));
  }
  return btoa(binary);
}

async function task<T>(value: { toPromise(): Promise<T> }): Promise<T> {
  return value.toPromise();
}

async function imageToPng(image: { data: Uint8ClampedArray; width: number; height: number }): Promise<string> {
  const canvas = document.createElement('canvas');
  canvas.width = image.width;
  canvas.height = image.height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas 2D context unavailable');
  ctx.putImageData(new ImageData(image.data, image.width, image.height), 0, 0);
  const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob((item) => item ? resolve(item) : reject(new Error('PNG encoding failed')), 'image/png'));
  return toBase64(new Uint8Array(await blob.arrayBuffer()));
}

async function sha256Hex(value: ArrayBuffer): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', value));
  return Array.from(digest, byte => byte.toString(16).padStart(2, '0')).join('');
}

type FreeTextFixture = {
  width?: number;
  height?: number;
  fontSize?: number;
  textAlign?: PdfTextAlignment;
  updates?: string[];
  highlightRange?: [number, number];
  expectHighlightUnavailable?: boolean;
};

function annotation(id: string, contents = KOREAN, fixture: FreeTextFixture = {}) {
  return {
    id,
    type: PdfAnnotationSubtype.FREETEXT,
    pageIndex: 0,
    rect: {
      origin: RECT.origin,
      size: { width: fixture.width ?? RECT.size.width, height: fixture.height ?? RECT.size.height },
    },
    contents,
    fontSize: fixture.fontSize ?? 18,
    fontColor: '#18212f',
    // The native writer is selected by the persistent model family, never by
    // inspecting Korean characters in the contents.
    fontFamily: PdfStandardFont.NotoSansKR,
    textAlign: fixture.textAlign ?? PdfTextAlignment.Left,
    verticalAlign: PdfVerticalAlignment.Top,
    // This is the application-specific PDFium writer normalization. It is
    // intentional here and does not alter any other transparent colour field.
    strokeColor: null,
    color: 'transparent',
    backgroundColor: 'transparent',
    strokeWidth: 0,
    opacity: 1,
    flags: ['print'],
  };
}

function linkedHighlightRects(layout: any, freeText: any, range: [number, number]) {
  const selected = layout.characters.filter((character: any) =>
    character.sourceStart < range[1] && character.sourceEnd > range[0],
  );
  if (!selected.length) throw new Error('linked highlight selection has no authoritative committed glyph boxes');
  for (let sourceIndex = range[0]; sourceIndex < range[1]; sourceIndex++) {
    if (!selected.some((character: any) => character.sourceStart <= sourceIndex && character.sourceEnd > sourceIndex)) {
      throw new Error('linked highlight selection includes source text without authoritative committed glyph geometry');
    }
  }
  const groups: any[][] = [];
  for (const character of selected) {
    const previous = groups.at(-1);
    if (!previous || Math.abs(previous[0].box.top - character.box.top) > 0.5) groups.push([character]);
    else previous.push(character);
  }
  return groups.map((group) => {
    const left = Math.min(...group.map((character) => character.box.left));
    const right = Math.max(...group.map((character) => character.box.right));
    const bottom = Math.min(...group.map((character) => character.box.bottom));
    const top = Math.max(...group.map((character) => character.box.top));
    return {
      origin: {
        x: freeText.rect.origin.x + left,
        y: freeText.rect.origin.y + freeText.rect.size.height - top,
      },
      size: { width: right - left, height: top - bottom },
    };
  });
}

async function loadSource(): Promise<ArrayBuffer> {
  const response = await fetch(sourcePdfUrl);
  if (!response.ok) throw new Error(`blank PDF fetch failed: ${response.status}`);
  return response.arrayBuffer();
}

async function createNative(fontUrl: string): Promise<PdfiumNative> {
  const wasmResponse = await fetch(wasmUrl);
  if (!wasmResponse.ok) throw new Error(`PDFium wasm fetch failed: ${wasmResponse.status}`);
  const wasmBinary = await wasmResponse.arrayBuffer();
  const wasm = await init({ wasmBinary });
  const native = new PdfiumNative(wasm, {
    logger: {
      isEnabled: () => true,
      debug: (...args: unknown[]) => console.debug('[native]', ...args),
      info: (...args: unknown[]) => console.info('[native]', ...args),
      warn: (...args: unknown[]) => console.warn('[native]', ...args),
      error: (...args: unknown[]) => console.error('[native]', ...args),
      perf: (...args: unknown[]) => console.debug('[native-perf]', ...args),
    } as any,
    fontFallback: {
      baseUrl: window.location.origin + '/',
      fonts: { [FontCharset.HANGEUL]: [{ url: fontUrl, weight: 400 }] },
    },
  });
  (native as any).__yubinRuntimeIdentity = {
    wasmUrl,
    wasmSha256: await sha256Hex(wasmBinary),
    runtimeId: native.getRuntimeBuildIdentifier?.() ?? null,
  };
  return native;
}

/**
 * Phase 1A/1B use PDFium's supported object APIs directly.  This deliberately
 * bypasses the experimental FreeText AP-import wrapper so we can distinguish a
 * CID-font serialization issue from an annotation-appearance resource issue.
 */
function withWString<T>(pdf: any, value: string, fn: (ptr: number) => T): T {
  const bytes = (value.length + 1) * 2;
  const ptr = pdf.pdfium._malloc(bytes);
  try {
    pdf.pdfium.stringToUTF16(value, ptr, bytes);
    return fn(ptr);
  } finally {
    pdf.pdfium._free(ptr);
  }
}

function withRect<T>(pdf: any, left: number, bottom: number, right: number, top: number, fn: (ptr: number) => T): T {
  const ptr = pdf.pdfium._malloc(16);
  try {
    for (const [offset, value] of [[0, left], [4, bottom], [8, right], [12, top]] as const) {
      pdf.pdfium.setValue(ptr + offset, value, 'float');
    }
    return fn(ptr);
  } finally {
    pdf.pdfium._free(ptr);
  }
}

function saveNativeDocument(pdf: any, docPtr: number): ArrayBuffer {
  const writer = pdf.PDFiumExt_OpenFileWriter();
  try {
    if (!pdf.PDFiumExt_SaveAsCopy(docPtr, writer)) throw new Error('PDFiumExt_SaveAsCopy failed');
    const size = pdf.PDFiumExt_GetFileWriterSize(writer);
    const data = pdf.pdfium._malloc(size);
    try {
      if (pdf.PDFiumExt_GetFileWriterData(writer, data, size) !== size) throw new Error('PDFiumExt_GetFileWriterData failed');
      return pdf.pdfium.HEAPU8.slice(data, data + size).buffer;
    } finally {
      pdf.pdfium._free(data);
    }
  } finally {
    pdf.PDFiumExt_CloseFileWriter(writer);
  }
}

function createKoreanTextObject(pdf: any, docPtr: number, fontPtr: number): number {
  const object = pdf.FPDFPageObj_CreateTextObj(docPtr, fontPtr, 18);
  if (!object) throw new Error('FPDFPageObj_CreateTextObj failed');
  const set = withWString(pdf, KOREAN, (textPtr) => pdf.FPDFText_SetText(object, textPtr));
  if (!set || !pdf.FPDFPageObj_SetFillColor(object, 24, 33, 47, 255)) {
    pdf.FPDFPageObj_Destroy(object);
    throw new Error('could not set Korean page-object text');
  }
  return object;
}

async function directControl(format: 'ttf' | 'otf', kind: 'page' | 'stamp') {
  const fontUrl = format === 'ttf' ? ttfUrl : otfUrl;
  const native = await createNative(fontUrl);
  const pdf: any = (native as any).pdfiumModule;
  const fontBytes = native.getFontFallbackManager()?.loadFontForCharset(FontCharset.HANGEUL);
  if (!fontBytes?.byteLength) throw new Error('self-hosted Hangeul font was not available to direct control');
  const fontBytesPtr = pdf.pdfium._malloc(fontBytes.byteLength);
  let docPtr = 0;
  let pagePtr = 0;
  let fontPtr = 0;
  let rawBytes: ArrayBuffer;
  try {
    docPtr = pdf.FPDF_CreateNewDocument();
    if (!docPtr) throw new Error('FPDF_CreateNewDocument failed');
    pagePtr = pdf.FPDFPage_New(docPtr, 0, 612, 792);
    if (!pagePtr) throw new Error('FPDFPage_New failed');
    pdf.pdfium.HEAPU8.set(fontBytes, fontBytesPtr);
    fontPtr = pdf.FPDFText_LoadFont(docPtr, fontBytesPtr, fontBytes.byteLength, 2, true);
    if (!fontPtr) throw new Error('FPDFText_LoadFont failed');
    const textObject = createKoreanTextObject(pdf, docPtr, fontPtr);
    if (kind === 'page') {
      pdf.FPDFPageObj_Transform(textObject, 1, 0, 0, 1, 72, 700);
      pdf.FPDFPage_InsertObject(pagePtr, textObject);
      if (!pdf.FPDFPage_GenerateContent(pagePtr)) throw new Error('FPDFPage_GenerateContent failed');
    } else {
      pdf.FPDFPageObj_Transform(textObject, 1, 0, 0, 1, 72, 660);
      const annotPtr = pdf.EPDFPage_CreateAnnot(pagePtr, PdfAnnotationSubtype.STAMP);
      if (!annotPtr) {
        pdf.FPDFPageObj_Destroy(textObject);
        throw new Error('EPDFPage_CreateAnnot(STAMP) failed');
      }
      // FPDFAnnot_SetRect takes FS_RECTF in its top/bottom native order; the
      // PDF serializer converts that to the usual lower-left PDF rectangle.
      const rectOk = withRect(pdf, 72, 712, 512, 640, (rectPtr) => pdf.FPDFAnnot_SetRect(annotPtr, rectPtr));
      if (!rectOk || !pdf.FPDFAnnot_AppendObject(annotPtr, textObject)) {
        pdf.FPDFPageObj_Destroy(textObject);
        pdf.FPDFPage_CloseAnnot(annotPtr);
        throw new Error('supported Stamp annotation rejected Korean text object');
      }
      if (!pdf.FPDFAnnot_UpdateObject(annotPtr, textObject)) {
        pdf.FPDFPage_CloseAnnot(annotPtr);
        throw new Error('FPDFAnnot_UpdateObject(STAMP text) failed');
      }
      pdf.FPDFPage_CloseAnnot(annotPtr);
    }
    rawBytes = saveNativeDocument(pdf, docPtr);
  } finally {
    if (fontPtr) pdf.FPDFFont_Close(fontPtr);
    if (pagePtr) pdf.FPDF_ClosePage(pagePtr);
    if (docPtr) pdf.FPDF_CloseDocument(docPtr);
    pdf.pdfium._free(fontBytesPtr);
  }
  await task(native.destroy());

  const freshNative = await createNative(fontUrl);
  let reopened: any;
  try {
    reopened = await task(freshNative.openDocumentBuffer({ id: `yubin-korean-${kind}-reopen-${format}-${uuidV4()}`, content: rawBytes.slice(0) }));
    const rendered = await task(freshNative.renderPageRaw(reopened, reopened.pages[0], { scaleFactor: 2 }));
    return {
      kind,
      format,
      requestedFontUrl: fontUrl,
      runtimeIdentity: (native as any).__yubinRuntimeIdentity,
      rawPdfBase64: toBase64(rawBytes),
      reopened: { rendered: { width: rendered.width, height: rendered.height, pngBase64: await imageToPng(rendered) } },
    };
  } finally {
    if (reopened) await task(freshNative.closeDocument(reopened));
    await task(freshNative.destroy());
  }
}

async function runOne(format: 'ttf' | 'otf', contents = KOREAN, fixture: FreeTextFixture = {}) {
  const fontUrl = format === 'ttf' ? ttfUrl : otfUrl;
  const source = await loadSource();
  const native = await createNative(fontUrl);
  let doc: any;
  let rawBytes: ArrayBuffer;
  let result: any;
  try {
    doc = await task(native.openDocumentBuffer({ id: `yubin-korean-${format}-${uuidV4()}`, content: source.slice(0) }));
    const created = annotation(uuidV4(), contents, fixture);
    const createdId = await task(native.createPageAnnotation(doc, doc.pages[0], created));
    const beforeUpdate = await task(native.getPageAnnotations(doc, doc.pages[0]));
    const found = beforeUpdate.find((item: any) => item.id === createdId);
    if (!found || found.contents !== contents) throw new Error('created FreeText was not readable from the engine model');

    // Repeated updates must reuse the one font handle and replace AP objects.
    const updateTrace: Array<{ index: number; contents: string; fontStats: unknown }> = [];
    const updateContents = fixture.updates?.length ? fixture.updates : Array.from({ length: 8 }, () => contents);
    for (let index = 0; index < updateContents.length; index++) {
      const nextContents = updateContents[index];
      await task(native.updatePageAnnotation(doc, doc.pages[0], {
        ...found, ...created, id: createdId, contents: nextContents,
      }));
      const current = (await task(native.getPageAnnotations(doc, doc.pages[0]))).find((item: any) => item.id === createdId);
      if (!current || current.contents !== nextContents) throw new Error(`FreeText update ${index} did not retain latest contents`);
      updateTrace.push({ index, contents: nextContents, fontStats: native.getEmbeddedKoreanFreeTextFontStats() });
    }
    const expectedContents = updateContents[updateContents.length - 1] ?? contents;
    const afterUpdate = await task(native.getPageAnnotations(doc, doc.pages[0]));
    const committed = afterUpdate.find((item: any) => item.id === createdId);
    if (!committed || committed.contents !== expectedContents) throw new Error('FreeText disappeared after update');
    const layout = native.getEmbeddedKoreanFreeTextLayout(doc.id, createdId);
    let linkedHighlight: any = null;
    if (fixture.highlightRange) {
      if (!layout) throw new Error('linked highlight requires the current committed PDFium layout');
      let segmentRects: any[] | null = null;
      try {
        segmentRects = linkedHighlightRects(layout, committed, fixture.highlightRange);
      } catch (error) {
        if (!fixture.expectHighlightUnavailable) throw error;
        linkedHighlight = { unavailable: true, range: fixture.highlightRange, error: String(error) };
      }
      if (segmentRects) {
        const left = Math.min(...segmentRects.map((rect) => rect.origin.x));
        const top = Math.min(...segmentRects.map((rect) => rect.origin.y));
        const right = Math.max(...segmentRects.map((rect) => rect.origin.x + rect.size.width));
        const bottom = Math.max(...segmentRects.map((rect) => rect.origin.y + rect.size.height));
        const highlight = {
          id: uuidV4(), type: PdfAnnotationSubtype.HIGHLIGHT, pageIndex: 0,
          rect: { origin: { x: left, y: top }, size: { width: right - left, height: bottom - top } },
          contents: `linked:${fixture.highlightRange[0]}:${fixture.highlightRange[1]}`,
          segmentRects, strokeColor: '#fff59d', opacity: 0.45, flags: ['print'],
        };
        const highlightId = await task(native.createPageAnnotation(doc, doc.pages[0], highlight));
        linkedHighlight = { id: highlightId, range: fixture.highlightRange, segmentRects, layoutRevision: `${createdId}:${expectedContents}` };
      }
    }
    const rendered = await task(native.renderPageAnnotationRaw(doc, doc.pages[0], committed, { scaleFactor: 2 }));
    const committedPage = await task(native.renderPageRaw(doc, doc.pages[0], { scaleFactor: 2 }));
    rawBytes = await task(native.saveAsCopy(doc));
    result = {
      format,
      requestedFontUrl: fontUrl,
      runtimeIdentity: (native as any).__yubinRuntimeIdentity,
      createdId,
      annotation: committed,
      createAndUpdateCount: 9,
      updateTrace,
      expectedContents,
      rendered: { width: rendered.width, height: rendered.height, pngBase64: await imageToPng(rendered) },
      committedPage: { width: committedPage.width, height: committedPage.height, pngBase64: await imageToPng(committedPage) },
      layout,
      linkedHighlight,
      rawPdfBase64: toBase64(rawBytes),
      fontStatsBeforeClose: native.getEmbeddedKoreanFreeTextFontStats(),
    };
  } finally {
    if (doc) await task(native.closeDocument(doc));
    if (result) result.fontStatsAfterClose = native.getEmbeddedKoreanFreeTextFontStats();
  }
  return result;
}

async function run(format: 'ttf' | 'otf', contents = KOREAN, fixture: FreeTextFixture = {}) {
  const result = await runOne(format, contents, fixture);
  const source = Uint8Array.from(atob(result.rawPdfBase64), (char) => char.charCodeAt(0)).buffer;
  const freshNative = await createNative(format === 'ttf' ? ttfUrl : otfUrl);
  let reopened: any;
  let finalReopened: any;
  try {
    reopened = await task(freshNative.openDocumentBuffer({ id: `yubin-korean-reopen-${format}-${uuidV4()}`, content: source }));
    const annotations = await task(freshNative.getPageAnnotations(reopened, reopened.pages[0]));
    const committed = annotations.find((item: any) => item.contents === result.expectedContents && item.type === PdfAnnotationSubtype.FREETEXT);
    if (!committed) throw new Error('saved FreeText was absent after reopening in a fresh PDFium instance');
    const reopenedHighlight = result.linkedHighlight?.id
      ? annotations.find((item: any) => item.id === result.linkedHighlight.id)
      : null;
    if (result.linkedHighlight?.id && !reopenedHighlight) throw new Error('saved linked highlight was absent after reopening');
    const rendered = await task(freshNative.renderPageAnnotationRaw(reopened, reopened.pages[0], committed, { scaleFactor: 2 }));
    const rawPage = await task(freshNative.renderPageRaw(reopened, reopened.pages[0], { scaleFactor: 2 }));
    const flattenResult = await task(freshNative.flattenPage(reopened, reopened.pages[0]));
    if (flattenResult !== 1) throw new Error(`PDFium flattenPage failed: ${flattenResult}`);
    const flattenedBytes = await task(freshNative.saveAsCopy(reopened));
    const flattenedPage = await task(freshNative.renderPageRaw(reopened, reopened.pages[0], { scaleFactor: 2 }));
    finalReopened = await task(freshNative.openDocumentBuffer({
      id: `yubin-korean-flattened-reopen-${format}-${uuidV4()}`,
      content: flattenedBytes.slice(0),
    }));
    const finalReopenedPage = await task(freshNative.renderPageRaw(
      finalReopened, finalReopened.pages[0], { scaleFactor: 2 },
    ));
    return {
      ...result,
      reopened: {
        annotation: committed,
        linkedHighlight: reopenedHighlight,
        rendered: { width: rendered.width, height: rendered.height, pngBase64: await imageToPng(rendered) },
        rawPage: { width: rawPage.width, height: rawPage.height, pngBase64: await imageToPng(rawPage) },
        flattenedPage: { width: flattenedPage.width, height: flattenedPage.height, pngBase64: await imageToPng(flattenedPage) },
        finalReopenedPage: { width: finalReopenedPage.width, height: finalReopenedPage.height, pngBase64: await imageToPng(finalReopenedPage) },
        flattenedPdfBase64: toBase64(flattenedBytes),
        fontStats: freshNative.getEmbeddedKoreanFreeTextFontStats(),
      },
    };
  } finally {
    if (finalReopened) await task(freshNative.closeDocument(finalReopened));
    if (reopened) await task(freshNative.closeDocument(reopened));
  }
}

declare global {
  interface Window {
    __yubinKoreanNativeHarness?: (format: 'ttf' | 'otf', contents?: string, fixture?: FreeTextFixture) => Promise<unknown>;
    __yubinKoreanNativeControl?: (format: 'ttf' | 'otf', kind: 'page' | 'stamp') => Promise<unknown>;
  }
}
window.__yubinKoreanNativeHarness = run;
window.__yubinKoreanNativeControl = directControl;
document.querySelector('#status')!.textContent = 'Ready: isolated PDFium Korean native writer harness';
