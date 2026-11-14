// Keep the latest observed price as the center. Estimate each market's typical
// minute move from its recent history using a capped absolute-return average,
// then widen the bands with the forecast horizon. A small horizon-dependent
// allowance on the outer quantiles accounts for occasional persistent jumps.
// The output is bounded, rounded to six decimals, and ordered within each row.
//
// A damped 120-minute signed-return drift, clamped to +/-0.0002 per minute,
// was tested this round. Shifting every quantile by that drift raised practice
// loss from 0.272297 to 0.352103 and h00 loss from 3.539684 to 3.607378
// (coverage fell from 0.721875 to 0.646875), so it was rejected. Moving only
// the median was also rejected: practice loss was 0.298054 despite a small h00
// improvement to 3.530793. On h00 the unchanged model scored 3.539684 versus
// the house persistence baseline's 3.801374; Iran and foreign-actor prices
// drifted below the fixed median and individually lost to baseline, while the
// AI-escape market supplied 60.7% of loss after a 0.195 one-minute drop below
// the entire forecast band. This single FAA checkpoint is diagnostic, not a
// basis for tuning the model.

import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

const LEVELS = [0.05, 0.25, 0.5, 0.75, 0.95];
const NORMAL_SCORES = [-1.644854, -0.67449, 0, 0.67449, 1.644854];
const RETURN_CAP = 0.03;
const TAIL_ALLOWANCE = 0.006;
const RETURN_WINDOW = 960;

function boundedPrice(value) {
  const rounded = Math.round(Math.max(0, Math.min(1, value)) * 1_000_000) / 1_000_000;
  return rounded === 0 ? 0 : rounded;
}

function marketSigma(prices) {
  if (prices.length <= 10) return 0.0025;

  const first = Math.max(1, prices.length - RETURN_WINDOW);
  let total = 0;
  for (let i = first; i < prices.length; i++) {
    total += Math.min(Math.abs(prices[i] - prices[i - 1]), RETURN_CAP);
  }
  return (1.2533 * total) / (prices.length - first);
}

function makeHorizonCurves(length) {
  const widths = new Array(length + 1);
  const tailAdjustments = new Array(length + 1);
  for (let minute = 1; minute <= length; minute++) {
    widths[minute] = minute ** 0.48;
    tailAdjustments[minute] = TAIL_ALLOWANCE * (1 - Math.exp(-minute / 120));
  }
  return { widths, tailAdjustments };
}

function forecastOneMarket(market, horizon, curves) {
  if (market.prices.length === 0) {
    throw new Error(`Market ${market.id} has no observed prices`);
  }

  const center = market.prices[market.prices.length - 1];
  const sigma = marketSigma(market.prices);
  const rows = [];

  for (let minute = 1; minute <= horizon; minute++) {
    const spread = sigma * curves.widths[minute];
    const tail = curves.tailAdjustments[minute];
    const row = NORMAL_SCORES.map((score) => center + score * spread);
    row[0] -= tail;
    row[4] += tail;

    let floor = 0;
    rows.push(row.map((value) => {
      floor = Math.max(floor, boundedPrice(value));
      return floor;
    }));
  }
  return { id: market.id, q: rows };
}

async function run() {
  const inputDir = process.env.MAKEFUN_INPUT_DIR ?? "/input";
  const outputDir = process.env.MAKEFUN_OUTPUT_DIR ?? "/output";
  await mkdir(outputDir, { recursive: true });

  const filenames = (await readdir(inputDir))
    .filter((name) => name.endsWith(".in"))
    .sort();

  for (const filename of filenames) {
    const input = JSON.parse(await readFile(join(inputDir, filename), "utf8"));
    if (
      !Array.isArray(input.quantiles) ||
      input.quantiles.length !== LEVELS.length ||
      !input.quantiles.every((level, index) => level === LEVELS[index])
    ) {
      throw new Error(`Unexpected quantile levels in ${filename}`);
    }

    const curves = makeHorizonCurves(input.horizon_minutes);
    const forecasts = input.markets.map((market) =>
      forecastOneMarket(market, input.horizon_minutes, curves),
    );
    const outputName = `${filename.slice(0, -3)}.out`;
    await writeFile(join(outputDir, outputName), `${JSON.stringify({ forecasts })}\n`);
  }
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
