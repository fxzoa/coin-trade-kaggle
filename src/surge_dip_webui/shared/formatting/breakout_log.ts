import { RANGE_WINDOWS } from "../domain/price_range.ts";
import type { SymbolNameResolver } from "../../worker/infrastructure/symbol_name_resolver.ts";
import type { ActiveExtreme } from "../../worker/usecase/price_range_cache.ts";
import type { RangeBreakout } from "../../worker/usecase/range_breakout_detector.ts";

type Direction = ActiveExtreme["direction"];

const TITLE = { high: "最高値更新一覧", low: "最低値更新一覧" } as const;
/** 通貨名の列の位置 (項番の次) */
const NAME_COLUMN = 1;
/** 更新が無い期間のセルに表示する文字 */
const EMPTY_CELL = "-";
/** 色が使えない場合に、今回更新したセルの末尾へ付ける印 */
const MARK = "*";
/** ハイライトの ANSI 装飾 (高値: 緑背景、安値: 黄背景。いずれも太字) */
const STYLE = { high: "\x1b[1;30;42m", low: "\x1b[1;30;43m" } as const;
const RESET = "\x1b[0m";

/** 今回更新したセルを識別するキー (通貨・方向・期間) */
export function highlightKey(symbol: string, direction: Direction, label: string): string {
  return `${symbol}|${direction}|${label}`;
}

/** 更新の検出結果から、今回更新したセルのキーを集める */
export function collectHighlights(
  breakouts: RangeBreakout[],
  into: Set<string> = new Set(),
): Set<string> {
  for (const b of breakouts) {
    for (const label of [b.label, ...b.alsoBroken]) {
      into.add(highlightKey(b.symbol, b.direction, label));
    }
  }
  return into;
}

/** 表のセル。highlight があれば今回更新したセル */
interface Cell {
  text: string;
  highlight?: Direction;
  /** 表示幅のキャッシュ (`cellWidth` が初回に計算する) */
  width?: number;
}

/** 整形の設定 */
export interface FormatOptions {
  /** 今回更新したセルのキー (`highlightKey`)。累計の中から強調する対象 */
  highlighted?: ReadonlySet<string>;
  /** true なら ANSI 色で強調し、false なら末尾に印 (*) を付ける */
  color?: boolean;
  /** 表全体の幅 (桁数)。指定すると列幅を均等に広げて、この幅いっぱいに表示する */
  width?: number;
  /** 銘柄ごとの現在価格。「現在価格」列に表示する (無い銘柄は "-") */
  currentPrices?: ReadonlyMap<string, number>;
  /** 現在時刻 (エポックミリ秒)。指定すると各表の見出しの後ろに JST で表示する */
  now?: number;
}

/** JST (UTC+9) の固定オフセット (ミリ秒)。実行環境のタイムゾーンに依存しないよう手計算する */
const JST_OFFSET_MS = 9 * 60 * 60 * 1000;

/** エポックミリ秒を JST の "YYYY-MM-DD HH:mm:ss JST" に整形する */
export function formatJst(epochMs: number): string {
  const text = new Date(epochMs + JST_OFFSET_MS).toISOString();
  return `${text.slice(0, 10)} ${text.slice(11, 19)} JST`;
}

/** 端末での表示幅。日本語などの全角文字は 2 桁として数える */
function displayWidth(text: string): number {
  // 配列を作らず、コードポイント単位 (サロゲートペアは 1 文字) で数える
  let sum = 0;
  for (const ch of text) sum += ch.codePointAt(0)! >= 0x1100 ? 2 : 1;
  return sum;
}

/** セルの表示幅。列幅の算出と描画で同じセルを 2 回測らないよう、初回の結果を保持する */
function cellWidth(cell: Cell): number {
  return cell.width ??= displayWidth(cell.text);
}

/** 列 index の最大表示幅 (見出しと全行のセルのうち最も広いもの) */
function columnWidth(header: string[], rows: Cell[][], index: number): number {
  let max = displayWidth(header[index]);
  for (const row of rows) {
    const width = cellWidth(row[index]);
    if (width > max) max = width;
  }
  return max;
}

/** 表示幅を基準に空白を詰め、強調があれば文字部分だけを装飾する */
function renderCell(cell: Cell, width: number, align: "left" | "right", color: boolean): string {
  const space = " ".repeat(width - cellWidth(cell));
  const text = cell.highlight && color ? `${STYLE[cell.highlight]}${cell.text}${RESET}` : cell.text;
  return align === "left" ? text + space : space + text;
}

/** 列区切り (" | ") の桁数 */
const SEPARATOR_WIDTH = 3;

/**
 * 列幅を均等に広げて、表全体を totalWidth 桁にする。余りの桁は左の列から1桁ずつ配る。
 * 内容がすでに totalWidth より広い場合は広げない
 */
function stretchWidths(widths: number[], totalWidth: number | undefined): number[] {
  if (totalWidth === undefined) return widths;
  const natural = widths.reduce((a, b) => a + b, 0) + SEPARATOR_WIDTH * (widths.length - 1);
  const extra = totalWidth - natural;
  if (extra <= 0) return widths;
  const each = Math.floor(extra / widths.length);
  const remainder = extra % widths.length;
  return widths.map((w, i) => w + each + (i < remainder ? 1 : 0));
}

/** 行 (通貨) × 列 (期間) の表を、桁を揃えた複数行テキストへ整形する */
function renderTable(
  header: string[],
  rows: Cell[][],
  color: boolean,
  totalWidth?: number,
): string[] {
  const widths = stretchWidths(
    header.map((_, i) => columnWidth(header, rows, i)),
    totalWidth,
  );
  // 通貨名の列は左揃え、項番と価格の列は右揃え
  const render = (cells: Cell[]) =>
    cells.map((c, i) => renderCell(c, widths[i], i === NAME_COLUMN ? "left" : "right", color))
      .join(" | ");
  const separator = widths.map((w) => "-".repeat(w)).join("-+-");
  return [render(header.map((text) => ({ text }))), separator, ...rows.map(render)];
}

/**
 * 更新中の銘柄を、最高値更新一覧と最低値更新一覧の2つの表へ整形する。
 * 先頭に項番を振り、行は通貨、列は期間 (短い順)、セルは更新した価格 (更新していない期間は "-")。
 * 通貨の次の列に、現在価格 (currentPrices) を表示する。
 * now を指定すると、各表の見出しの後ろに現在時刻を JST で表示する。
 * 今回更新したセルと、その行の項番を強調する。
 * width を指定すると、表全体がその桁数いっぱいになるよう列幅を広げる。
 * 他のログと区切るため先頭に改行を入れ、表の間にも空行を入れる。該当が無ければ null
 */
export function formatActiveExtremes(
  extremes: ActiveExtreme[],
  resolveName: SymbolNameResolver,
  options: FormatOptions = {},
): string | null {
  const {
    highlighted = new Set<string>(),
    color = false,
    width,
    currentPrices = new Map<string, number>(),
    now,
  } = options;
  const header = ["項番", "通貨", "現在価格", ...RANGE_WINDOWS.map((w) => w.label)];
  const clock = now === undefined ? "" : `  現在時刻: ${formatJst(now)}`;
  const blocks: string[] = [];
  let anyHighlight = false;

  for (const direction of ["high", "low"] as const) {
    const targets = extremes
      .filter((e) => e.direction === direction)
      // 長い期間まで更新している銘柄を上に、同じなら銘柄名順にする
      .sort((a, b) => b.labels.length - a.labels.length || a.symbol.localeCompare(b.symbol));
    if (targets.length === 0) continue;

    const rows = targets.map((e, index): Cell[] => {
      const isFresh = (label: string) => highlighted.has(highlightKey(e.symbol, direction, label));
      const cells = RANGE_WINDOWS.map(({ label }): Cell => {
        if (!e.labels.includes(label)) return { text: EMPTY_CELL };
        const fresh = isFresh(label);
        anyHighlight ||= fresh;
        return fresh
          ? { text: color ? String(e.price) : `${e.price}${MARK}`, highlight: direction }
          : { text: String(e.price) };
      });
      // 項番は、その行に今回更新したセルがあるときに強調する
      const fresh = cells.some((c) => c.highlight);
      const number = String(index + 1);
      return [
        fresh
          ? { text: color ? number : `${number}${MARK}`, highlight: direction }
          : { text: number },
        { text: resolveName(e.symbol) },
        { text: String(currentPrices.get(e.symbol) ?? EMPTY_CELL) },
        ...cells,
      ];
    });
    blocks.push(
      [
        `[${TITLE[direction]}] 計 ${targets.length} 銘柄${clock}`,
        ...renderTable(header, rows, color, width),
      ]
        .join("\n"),
    );
  }
  if (blocks.length === 0) return null;
  // 色が使えない場合のみ、印の意味を凡例で示す
  const legend = anyHighlight && !color ? `\n\n(${MARK} = 今回更新)` : "";
  return `\n${blocks.join("\n\n")}${legend}`;
}
