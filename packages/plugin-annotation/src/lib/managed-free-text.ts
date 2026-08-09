/** Quantize a logical Yubin-managed FreeText size in PDF points to 0.5 pt. */
export function quantizeManagedFreeTextFontSize(sizePdfPt: number): number {
  if (!Number.isFinite(sizePdfPt)) return sizePdfPt;
  const quantized = Math.round(sizePdfPt * 2) / 2;
  return Object.is(quantized, -0) ? 0 : quantized;
}
