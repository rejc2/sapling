/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import type {Dag, DagCommitInfo} from './dag/dag';
import type {HashSet} from './dag/set';

import {AnimatedReorderGroup} from './AnimatedReorderGroup';
import {AvatarPattern} from './Avatar';
import {InlineBadge} from './InlineBadge';
import {LinkLine, NodeLine, PadLine, Renderer} from './dag/render';
import deepEqual from 'fast-deep-equal';
import React from 'react';

import './RenderDag.css';

/* eslint no-bitwise: 0 */

export type RenderDagProps = {
  /** The dag to use */
  dag: Dag;

  /** If set, render a subset. Otherwise, all commits are rendered. */
  subset?: HashSet;

  /** How to render a commit. */
  renderCommit?: (info: DagCommitInfo) => JSX.Element;

  /**
   * How to render a "glyph" (ex. "o", "x", "@").
   * This should return an SVG element.
   * The SVG viewbox is (-10,-10) to (10,10) (20px * 20px).
   * Default: defaultRenderGlyphSvg, draw a circle.
   */
  renderGlyph?: (info: DagCommitInfo) => RenderGlyphResult;

  /** Should "anonymous" parents (rendered as "~" in CLI) be ignored? */
  ignoreAnonymousParents?: boolean;
} & React.HTMLAttributes<HTMLDivElement>;

/**
 * - 'inside-tile': Inside a <Tile />. Must be a svg element. Size decided by <Tile />.
 * - 'replace-tile': Replace the <Tile /> with the rendered result. Size decided by the
 *   rendered result. Can be other elements not just svg. Useful for "You are here".
 */
type RenderGlyphResult = ['inside-tile', JSX.Element] | ['replace-tile', JSX.Element];

/**
 * Renders a dag. Calculate and render the edges, aka. the left side:
 *
 *   o +--------+
 *   | | commit |
 *   | +--------+
 *   |
 *   | o +--------+
 *   |/  | commit |
 *   o   +--------+
 *   :\
 *   : o +--------+
 *   :   | commit |
 *   :   +--------+
 *   :
 *   o +--------+
 *     | commit |
 *     +--------+
 *
 * The callsite can customize:
 * - What "dag" and what subset of commits to render.
 * - How to render each "commit" (the boxes above).
 * - How to render the glyph (the "o").
 *
 * For a commit with `info.isYouAreHere` set, the "commit" body
 * will be positioned at the right of the "pad" line, not the
 * "node" line, and the default "o" rendering logic will render
 * a blue badge instead.
 *
 * See `DagListProps` for customization options.
 */
export function RenderDag(props: RenderDagProps) {
  const {
    dag,
    subset,
    renderCommit,
    renderGlyph = defaultRenderGlyph,
    className,
    ...restProps
  } = props;

  const renderer = new Renderer();
  const renderedRows: Array<JSX.Element> = [];
  for (const [type, item] of dag.dagWalkerForRendering(subset)) {
    if (type === 'reserve') {
      renderer.reserve(item);
    } else {
      const [info, typedParents] = item;
      const forceLastColumn = info.isYouAreHere;
      const row = renderer.nextRow(info.hash, typedParents, {forceLastColumn});
      // Layout per row:
      //
      //   +-node--+ +-commit--------------+
      //   | o     | | F                   |
      //   +-pad1--+ | very long message 1 |
      //   | │     | |                     |
      //   | │     | | very long message 2 |
      //   +-link--+ | very long message 3 |
      //   | ├─┬─╮ | |                     |
      //   +-term--+ | very long message 4 |
      //   | │ │ │ | |                     |
      //   | │ │ ~ | |                     |
      //   +-pad2--+ |                     |
      //   | │ │   | |                     |
      //   +-------+ +---------------------+
      //
      // - layout done in flexbox.
      // - left side: node, pad1, link, term, pad share a same width.
      // - pad1 has flex-grow (to match tall right-side) and min-height.
      //   pad1 is derived from node line and does not have dashed lines.
      //   (original renderer does not render pad1)
      // - link is optional (decided by renderer).
      // - term is optional (decided by renderer).
      // - pad2 is only drawn if there are dashed lines.
      //
      // Example of "You Are here" special case:
      //
      //              +---+ +-glyph---------------+
      //  node line   | │ | + (You are here )     | (glyph has dynamic size)
      //              +---+ +---------------------+
      //              +---+ +---+  +- commit body -------------------+
      //  pad line    | │ | | │ |  | no longer aligns with node line |
      //              +---+ +---+  +---------------------------------+
      //  other lines ...

      // Also check fbcode/eden/website/src/components/RenderDag.js
      const {linkLine, termLine, nodeLine, topPadLines, padLines, isHead, isRoot} = row;

      // By default, the glyph "o" is rendered in a fixed size "Tile".
      // With 'replace-tile' the glyph can define its own rendered element
      // (of dynamic size).
      //
      // 'replace-tile' also moves the "commit" element to the right of
      // pad line, not node line.
      const [glyphPosition, glyph] = renderGlyph(info);
      const isIrregular = glyphPosition === 'replace-tile';
      // isYouAreHere practically matches isIrregular but we treat them as
      // separate concepts. isYouAreHere affects colors, and isIrregular
      // affects layout.
      const color = info.isYouAreHere ? YOU_ARE_HERE_COLOR : undefined;
      const nodeLinePart = (
        <div className="render-dag-row-left-side-line node-line">
          {nodeLine.map((l, i) => {
            if (isIrregular && l === NodeLine.Node) {
              return <React.Fragment key={i}>{glyph}</React.Fragment>;
            }
            // Need stretchY if "glyph" is not "Tile" and has a dynamic height.
            return (
              <NodeTile
                key={i}
                line={l}
                isHead={isHead}
                isRoot={isRoot}
                aboveNodeColor={info.isHead ? YOU_ARE_HERE_COLOR : undefined}
                stretchY={isIrregular && l != NodeLine.Node}
                scaleY={isIrregular ? 0.5 : 1}
                glyph={glyph}
              />
            );
          })}
        </div>
      );

      const padLine1Part = (
        <div className="render-dag-row-left-side-line pad-line1">
          {topPadLines.map((l, i) => {
            // scaleY decides the min-height. It might be a config option.
            const c = i === row.nodeColumn ? color : undefined;
            return <PadTile key={i} line={l} scaleY={0.5} stretchY={true} color={c} />;
          })}
        </div>
      );

      const linkLinePart = linkLine && (
        <div className="render-dag-row-left-side-line link-line">
          {linkLine.map((l, i) => (
            <LinkTile key={i} line={l} color={color} colorLine={row.linkLineFromNode?.[i]} />
          ))}
        </div>
      );

      const termLinePart = termLine && (
        <>
          <div className="render-dag-row-left-side-line term-line-pad">
            {termLine.map((isTerm, i) => {
              const line = isTerm ? PadLine.Ancestor : padLines.at(i) ?? PadLine.Blank;
              return <PadTile key={i} line={line} />;
            })}
          </div>
          <div className="render-dag-row-left-side-line term-line-term">
            {termLine.map((isTerm, i) => {
              const line = padLines.at(i) ?? PadLine.Blank;
              return isTerm ? <TermTile key={i} /> : <PadTile key={i} line={line} />;
            })}
          </div>
        </>
      );

      const hasAncestorPad = padLines.some(l => l === PadLine.Ancestor);
      const padLine2Part = hasAncestorPad && (
        <div className="render-dag-row-left-side-line pad-line2">
          {padLines.map((l, i) => (
            <PadTile key={i} line={l} color={row.parentColumns.includes(i) ? color : undefined} />
          ))}
        </div>
      );

      const leftSide = (
        <div className="render-dag-row-left-side">
          {!isIrregular && nodeLinePart}
          {padLine1Part}
          {linkLinePart}
          {termLinePart}
          {padLine2Part}
        </div>
      );

      // isIrregular=true      isIrregular=false
      //
      //   2 rows                1 row
      //   +-left---------+      +-left-+-right---+
      //   | node (glyph) |      | node | ...     |
      //   +--------------+      | pad  |         |
      //   +-left-+-right---+    | ...  |         |
      //   | pad  | ...     |    +------+---------+
      //   | ...  |         |
      //   +------+---------+
      if (isIrregular) {
        renderedRows.push(
          <div className="render-dag-row" data-reorder-id={'.'} key={'top:' + info.hash}>
            <div className="render-dag-row-left-side">{nodeLinePart}</div>
          </div>,
        );
      }

      const rightSide = <div className="render-dag-row-right-side">{renderCommit?.(info)}</div>;
      renderedRows.push(
        <div className="render-dag-row" data-reorder-id={info.hash} key={info.hash}>
          {leftSide}
          {rightSide}
        </div>,
      );
    }
  }

  const fullClassName = ((className ?? '') + ' render-dag').trimStart();
  return (
    <div className={fullClassName} {...restProps}>
      <AnimatedReorderGroup animationDuration={100}>{renderedRows}</AnimatedReorderGroup>
    </div>
  );
}

export type TileProps = {
  /** Width. Default: defaultTileWidth. */
  width?: number;
  /** Y scale. Default: 1. Decides height. */
  scaleY?: number;
  /**
   * If true, set:
   * - CSS: height: 100% - take up the height of the (flexbox) parent.
   * - CSS: min-height: width * scaleY, i.e. scaleY affects min-height.
   * - SVG: preserveAspectRatio: 'none'.
   * Intended to be only used by PadLine.
   */
  stretchY?: boolean;
  edges?: Edge[];
  /** SVG children. */
  children?: React.ReactNode;
  /** Line width. Default: strokeWidth. */
  strokeWidth?: number;
};

/**
 * Represent a line within a box (-1,-1) to (1,1).
 * For example, x1=0, y1=-1, x2=0, y2=1 draws a vertical line in the middle.
 * Default x y values are 0.
 * Flag can be used to draw special lines.
 */
export type Edge = {
  x1?: number;
  y1?: number;
  x2?: number;
  y2?: number;
  flag?: number;
  color?: string;
};

export enum EdgeFlag {
  Dash = 1,
  IntersectGap = 2,
}

const defaultTileWidth = 20;
const defaultStrokeWidth = 2;

/**
 * A tile is a rectangle with edges in it.
 * Children are in SVG.
 */
// eslint-disable-next-line prefer-arrow-callback
function TileInner(props: TileProps) {
  const {
    scaleY = 1,
    width = defaultTileWidth,
    edges = [],
    strokeWidth = defaultStrokeWidth,
    stretchY = false,
  } = props;
  const preserveAspectRatio = stretchY || scaleY < 1 ? 'none' : undefined;
  const height = width * scaleY;
  const style = stretchY ? {height: '100%', minHeight: height} : {};
  const paths = edges.map(({x1 = 0, y1 = 0, x2 = 0, y2 = 0, flag = 0, color}, i): JSX.Element => {
    const sY = stretchY ? scaleY * 1.05 : scaleY;
    const strokeDasharray = flag & EdgeFlag.Dash ? '3,2' : undefined;
    let d;
    if (flag & EdgeFlag.IntersectGap) {
      // This vertical line intercects with a horizonal line visually but it does not mean
      // they connect. Leave a small gap in the middle.
      d = `M ${x1} ${y1 * sY} L 0 -2 M 0 2 L ${x2} ${y2 * sY}`;
    } else if (y1 === y2 || x1 === x2) {
      // Straight line (-----).
      d = `M ${x1} ${y1 * sY} L ${x2} ${y2 * sY}`;
    } else {
      // Curved line (towards center).
      d = `M ${x1} ${y1 * sY} Q 0 0 ${x2} ${y2 * sY}`;
    }
    return <path d={d} key={i} strokeDasharray={strokeDasharray} stroke={color} />;
  });
  return (
    <svg
      className="render-dag-tile"
      viewBox={`-10 -${scaleY * 10} 20 ${scaleY * 20}`}
      height={height}
      width={width}
      style={style}
      preserveAspectRatio={preserveAspectRatio}>
      <g stroke="var(--foreground)" fill="none" strokeWidth={strokeWidth}>
        {paths}
        {props.children}
      </g>
    </svg>
  );
}
const Tile = React.memo(TileInner, (prevProps, nextProps) => {
  return (
    prevProps.children == null && nextProps.children == null && deepEqual(prevProps, nextProps)
  );
});

function NodeTile(
  props: {
    line: NodeLine;
    isHead: boolean;
    isRoot: boolean;
    glyph: JSX.Element;
    /** For NodeLine.Node, the color of the vertial edge above the circle. */
    aboveNodeColor?: string;
  } & TileProps,
) {
  const {line, isHead, isRoot, glyph} = props;
  switch (line) {
    case NodeLine.Ancestor:
      return <Tile {...props} edges={[{y1: -10, y2: 10, flag: EdgeFlag.Dash}]} />;
    case NodeLine.Parent:
      // 10.5 is used instead of 10 to avoid small gaps when the page is zoomed.
      return <Tile {...props} edges={[{y1: -10, y2: 10.5}]} />;
    case NodeLine.Node: {
      const edges: Edge[] = [];
      if (!isHead) {
        edges.push({y1: -10.5, color: props.aboveNodeColor});
      }
      if (!isRoot) {
        edges.push({y2: 10.5});
      }
      return (
        <Tile {...props} edges={edges}>
          {glyph}
        </Tile>
      );
    }
    default:
      return <Tile {...props} edges={[]} />;
  }
}

function PadTile(props: {line: PadLine; color?: string} & TileProps) {
  const {line, color} = props;
  switch (line) {
    case PadLine.Ancestor:
      return <Tile {...props} edges={[{y1: -10, y2: 10, flag: EdgeFlag.Dash, color}]} />;
    case PadLine.Parent:
      return <Tile {...props} edges={[{y1: -10, y2: 10, color}]} />;
    default:
      return <Tile {...props} edges={[]} />;
  }
}

function TermTile(props: TileProps) {
  // "~" in svg.
  return (
    <Tile {...props}>
      <path d="M 0 -10 L 0 -5" strokeDasharray="3,2" />
      <path d="M -7 -5 Q -3 -8, 0 -5 T 7 -5" />
    </Tile>
  );
}

function LinkTile(props: {line: LinkLine; color?: string; colorLine?: LinkLine} & TileProps) {
  const edges = linkLineToEdges(props.line, props.color, props.colorLine);
  return <Tile {...props} edges={edges} />;
}

function linkLineToEdges(linkLine: LinkLine, color?: string, colorLine?: LinkLine): Edge[] {
  const bits = linkLine.valueOf();
  const colorBits = colorLine?.valueOf() ?? 0;
  const edges: Edge[] = [];
  const considerEdge = (parentBits: number, ancestorBits: number, edge: Partial<Edge>) => {
    const present = (bits & (parentBits | ancestorBits)) !== 0;
    const useColor = (colorBits & (parentBits | ancestorBits)) !== 0;
    const dashed = (bits & ancestorBits) !== 0;
    if (present) {
      const flag = edge.flag ?? 0 | (dashed ? EdgeFlag.Dash : 0);
      edges.push({...edge, flag, color: useColor ? color : undefined});
    }
  };
  considerEdge(LinkLine.VERT_PARENT, LinkLine.VERT_ANCESTOR, {
    y1: -10,
    y2: 10,
    flag: bits & (LinkLine.HORIZ_PARENT | LinkLine.HORIZ_ANCESTOR) ? EdgeFlag.IntersectGap : 0,
  });
  considerEdge(LinkLine.HORIZ_PARENT, LinkLine.HORIZ_ANCESTOR, {x1: -10, x2: 10});
  considerEdge(LinkLine.LEFT_MERGE_PARENT, LinkLine.LEFT_MERGE_ANCESTOR, {x1: -10, y2: -10});
  considerEdge(LinkLine.RIGHT_MERGE_PARENT, LinkLine.RIGHT_MERGE_ANCESTOR, {x1: 10, y2: -10});
  considerEdge(LinkLine.LEFT_FORK_PARENT, LinkLine.LEFT_FORK_ANCESTOR, {x1: -10, y2: 10});
  considerEdge(LinkLine.RIGHT_FORK_PARENT, LinkLine.RIGHT_FORK_ANCESTOR, {x1: 10, y2: 10});
  return edges;
}

const YOU_ARE_HERE_COLOR = 'var(--button-primary-hover-background)';

export function defaultRenderGlyph(info: DagCommitInfo): RenderGlyphResult {
  if (info.isYouAreHere) {
    // Render info.description in a rounded blue box.
    const outer = (
      <div className="you-are-here-container" style={{marginLeft: -defaultStrokeWidth * 1.5}}>
        <InlineBadge kind="primary">{info.description}</InlineBadge>
      </div>
    );
    return ['replace-tile', outer];
  } else {
    const stroke = info.isHead ? YOU_ARE_HERE_COLOR : 'var(--foreground)';
    const r = (defaultTileWidth * 7) / 20;
    const strokeWidth = defaultStrokeWidth * 0.9;
    let fill = info.successorInfo == null ? 'var(--foreground)' : 'var(--background)';
    let pattern: null | JSX.Element = null;
    // Avatar for draft commits.
    if (info.phase === 'draft' && info.author.length > 0) {
      const id = 'avatar-pattern-' + info.hash.replace(/[^A-Z0-9a-z]/g, '_');
      pattern = <AvatarPattern size={r * 2} username={info.author} id={id} fallbackFill={fill} />;
      fill = `url(#${id})`;
    }
    const rendered = (
      <>
        {pattern}
        <circle cx={0} cy={0} r={r} fill={fill} stroke={stroke} strokeWidth={strokeWidth} />
      </>
    );
    return ['inside-tile', rendered];
  }
}
