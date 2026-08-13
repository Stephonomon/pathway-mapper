'use client';

/**
 * The invisible layer.
 *
 * An SVG in PDF page coordinates sitting exactly on top of the rendered page. It
 * contributes nothing until a route exists; then it dims everything off-route,
 * lights the nodes on the route, and traces the arrows between them in order.
 *
 * Also serves as the hit-test surface: every node gets a transparent rect so the
 * page becomes hoverable and clickable without touching the PDF itself.
 */

import type { PathwayEdge, PathwayGraph, PathwayNode } from '@/lib/schema';
import { routeEdgePoints, type Point } from '@/lib/route/orthogonal';

const ACUITY_COLORS: Record<string, string> = {
  low: '#2e7d32',
  intermediate: '#b58900',
  high: '#c62828',
};

const DEFAULT_ROUTE_COLOR = '#1f6feb';

export interface OverlayLayerProps {
  graph: PathwayGraph;
  pageNumber: number;
  /** Node ids on the route, in order. Empty means "show the plain document". */
  routeNodeIds: string[];
  /** Edge ids traversed, in order, parallel to `routeNodeIds.slice(1)`. */
  routeEdgeIds: string[];
  /** Index into `routeNodeIds` of the step being shown. */
  activeIndex: number;
  onSelectNode?: (nodeId: string) => void;
  /** Dim strength for off-route content, 0-1. */
  dim?: number;
  showAllNodes?: boolean;
}

function haloColor(node: PathwayNode): string {
  return (node.acuity && ACUITY_COLORS[node.acuity]) || DEFAULT_ROUTE_COLOR;
}

/**
 * The points a route segment is drawn with. A real traced connector (3+ points
 * with genuine bends) is used verbatim; a straight stub or a geometry-less
 * model-added edge is replaced with a synthesised right-angle route between the
 * boxes, so the highlight follows the document's flowchart style rather than
 * cutting a diagonal across the page.
 */
function edgePoints(edge: PathwayEdge, from: PathwayNode, to: PathwayNode): Point[] {
  return routeEdgePoints(edge.polyline, from.bbox, to.bbox);
}

function toPath(points: Point[]): string {
  return points.map((p, i) => `${i === 0 ? 'M' : 'L'}${p[0]},${p[1]}`).join(' ');
}

export function OverlayLayer({
  graph,
  pageNumber,
  routeNodeIds,
  routeEdgeIds,
  activeIndex,
  onSelectNode,
  dim = 0.72,
  showAllNodes = false,
}: OverlayLayerProps) {
  const page = graph.pages.find((p) => p.number === pageNumber) ?? graph.pages[0];
  if (!page) return null;

  const nodes = new Map(graph.nodes.map((n) => [n.id, n]));
  const edges = new Map(graph.edges.map((e) => [e.id, e]));

  // Only reveal the route up to the step currently being shown, so stepping
  // forward feels like travelling rather than reading a finished map.
  const revealedNodes = routeNodeIds.slice(0, activeIndex + 1);
  const revealedEdges = routeEdgeIds.slice(0, Math.max(0, activeIndex));
  const hasRoute = revealedNodes.length > 0;

  return (
    <svg
      viewBox={`0 0 ${page.width} ${page.height}`}
      className="absolute inset-0 h-full w-full"
      style={{ pointerEvents: 'none' }}
      role="presentation"
    >
      <defs>
        {/* White shows the dim; black punches a hole where the route is. */}
        <mask id="pm-spotlight">
          <rect x="0" y="0" width={page.width} height={page.height} fill="white" />
          {revealedNodes.map((id) => {
            const node = nodes.get(id);
            if (!node) return null;
            const { x, y, w, h } = node.bbox;
            return (
              <rect
                key={id}
                x={x - 2}
                y={y - 2}
                width={w + 4}
                height={h + 4}
                rx="3"
                fill="black"
              />
            );
          })}
        </mask>
      </defs>

      {hasRoute && (
        <rect
          x="0"
          y="0"
          width={page.width}
          height={page.height}
          fill="#0b1622"
          opacity={dim}
          mask="url(#pm-spotlight)"
        />
      )}

      {/* Traced arrows, drawn beneath the halos. */}
      {revealedEdges.map((edgeId, i) => {
        const edge = edges.get(edgeId);
        if (!edge) return null;
        const from = nodes.get(edge.from);
        const to = nodes.get(edge.to);
        if (!from || !to) return null;
        const color = haloColor(to);
        const points = edgePoints(edge, from, to);
        const d = toPath(points);
        // Mark the arrowhead where the drawn line actually ends, so the dot sits
        // on a synthesised path rather than at a stale extracted tip.
        const tip = points[points.length - 1];
        return (
          <g key={edgeId}>
            <path
              d={d}
              fill="none"
              stroke="#ffffff"
              strokeWidth="3.2"
              strokeLinecap="round"
              strokeLinejoin="round"
              opacity="0.9"
            />
            <path
              className="route-trace"
              style={{ animationDelay: `${i * 90}ms` }}
              pathLength={1}
              d={d}
              fill="none"
              stroke={color}
              strokeWidth="1.8"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
            {tip && <circle cx={tip[0]} cy={tip[1]} r="2.2" fill={color} />}
          </g>
        );
      })}

      {/* Halos on route nodes. */}
      {revealedNodes.map((id, i) => {
        const node = nodes.get(id);
        if (!node) return null;
        const { x, y, w, h } = node.bbox;
        const isActive = i === activeIndex;
        return (
          <rect
            key={id}
            className={isActive ? 'route-halo-active' : 'route-halo'}
            x={x - 1.5}
            y={y - 1.5}
            width={w + 3}
            height={h + 3}
            rx="3"
            fill="none"
            stroke={haloColor(node)}
            strokeWidth={isActive ? 2.4 : 1.4}
          />
        );
      })}

      {/* Faint outlines for every extracted node — used by the review view. */}
      {showAllNodes &&
        graph.nodes.map((node) => (
          <rect
            key={`all-${node.id}`}
            x={node.bbox.x}
            y={node.bbox.y}
            width={node.bbox.w}
            height={node.bbox.h}
            rx="2"
            fill="none"
            stroke={node.routable ? '#1f6feb' : '#9aa7b4'}
            strokeWidth="0.5"
            strokeDasharray="2 2"
          />
        ))}

      {/* Hit targets last so they sit on top. */}
      {graph.nodes
        .filter((n) => n.page === pageNumber)
        .map((node) => (
          <rect
            key={`hit-${node.id}`}
            x={node.bbox.x}
            y={node.bbox.y}
            width={node.bbox.w}
            height={node.bbox.h}
            fill="transparent"
            style={{ pointerEvents: onSelectNode ? 'auto' : 'none', cursor: 'pointer' }}
            onClick={() => onSelectNode?.(node.id)}
          >
            <title>{node.text || node.label}</title>
          </rect>
        ))}
    </svg>
  );
}
