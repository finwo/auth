import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SETTINGS = {
  width: 1024,
  height: 576,
  amount: 20,
  density: 1,
  strokeWidth: 0.5,
  baseWidth: 512,
  randomFillOpacity: true,
  light: {
    back: '#FFF',
    front: '#DDD',
  },
  dark: {
    back: '#000',
    front: '#222',
  },
};

const here = path.dirname(fileURLToPath(import.meta.url));
const assets = path.resolve(here, '../../shared/style/assets');

function randomAt(column, row) {
  let value = Math.imul(column + 1000, 374761393) + Math.imul(row + 1000, 668265263);
  value = Math.imul(value ^ (value >>> 13), 1274126177);
  return ((value ^ (value >>> 16)) >>> 0) / 4294967295;
}

function hexPath(cx, cy, radius, halfWidth) {
  const halfHeight = radius / 2;
  const points = [
    [cx, cy - radius],
    [cx + halfWidth, cy - halfHeight],
    [cx + halfWidth, cy + halfHeight],
    [cx, cy + radius],
    [cx - halfWidth, cy + halfHeight],
    [cx - halfWidth, cy - halfHeight],
  ].map(([x, y]) => `${Number(x.toFixed(3))} ${Number(y.toFixed(3))}`);
  return `M ${points[0]} L ${points[1]} L ${points[2]} L ${points[3]} L ${points[4]} L ${points[5]} Z`;
}

function buildSvg({ front, back }) {
  const { width, height, amount, density, strokeWidth, baseWidth } = SETTINGS;
  const spacing = width / amount;
  const radius = (spacing / Math.sqrt(3)) * density;
  const verticalSpacing = 1.5 * radius;
  const stroke = strokeWidth * (width / baseWidth);
  const rows = Math.ceil(height / verticalSpacing) + 1;

  const paths = [];
  for (let row = -1; row <= rows; row += 1) {
    const parity = ((row % 2) + 2) % 2;
    const cy = radius + verticalSpacing * row;
    for (let column = 0; column <= amount; column += 1) {
      const cx = parity * (spacing / 2) + spacing * column;
      const random = randomAt(column, row);
      const opacity = !SETTINGS.randomFillOpacity
        ? 1
        : random >= 0.45
          ? Number((random ** 2).toFixed(2))
          : 0;
      const fill = opacity > 0 ? ` fill="${front}" fill-opacity="${opacity}"` : ' fill="none"';
      paths.push(
        `<path stroke="${front}" stroke-width="${Number(stroke.toFixed(4))}"${fill} d="${hexPath(
          cx,
          cy,
          radius,
          spacing / 2
        )}"/>`
      );
    }
  }

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`,
    `<rect width="100%" height="100%" fill="${back}"/>`,
    ...paths,
    '</svg>',
    '',
  ].join('\n');
}

fs.writeFileSync(path.join(assets, 'hex-grid-light.svg'), buildSvg(SETTINGS.light));
fs.writeFileSync(path.join(assets, 'hex-grid-dark.svg'), buildSvg(SETTINGS.dark));

console.log('wrote hex-grid-light.svg and hex-grid-dark.svg');
