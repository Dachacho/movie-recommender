import { useMemo, useState, type CSSProperties } from 'react';
import type { TasteGenre, TasteGraph } from './tasteGraph';

export interface TasteConstellationProps {
  graph: TasteGraph;
  loading: boolean;
  /** Every rating row, including films whose genres could not be resolved. */
  ratedCount: number;
}

const VIEWBOX_WIDTH = 720;
const VIEWBOX_HEIGHT = 440;
const CENTER_X = 360;
const CENTER_Y = 220;
const ORBIT_RADIUS = 150;
const LABEL_RADIUS = 176;
const MIN_NODE_RADIUS = 6;
const MAX_NODE_RADIUS = 16;
const MIN_HIT_RADIUS = 36;
const LIKED_THRESHOLD = 0.25;

type Temperament = 'liked' | 'neutral' | 'disliked';

const LEGEND: readonly { temperament: Temperament; label: string }[] = [
  { temperament: 'liked', label: 'Liked' },
  { temperament: 'neutral', label: 'Neutral' },
  { temperament: 'disliked', label: 'Disliked' },
];

interface PlacedGenre extends TasteGenre {
  x: number;
  y: number;
  angle: number;
  radius: number;
}

interface Readout {
  title: string;
  films: string;
  mean: string;
}

function temperament(affinity: number): Temperament {
  if (affinity > LIKED_THRESHOLD) {
    return 'liked';
  }

  return affinity < -LIKED_THRESHOLD ? 'disliked' : 'neutral';
}

function countLabel(count: number): string {
  return `${count} ${count === 1 ? 'film' : 'films'}`;
}

function formatMean(mean: number): string {
  return mean.toFixed(1);
}

function formatAffinity(affinity: number): string {
  const rounded = Math.abs(affinity) < 0.05 ? 0 : affinity;
  const sign = rounded > 0 ? '+' : '';

  return `${sign}${rounded.toFixed(1)}`;
}

function ratedFilmCountLabel(count: number): string {
  return `${count} rated ${count === 1 ? 'film' : 'films'}`;
}

function statLabel(graph: TasteGraph, ratedCount: number): string {
  const films =
    graph.filmCount === ratedCount
      ? countLabel(graph.filmCount)
      : `${graph.filmCount} of ${ratedFilmCountLabel(ratedCount)}`;
  const mean = graph.filmCount === 0 ? '—' : formatMean(graph.meanRating);
  const parts = [`${films} · mean ${mean}`];

  if (graph.totalGenres > graph.genres.length) {
    parts.push(`top ${graph.genres.length} of ${graph.totalGenres} genres`);
  }

  return parts.join(' · ');
}

function nodeRadius(count: number, minCount: number, maxCount: number): number {
  if (maxCount === minCount) {
    return (MIN_NODE_RADIUS + MAX_NODE_RADIUS) / 2;
  }

  const ratio = (count - minCount) / (maxCount - minCount);

  return MIN_NODE_RADIUS + ratio * (MAX_NODE_RADIUS - MIN_NODE_RADIUS);
}

function edgeWidth(count: number, maxCount: number): number {
  return 0.8 + (count / maxCount) * 2.2;
}

function edgeOpacity(count: number, maxCount: number): number {
  return 0.16 + (count / maxCount) * 0.26;
}

function labelAnchor(angle: number): 'start' | 'middle' | 'end' {
  const cosine = Math.cos(angle);

  if (cosine > 0.3) {
    return 'start';
  }

  return cosine < -0.3 ? 'end' : 'middle';
}

function labelBaseline(angle: number): string {
  const sine = Math.sin(angle);

  if (sine > 0.35) {
    return '1em';
  }

  return sine < -0.35 ? '-0.35em' : '0.35em';
}

function placeGenres(genres: readonly TasteGenre[]): PlacedGenre[] {
  if (genres.length === 0) {
    return [];
  }

  const counts = genres.map((genre) => genre.count);
  const minCount = Math.min(...counts);
  const maxCount = Math.max(...counts);

  return genres.map((genre, index) => {
    const angle = (index / genres.length) * Math.PI * 2 - Math.PI / 2;

    return {
      ...genre,
      angle,
      x: CENTER_X + Math.cos(angle) * ORBIT_RADIUS,
      y: CENTER_Y + Math.sin(angle) * ORBIT_RADIUS,
      radius: nodeRadius(genre.count, minCount, maxCount),
    };
  });
}

function emptyTitle(graph: TasteGraph): string {
  return graph.genres.length === 0
    ? 'Your constellation has no genres yet.'
    : 'The constellation needs another point.';
}

function emptyCopy(graph: TasteGraph): string {
  if (graph.genres.length === 0) {
    return 'Rate a few films and their genres will gather here.';
  }

  const remaining = 3 - graph.filmCount;

  return `Rate ${remaining} more ${remaining === 1 ? 'film' : 'films'} to give the constellation enough points to draw.`;
}

function coverageLabel(graph: TasteGraph, ratedCount: number): string {
  if (ratedCount === 0 || graph.filmCount >= ratedCount) {
    return 'your rated films';
  }

  return `${String(graph.filmCount)} of ${String(ratedCount)} rated films with genres`;
}

/** The graph caps its nodes; both tables intentionally list every genre. */
function genreTableCaption(graph: TasteGraph, ratedCount: number): string {
  const scope = coverageLabel(graph, ratedCount);

  if (graph.totalGenres > graph.genres.length) {
    return `All ${String(graph.totalGenres)} genres from ${scope}; the constellation plots the top ${String(graph.genres.length)}.`;
  }

  return `All genres from ${scope}.`;
}

function edgeTableCaption(graph: TasteGraph, ratedCount: number): string {
  const scope = coverageLabel(graph, ratedCount);

  if (graph.totalGenres > graph.genres.length) {
    return `Co-occurring genres across all ${String(graph.totalGenres)} genres from ${scope}; the constellation draws the pairs among its top ${String(graph.genres.length)} nodes.`;
  }

  return `Co-occurring genres across all genres from ${scope}.`;
}

export function TasteConstellation({ graph, loading, ratedCount }: TasteConstellationProps) {
  const [hovered, setHovered] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const placed = useMemo(() => placeGenres(graph.genres), [graph.genres]);
  const activeName = hovered ?? selected;
  const active = graph.genres.find((genre) => genre.genre === activeName) ?? null;
  const maxEdgeCount = Math.max(0, ...graph.edges.map((edge) => edge.count));
  const nodesByGenre = new Map(placed.map((node) => [node.genre, node]));
  const sparse = graph.genres.length === 0 || graph.filmCount < 3;
  const readout: Readout =
    active === null
      ? {
          title: 'Your taste',
          films: countLabel(graph.filmCount),
          mean: `mean ${formatMean(graph.meanRating)}`,
        }
      : {
          title: active.genre,
          films: countLabel(active.count),
          mean: `${formatMean(active.meanRating)} avg`,
        };

  return (
    <section className="taste-panel" aria-labelledby="dashboard-taste-heading">
      <div className="taste-panel__head">
        <div>
          <h3 className="taste-panel__heading" id="dashboard-taste-heading">
            Taste constellation
          </h3>
          <p className="taste-panel__stat">
            {loading ? 'Reading all rated films…' : statLabel(graph, ratedCount)}
          </p>
        </div>

        <ul className="taste-legend" aria-label="Taste legend">
          {LEGEND.map((item) => (
            <li key={item.temperament}>
              <span
                className={`taste-legend__swatch taste-legend__swatch--${item.temperament}`}
                aria-hidden="true"
              />
              {item.label}
            </li>
          ))}
        </ul>
      </div>

      <div className="taste-panel__scroll">
        <div className="taste-panel__canvas">
          {loading ? (
            <p className="taste-panel__status" role="status">
              Placing your genres…
            </p>
          ) : sparse ? (
            <div className="taste-panel__empty">
              <p className="taste-panel__empty-title">{emptyTitle(graph)}</p>
              <p className="taste-panel__empty-copy">{emptyCopy(graph)}</p>
              <a className="taste-panel__empty-link" href="#library/find">
                Find films to rate
              </a>
            </div>
          ) : (
            <svg
              className="taste-constellation"
              viewBox={`0 0 ${String(VIEWBOX_WIDTH)} ${String(VIEWBOX_HEIGHT)}`}
              aria-hidden="true"
              focusable="false"
              onClick={() => {
                setSelected(null);
              }}
            >
              <rect
                className="taste-constellation__backdrop"
                width={VIEWBOX_WIDTH}
                height={VIEWBOX_HEIGHT}
              />

              <circle
                className="taste-constellation__orbit"
                cx={CENTER_X}
                cy={CENTER_Y}
                r={ORBIT_RADIUS}
              />

              {graph.edges.map((edge) => {
                const from = nodesByGenre.get(edge.a);
                const to = nodesByGenre.get(edge.b);

                if (from === undefined || to === undefined) {
                  return null;
                }

                const incident =
                  active !== null && (active.genre === edge.a || active.genre === edge.b);
                const edgeClass =
                  active === null
                    ? 'taste-edge'
                    : incident
                      ? 'taste-edge taste-edge--active'
                      : 'taste-edge taste-edge--dim';
                const style = {
                  '--edge-width': edgeWidth(edge.count, maxEdgeCount),
                  '--edge-opacity': edgeOpacity(edge.count, maxEdgeCount),
                } as CSSProperties;

                return (
                  <line
                    className={edgeClass}
                    key={`${edge.a}\u0000${edge.b}`}
                    x1={from.x}
                    y1={from.y}
                    x2={to.x}
                    y2={to.y}
                    style={style}
                  />
                );
              })}

              <circle
                className="taste-constellation__readout-disk"
                cx={CENTER_X}
                cy={CENTER_Y}
                r={66}
              />

              <text className="taste-constellation__readout-title" x={CENTER_X} y={CENTER_Y - 10}>
                {readout.title}
              </text>
              <text className="taste-constellation__readout-line" x={CENTER_X} y={CENTER_Y + 14}>
                {readout.films}
              </text>
              <text className="taste-constellation__readout-line" x={CENTER_X} y={CENTER_Y + 32}>
                {readout.mean}
              </text>

              {placed.map((node) => {
                const isActive = active?.genre === node.genre;
                const dimmed = active !== null && !isActive;
                const nodeClass = [
                  'taste-node-group',
                  dimmed ? 'taste-node-group--dim' : '',
                  isActive ? 'taste-node-group--active' : '',
                ]
                  .filter(Boolean)
                  .join(' ');
                const hitRadius = Math.max(node.radius + 8, MIN_HIT_RADIUS);

                return (
                  <g className={nodeClass} key={node.genre}>
                    <circle
                      className={`taste-node taste-node--${temperament(node.affinity)}`}
                      cx={node.x}
                      cy={node.y}
                      r={node.radius}
                    />
                    <circle
                      className="taste-node__hit"
                      cx={node.x}
                      cy={node.y}
                      r={hitRadius}
                      onPointerEnter={() => {
                        setHovered(node.genre);
                      }}
                      onPointerLeave={() => {
                        setHovered(null);
                      }}
                      onClick={(event) => {
                        event.stopPropagation();
                        setSelected((current) => (current === node.genre ? null : node.genre));
                      }}
                    />
                    <text
                      className="taste-node__label"
                      x={CENTER_X + Math.cos(node.angle) * LABEL_RADIUS}
                      y={CENTER_Y + Math.sin(node.angle) * LABEL_RADIUS}
                      textAnchor={labelAnchor(node.angle)}
                      dy={labelBaseline(node.angle)}
                    >
                      {node.genre}
                    </text>
                  </g>
                );
              })}
            </svg>
          )}
        </div>
      </div>

      {!loading && !sparse && (
        <>
          <p className="taste-panel__hint" aria-hidden="true">
            Scroll to explore
          </p>

          <details className="taste-table">
            <summary>Read as a table</summary>
            <div className="taste-table__scroll">
              <table>
                <caption>{genreTableCaption(graph, ratedCount)}</caption>
                <thead>
                  <tr>
                    <th scope="col">Genre</th>
                    <th scope="col">Films</th>
                    <th scope="col">Average</th>
                    <th scope="col">Affinity</th>
                  </tr>
                </thead>
                <tbody>
                  {graph.allGenres.map((genre) => (
                    <tr key={genre.genre}>
                      <th scope="row">{genre.genre}</th>
                      <td>{genre.count}</td>
                      <td>{formatMean(genre.meanRating)}</td>
                      <td>{formatAffinity(genre.affinity)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>

              {graph.edges.length > 0 ? (
                <table>
                  <caption>{edgeTableCaption(graph, ratedCount)}</caption>
                  <thead>
                    <tr>
                      <th scope="col">Genres</th>
                      <th scope="col">Films</th>
                    </tr>
                  </thead>
                  <tbody>
                    {graph.edges.map((edge) => (
                      <tr key={`${edge.a}\u0000${edge.b}`}>
                        <th scope="row">{`${edge.a} + ${edge.b}`}</th>
                        <td>{edge.count}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              ) : (
                <p className="taste-table__empty">No repeated genre pairs yet.</p>
              )}
            </div>
          </details>
        </>
      )}
    </section>
  );
}
