import { formatValueState } from '../valueFormat.ts';
import type { TableSubjectFigure, TableSubjectSummary } from './model.ts';

type FigureWriter = (texts: readonly string[]) => void;

export function figureText(figure: TableSubjectFigure): string | null {
  if (figure.pictures?.length) return null;
  const formatted = formatValueState(figure.value);
  return formatted.kind === 'known' || formatted.kind === 'zero' ? formatted.text : null;
}

function figureShape(meta: unknown): { readonly shape: string; readonly texts: readonly string[] } | null {
  const summary = (meta as { readonly subjectSummary?: TableSubjectSummary } | undefined)?.subjectSummary;
  if (!summary) return null;
  const texts: string[] = [];
  const figures = summary.figures.map(figure => {
    const text = figureText(figure);
    if (text === null) return figure;
    texts.push(text);
    return { ...figure, value: 'text' };
  });
  return { shape: JSON.stringify({ ...(meta as object), subjectSummary: { ...summary, figures } }), texts };
}

export class SubjectFigures {
  private readonly shape: string | null;
  private seen: unknown;
  private texts: readonly string[];
  private writer: FigureWriter | null = null;

  constructor(meta: unknown) {
    const split = figureShape(meta);
    this.seen = meta;
    this.shape = split?.shape ?? null;
    this.texts = split?.texts ?? [];
  }

  follow(meta: unknown): boolean {
    if (this.shape === null) return false;
    if (meta === this.seen) return true;
    const split = figureShape(meta);
    if (!split || split.shape !== this.shape) return false;
    this.seen = meta;
    if (split.texts.length === this.texts.length && split.texts.every((text, i) => text === this.texts[i])) return true;
    this.texts = split.texts;
    this.writer?.(split.texts);
    return true;
  }

  attach(writer: FigureWriter): () => void {
    this.writer = writer;
    writer(this.texts);
    return () => { if (this.writer === writer) this.writer = null; };
  }
}
