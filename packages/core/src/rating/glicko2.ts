// Glicko-2（Mark E. Glickman, "Example of the Glicko-2 system", 2013）
export interface PlayerRating {
  rating: number;
  rd: number;
  volatility: number;
}

const SCALE = 173.7178;
const BASE = 1500;
const EPSILON = 1e-6;

/** ブラウザ間の Math.exp/log の末尾 ulp 差を吸収するため、状態は常に小数第6位で丸める */
export function round6(x: number): number {
  return Math.round(x * 1e6) / 1e6;
}

function rounded(p: PlayerRating): PlayerRating {
  return { rating: round6(p.rating), rd: round6(p.rd), volatility: round6(p.volatility) };
}

const g = (phi: number) => 1 / Math.sqrt(1 + (3 * phi * phi) / (Math.PI * Math.PI));
const expected = (mu: number, muJ: number, phiJ: number) => 1 / (1 + Math.exp(-g(phiJ) * (mu - muJ)));

function newVolatility(sigma: number, phi: number, v: number, delta: number, tau: number): number {
  const a = Math.log(sigma * sigma);
  const f = (x: number) => {
    const ex = Math.exp(x);
    const d = phi * phi + v + ex;
    return (ex * (delta * delta - d)) / (2 * d * d) - (x - a) / (tau * tau);
  };
  let A = a;
  let B: number;
  if (delta * delta > phi * phi + v) {
    B = Math.log(delta * delta - phi * phi - v);
  } else {
    let k = 1;
    while (f(a - k * tau) < 0) k++;
    B = a - k * tau;
  }
  let fA = f(A);
  let fB = f(B);
  while (Math.abs(B - A) > EPSILON) {
    const C = A + ((A - B) * fA) / (fB - fA);
    const fC = f(C);
    if (fC * fB <= 0) {
      A = B;
      fA = fB;
    } else {
      fA /= 2;
    }
    B = C;
    fB = fC;
  }
  return Math.exp(A / 2);
}

export function glicko2Update(
  p: PlayerRating,
  results: { opponent: PlayerRating; score: 0 | 0.5 | 1 }[],
  tau: number,
): PlayerRating {
  const mu = (p.rating - BASE) / SCALE;
  const phi = p.rd / SCALE;
  if (results.length === 0) {
    return rounded({ ...p, rd: Math.sqrt(phi * phi + p.volatility * p.volatility) * SCALE });
  }
  let vInv = 0;
  let sum = 0;
  for (const { opponent, score } of results) {
    const muJ = (opponent.rating - BASE) / SCALE;
    const phiJ = opponent.rd / SCALE;
    const e = expected(mu, muJ, phiJ);
    vInv += g(phiJ) ** 2 * e * (1 - e);
    sum += g(phiJ) * (score - e);
  }
  const v = 1 / vInv;
  const delta = v * sum;
  const sigma = newVolatility(p.volatility, phi, v, delta, tau);
  const phiStar = Math.sqrt(phi * phi + sigma * sigma);
  const phiNew = 1 / Math.sqrt(1 / (phiStar * phiStar) + 1 / v);
  const muNew = mu + phiNew * phiNew * sum;
  return rounded({ rating: muNew * SCALE + BASE, rd: phiNew * SCALE, volatility: sigma });
}

/** 対戦していない期間の分だけ RD を広げる。φ* = sqrt(φ² + σ²·periods) を maxRd で頭打ち */
export function inflateRd(p: PlayerRating, periods: number, maxRd: number): PlayerRating {
  if (periods <= 0) return p;
  const phi = p.rd / SCALE;
  const rd = Math.sqrt(phi * phi + p.volatility * p.volatility * periods) * SCALE;
  return rounded({ ...p, rd: Math.min(rd, maxRd) });
}

export function applyWeight(before: PlayerRating, after: PlayerRating, w: number): PlayerRating {
  const mix = (a: number, b: number) => a + w * (b - a);
  return rounded({
    rating: mix(before.rating, after.rating),
    rd: mix(before.rd, after.rd),
    volatility: mix(before.volatility, after.volatility),
  });
}
