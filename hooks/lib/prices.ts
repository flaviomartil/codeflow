export interface ModelPrice {
  input: number
  output: number
  cacheRead: number
  write5m: number
  write1h: number
}

export interface PriceTokens {
  input: number
  output: number
  cacheRead: number
  cacheWrite5m: number
  cacheWrite1h: number
}

interface PriceRule {
  prefix: string
  price: ModelPrice
  over?: ModelPrice
}

export const HAIKU_TIER_TOKENS = 100_000

function rate(input: number, output: number, cacheRead: number, write5m: number, write1h: number): ModelPrice {
  return { input, output, cacheRead, write5m, write1h }
}

const FABLE_MYTHOS_2 = rate(8, 40, 0.2, 10, 16)
const FABLE_MYTHOS_1 = rate(10, 50, 0.25, 12.5, 20)
const FABLE_MYTHOS_0 = rate(10, 50, 1, 12.5, 20)

const RULES: PriceRule[] = [
  { prefix: 'claude-fable-5-2', price: FABLE_MYTHOS_2 },
  { prefix: 'claude-mythos-5-2', price: FABLE_MYTHOS_2 },
  { prefix: 'claude-fable-5-1', price: FABLE_MYTHOS_1 },
  { prefix: 'claude-mythos-5-1', price: FABLE_MYTHOS_1 },
  { prefix: 'claude-fable-5', price: FABLE_MYTHOS_0 },
  { prefix: 'claude-mythos-5', price: FABLE_MYTHOS_0 },
  { prefix: 'claude-opus-5-5', price: rate(4, 20, 0.2, 5, 8) },
  { prefix: 'claude-opus-', price: rate(5, 25, 0.5, 6.25, 10) },
  { prefix: 'claude-sonnet-5-5', price: rate(2, 10, 0.1, 2.5, 4) },
  { prefix: 'claude-sonnet-5', price: rate(2, 10, 0.2, 2.5, 4) },
  { prefix: 'claude-sonnet-', price: rate(3, 15, 0.3, 3.75, 6) },
  {
    prefix: 'claude-haiku-5-5',
    price: rate(0.1, 0.5, 0.01, 0.125, 0.2),
    over: rate(0.5, 2.5, 0.05, 0.625, 1),
  },
  { prefix: 'claude-haiku-', price: rate(1, 5, 0.1, 1.25, 2) },
]

const FALLBACK: PriceRule = { prefix: '', price: rate(3, 15, 0.3, 3.75, 6) }

export function priceFor(model: string, promptTokens: number): ModelPrice {
  let best: PriceRule | null = null
  for (const rule of RULES) {
    if (!model.startsWith(rule.prefix)) continue
    if (best === null || rule.prefix.length > best.prefix.length) best = rule
  }
  const rule = best ?? FALLBACK
  return rule.over !== undefined && promptTokens > HAIKU_TIER_TOKENS ? rule.over : rule.price
}

export function costFor(price: ModelPrice, tokens: PriceTokens): number {
  return (
    tokens.input * price.input +
    tokens.output * price.output +
    tokens.cacheRead * price.cacheRead +
    tokens.cacheWrite5m * price.write5m +
    tokens.cacheWrite1h * price.write1h
  ) / 1_000_000
}

export function estimateUsd(model: string, tokens: PriceTokens): number {
  const prompt = tokens.input + tokens.cacheRead + tokens.cacheWrite5m + tokens.cacheWrite1h
  return costFor(priceFor(model, prompt), tokens)
}
