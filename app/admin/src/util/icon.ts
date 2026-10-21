import m from 'mithril';

type IconNode = ReadonlyArray<readonly [string, Record<string, string | number>]>;

export function icon(nodes: IconNode, attrs: Record<string, unknown> = {}) {
  return m(
    'svg',
    {
      xmlns: 'http://www.w3.org/2000/svg',
      width: 24,
      height: 24,
      viewBox: '0 0 24 24',
      fill: 'none',
      stroke: 'currentColor',
      'stroke-width': 2,
      'stroke-linecap': 'round',
      'stroke-linejoin': 'round',
      'aria-hidden': 'true',
      ...attrs,
    },
    nodes.map(([tag, nodeAttrs]) => m(tag, nodeAttrs))
  );
}
